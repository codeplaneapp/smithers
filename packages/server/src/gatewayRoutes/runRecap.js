const RUN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
export const CACHE_MAX_ENTRIES = 200;
export const HISTORY_MAX_ENTRIES = 20;
export const HISTORY_MAX_RUNS = 500;
export const MAX_EVENTS = 2000;
const PAGE_LIMIT = 200;
const MAX_CONTEXT_EVENTS = 250;
const MAX_CONTEXT_CHARS = 12000;

export class RunRecapRouteError extends Error {
    constructor(code, message) { super(message); this.name = "RunRecapRouteError"; this.code = code; }
}

const rowType = (row) => String(row?.type ?? "");
const rowSeq = (row) => Number(row?.seq ?? row?.sequence ?? 0);
const payloadOf = (row) => {
    const raw = row?.payloadJson ?? row?.payload_json ?? row?.payload ?? {};
    if (typeof raw !== "string") return raw && typeof raw === "object" ? raw : {};
    try { return JSON.parse(raw); } catch { return {}; }
};
const errorOf = (payload) => {
    const value = payload?.errorJson ?? payload?.error_json ?? payload?.error?.message ?? payload?.errorMessage ?? payload?.message;
    if (typeof value !== "string") return null;
    try { const parsed = JSON.parse(value); return String(parsed?.message ?? parsed?.summary ?? value).slice(0, 400); }
    catch { return value.slice(0, 400); }
};

// Keep this local: server routes must not take a UI package dependency.
export const NOTABLE_RUN_EVENT_TYPES = new Set([
    "RunStarted", "RunFinished", "RunFailed", "RunCancelled", "RunHijacked",
    "NodeFinished", "NodeFailed", "NodeRetrying", "NodeCancelled",
    "ApprovalRequested", "ApprovalGranted", "ApprovalAutoApproved", "ApprovalDenied",
    "HumanRequestCreated", "HumanRequested",
]);

export function notableRunEvents(rows) {
    return (Array.isArray(rows) ? rows : []).filter((row) => {
        const type = rowType(row);
        return NOTABLE_RUN_EVENT_TYPES.has(type)
            || /^(?:Run(?:Started|Finished|Failed|Cancelled|Hijacked)|Node.*(?:Finished|Failed|Retrying|Cancelled)|Human)/.test(type);
    });
}

export function fallbackRecapSummary(events) {
    if (!events.length) return "No notable activity yet.";
    const counts = new Map();
    let failingNode = null;
    let error = null;
    for (const event of events) {
        const type = rowType(event);
        counts.set(type, (counts.get(type) ?? 0) + 1);
        const payload = payloadOf(event);
        if (!failingNode && /Failed|Cancelled/.test(type)) failingNode = payload.nodeId ?? payload.node_id ?? null;
        error ??= errorOf(payload);
    }
    const lines = [`${events.length} notable event${events.length === 1 ? "" : "s"}: ${[...counts].map(([type, count]) => `${type} (${count})`).join(", ")}.`];
    if (failingNode) lines.push(`- failing node: ${failingNode}`);
    if (error) lines.push(`- error: ${error}`);
    return lines.join("\n");
}

function boundedEvents(events) {
    let chars = 0;
    const result = [];
    for (const event of events.slice(0, MAX_CONTEXT_EVENTS)) {
        const encoded = JSON.stringify(event);
        if (chars + encoded.length > MAX_CONTEXT_CHARS) break;
        chars += encoded.length;
        result.push(event);
    }
    return result;
}

/** Watermark-pinned keys safely cache live runs: their event interval cannot change. */
export async function runRecapRoute(params) {
    const runId = typeof params.runId === "string" ? params.runId : "";
    if (!RUN_ID_PATTERN.test(runId)) throw new RunRecapRouteError("InvalidRunId", "runId must match /^[a-z0-9_-]{1,64}$/.");
    if (params.sinceSeq !== undefined && (!Number.isInteger(params.sinceSeq) || params.sinceSeq < 0)) {
        // "InvalidRequest" is the code the versioned contract documents; an
        // undocumented code would fall through statusForRpcError to HTTP 500.
        throw new RunRecapRouteError("InvalidRequest", "sinceSeq must be a non-negative integer.");
    }
    const resolved = await params.resolveRun(runId);
    if (!resolved || !await resolved.adapter.getRun(runId)) throw new RunRecapRouteError("RunNotFound", `Run not found: ${runId}`);
    const adapter = resolved.adapter;
    const historyStore = params.history ?? new Map();
    // Scan progress lives beside — not inside — the recap history: a scan that
    // finds nothing notable must still advance past what it read, or a long
    // non-notable span would be re-read on every request and a notable event
    // behind it would stay unreachable forever. scannedThroughSeq is exclusive
    // (-1 = nothing scanned) so a recap ending at a durable seq 0 event never
    // makes the next scan re-include seq 0.
    const record = historyStore.get(runId) ?? { entries: [], scannedThroughSeq: -1 };
    const startCursor = params.sinceSeq ?? record.scannedThroughSeq;
    const databaseToSeq = (await adapter.getLastEventSeq(runId)) ?? -1;
    const now = typeof params.now === "function" ? params.now() : Date.now();
    const persist = () => {
        // Re-insert so Map order doubles as recency, and evict the stalest run
        // so a long-lived Gateway's recap memory stays bounded across runs.
        historyStore.delete(runId);
        historyStore.set(runId, record);
        if (historyStore.size > HISTORY_MAX_RUNS) historyStore.delete(historyStore.keys().next().value);
    };
    // A replay reports the scan frontier as its toSeq (its summary keeps the
    // historical interval in `history`): pollers compare live event seqs
    // against toSeq, and must stop once the Gateway has looked at those
    // events, notable or not.
    const replay = (entry, frontier) => ({ runId, scope: "run", ...entry, toSeq: Math.max(entry.toSeq, frontier), eventsConsidered: 0, notableEvents: 0, cached: true, history: record.entries });
    const emptyRecap = (frontier, eventsConsidered) => ({ runId, scope: "run", fromSeq: Math.max(0, Math.min(startCursor + 1, frontier)), toSeq: Math.max(0, frontier), eventsConsidered, notableEvents: 0, summary: "No notable activity yet.", agentId: null, source: "facts", cached: true, generatedAtMs: now, history: record.entries });
    if (databaseToSeq <= startCursor) {
        // Nothing beyond the watermark. A sinceSeq past the end of the run
        // clamps here instead of reporting fromSeq greater than toSeq.
        const frontier = Math.max(record.scannedThroughSeq, databaseToSeq);
        return record.entries[0] ? replay(record.entries[0], frontier) : emptyRecap(frontier, 0);
    }

    let cursor = startCursor;
    const rows = [];
    while (rows.length < MAX_EVENTS) {
        const page = await adapter.listEventHistory(runId, { afterSeq: cursor, limit: Math.min(PAGE_LIMIT, MAX_EVENTS - rows.length) });
        if (!page?.length) break;
        // getLastEventSeq is the watermark. A concurrent append can land between
        // that read and this page, so never let a newer row leak into this recap.
        const boundedPage = page.filter((row) => rowSeq(row) <= databaseToSeq);
        rows.push(...boundedPage);
        if (!boundedPage.length || boundedPage.length < page.length) break;
        cursor = rowSeq(boundedPage.at(-1));
        if (page.length < PAGE_LIMIT) break;
    }
    // A capped read advances only to the last row actually read; the unread
    // tail is picked up by the next request instead of being silently skipped.
    // Reading exactly to the watermark is a complete scan, not a truncation.
    const lastReadSeq = rows.length ? rowSeq(rows.at(-1)) : startCursor;
    const truncated = lastReadSeq < databaseToSeq;
    const toSeq = Math.max(0, lastReadSeq);
    if (startCursor <= record.scannedThroughSeq) {
        // A far-future explicit sinceSeq must not advance the shared watermark
        // over events the default flow has not scanned yet.
        record.scannedThroughSeq = Math.max(record.scannedThroughSeq, lastReadSeq);
    }
    const fromSeq = Math.max(0, Math.min(startCursor + 1, toSeq));
    const cache = params.cache ?? new Map();
    const key = `${runId}\0${startCursor}\0${toSeq}`;
    const hit = cache.get(key);
    if (hit) { persist(); return { ...hit, cached: true, history: record.entries }; }
    const events = notableRunEvents(rows);
    if (!events.length) {
        persist();
        return record.entries[0] ? replay(record.entries[0], Math.max(record.scannedThroughSeq, lastReadSeq)) : emptyRecap(toSeq, rows.length);
    }

    let narrated = null;
    try { narrated = await params.summarize?.({ runId, fromSeq, toSeq, events: boundedEvents(events), adapter, truncated }); } catch { /* facts fallback is intentional */ }
    const validSummary = typeof narrated?.summary === "string" && narrated.summary.trim();
    const entry = {
        fromSeq, toSeq,
        summary: validSummary ? narrated.summary.trim() : `${fallbackRecapSummary(events)}${truncated ? "\n- recap is truncated; more events remain." : ""}`,
        agentId: validSummary ? (typeof narrated.agentId === "string" ? narrated.agentId : null) : null,
        source: validSummary && narrated.source !== "facts" ? "agent" : "facts",
        generatedAtMs: now,
    };
    record.entries = [entry, ...record.entries.filter((item) => item.toSeq !== toSeq)].slice(0, HISTORY_MAX_ENTRIES);
    persist();
    const payload = { runId, scope: "run", ...entry, eventsConsidered: rows.length, notableEvents: events.length, cached: false, history: record.entries };
    cache.set(key, payload);
    if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return payload;
}
