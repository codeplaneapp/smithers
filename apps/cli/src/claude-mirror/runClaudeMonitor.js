import { claudeMirrorContract } from "./claudeMirrorContract.js";
import { isTerminalClaudeMirrorRunStatus } from "./isTerminalClaudeMirrorRunStatus.js";
import { readClaudeMirrorSubscriptions } from "./readClaudeMirrorSubscriptions.js";
import { removeClaudeMirrorSubscription } from "./removeClaudeMirrorSubscription.js";

const RUN_SCAN_LIMIT = 50;
const EVENT_PAGE_SIZE = 200;

const NOTABLE_EVENT_KINDS = new Map([
    ["ApprovalRequested", "approval-pending"],
    ["RunFailed", "run-failed"],
    ["RunFinished", "run-finished"],
    ["RunCancelled", "run-cancelled"],
    ["RunContinuedAsNew", "run-continued"],
]);

const TERMINAL_STATUS_KINDS = new Map([
    ["failed", "run-failed"],
    ["finished", "run-finished"],
    ["cancelled", "run-cancelled"],
    ["continued", "run-continued"],
]);

// FYI-only transitions. The store is shared by every session in a workspace,
// so broadcasting these wakes every session for every other session's runs;
// a run this session actually follows already reports completion through its
// /workflows mirror. Suppressed unless `transitions: "all"`.
const FYI_KINDS = new Set(["run-finished", "run-cancelled", "run-continued"]);

/**
 * NDJSON follower behind the Claude Code plugin's background monitor: one line
 * per notable transition, each with the resolving command. By default only
 * actionable transitions stream (approval pending, human request, run failed,
 * stalled heartbeat); pass `transitions: "all"` to also stream the FYI ones
 * (finished, cancelled, continued). History before the monitor started is not
 * replayed; already-pending approvals and human requests are surfaced once at
 * startup.
 *
 * With `subscriptionsPath` set the monitor follows ONLY subscribed runs (the
 * ones this session started or attached a mirror to, recorded by `claude
 * tick`/`claude subscribe`), filtered to `sessionId` (entries with a null
 * sessionId always match, and a monitor without a sessionId matches every
 * entry). The store is shared by every session in a workspace, so scanning
 * all runs would wake each session for every other session's — and every
 * pre-existing — run. Without `subscriptionsPath` it scans all local runs.
 *
 * @param {any} adapter
 * @param {{ intervalMs?: number; stalledAfterMs?: number; ticks?: number; transitions?: "actionable" | "all"; subscriptionsPath?: string; sessionId?: string; write?: (line: string) => void; now?: () => number }} [options]
 */
export async function runClaudeMonitor(adapter, options = {}) {
    const intervalMs = Math.max(250, Math.floor(options.intervalMs ?? 2000));
    const stalledAfterMs = Math.max(5000, Math.floor(options.stalledAfterMs ?? 120000));
    const allTransitions = options.transitions === "all";
    const subscriptionsPath = options.subscriptionsPath;
    const sessionId = options.sessionId;
    const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    const now = options.now ?? Date.now;

    /** @type {Map<string, number>} cursor per run */
    const cursors = new Map();
    /** @type {Set<string>} emitted dedup keys */
    const emitted = new Set();
    /** @type {Set<string>} runs currently flagged stalled */
    const stalledRuns = new Set();
    /** @type {Set<string>} terminal runs that already got their final scan */
    const finalScanned = new Set();

    /** @param {Record<string, unknown>} entry */
    const emit = (entry) => {
        write(JSON.stringify({ contract: claudeMirrorContract, ts: now(), ...entry }));
    };

    /** @param {string} key @param {Record<string, unknown>} entry */
    const emitOnce = (key, entry) => {
        if (emitted.has(key)) {
            return;
        }
        emitted.add(key);
        emit(entry);
    };

    let tick = 0;
    while (options.ticks === undefined || tick < options.ticks) {
        tick += 1;
        const runs = subscriptionsPath === undefined
            ? await Promise.resolve(adapter.listRuns(RUN_SCAN_LIMIT)).catch(() => [])
            : await listSubscribedRuns(adapter, subscriptionsPath, sessionId, now());
        for (const run of runs) {
            const runId = run.runId;
            if (!cursors.has(runId)) {
                // First sight: skip history, but surface anything already waiting.
                const newest = await Promise.resolve(adapter.getLastEventSeq(runId)).catch(() => undefined);
                cursors.set(runId, typeof newest === "number" ? newest : 0);
                if (isTerminalClaudeMirrorRunStatus(run.status)) {
                    // Already over when we first saw it: pure pre-monitor history,
                    // never replayed and never synthesized below.
                    finalScanned.add(runId);
                    if (subscriptionsPath !== undefined) {
                        removeClaudeMirrorSubscription(subscriptionsPath, { runId, nowMs: now() });
                    }
                }
                else {
                    await emitPendingGates(adapter, runId, emitOnce);
                }
                continue;
            }
            const finalScan = isTerminalClaudeMirrorRunStatus(run.status);
            if (finalScan) {
                // One final scan so the RunFinished/RunFailed line is not lost
                // to the race between the status flip and the last event read.
                if (finalScanned.has(runId)) {
                    continue;
                }
                finalScanned.add(runId);
            }
            let cursor = cursors.get(runId) ?? 0;
            let sawTerminalEvent = false;
            // Live runs read one page per tick (the cursor catches up next tick).
            // The final scan of a terminal run must drain every remaining page:
            // a failing run can flush a >EVENT_PAGE_SIZE burst of trailing events
            // in one polling window, hiding the RunFailed row past the first page
            // of the only read this run will ever get again.
            for (;;) {
                const pageStart = cursor;
                const rows = await Promise.resolve(adapter.listEventHistory(runId, { afterSeq: cursor, limit: EVENT_PAGE_SIZE })).catch(() => []);
                for (const row of rows) {
                    const seq = Number(row.seq ?? 0);
                    if (seq > cursor) {
                        cursor = seq;
                    }
                    const type = String(row.type ?? "");
                    const kind = NOTABLE_EVENT_KINDS.get(type);
                    if (!kind) {
                        continue;
                    }
                    const payload = parsePayload(row.payloadJson);
                    if (kind === "approval-pending") {
                        // Dedupe against emitPendingGates (below), which surfaces the
                        // same still-pending gate each tick. Use the identical key so a
                        // gate requested while we are watching a run is announced once,
                        // not twice (event-log line + pending-gates line).
                        const nodeId = typeof payload?.nodeId === "string" ? payload.nodeId : "";
                        const iteration = typeof payload?.iteration === "number" ? payload.iteration : 0;
                        emitOnce(`approval:${runId}:${nodeId}:${iteration}`, buildEventEntry(kind, runId, payload));
                        continue;
                    }
                    sawTerminalEvent = true;
                    if (!allTransitions && FYI_KINDS.has(kind)) {
                        continue;
                    }
                    emit(buildEventEntry(kind, runId, payload));
                }
                if (!finalScan || rows.length < EVENT_PAGE_SIZE || cursor <= pageStart) {
                    break;
                }
            }
            cursors.set(runId, cursor);
            if (finalScan && !sawTerminalEvent) {
                // The engine commits the terminal run status BEFORE it persists the
                // RunFailed/RunFinished event row, so this one-shot final scan can
                // land inside that gap (or the event read can fail) and the line
                // would be lost forever. Synthesize it from the status we watched
                // flip; the event log is never read again for this run.
                const kind = TERMINAL_STATUS_KINDS.get(String(run.status ?? ""));
                if (kind && (allTransitions || !FYI_KINDS.has(kind))) {
                    emit(buildEventEntry(kind, runId, undefined));
                }
            }
            if (finalScan && subscriptionsPath !== undefined) {
                // Terminal is terminal for every session; drop the run from the
                // registry so no future monitor re-inspects it.
                removeClaudeMirrorSubscription(subscriptionsPath, { runId, nowMs: now() });
            }
            await emitPendingGates(adapter, runId, emitOnce);
            trackStall(run, stalledAfterMs, stalledRuns, emit, now);
        }
        if (options.ticks !== undefined && tick >= options.ticks) {
            break;
        }
        await sleep(intervalMs);
    }
}

/**
 * Resolve the subscribed runs this monitor follows: registry entries for this
 * session (or with no session), deduped by run id, looked up individually.
 * Runs missing from the store (a registry pointing at a wiped DB) drop out.
 *
 * @param {any} adapter
 * @param {string} subscriptionsPath
 * @param {string | undefined} sessionId
 * @param {number} nowMs
 */
async function listSubscribedRuns(adapter, subscriptionsPath, sessionId, nowMs) {
    const entries = readClaudeMirrorSubscriptions(subscriptionsPath, nowMs);
    const watched = entries.filter((entry) => sessionId === undefined
        || entry.sessionId === null
        || entry.sessionId === sessionId);
    const runIds = [...new Set(watched.map((entry) => entry.runId))];
    const runs = await Promise.all(runIds.map((runId) => Promise.resolve(adapter.getRun(runId)).catch(() => undefined)));
    return runs.filter((run) => run && typeof run.runId === "string");
}

/**
 * @param {any} adapter
 * @param {string} runId
 * @param {(key: string, entry: Record<string, unknown>) => void} emitOnce
 */
async function emitPendingGates(adapter, runId, emitOnce) {
    const approvals = await Promise.resolve(adapter.listPendingApprovals(runId)).catch(() => []);
    for (const approval of approvals) {
        emitOnce(`approval:${runId}:${approval.nodeId}:${approval.iteration ?? 0}`, {
            kind: "approval-pending",
            runId,
            nodeId: approval.nodeId,
            title: approvalTitle(approval.requestJson),
            summary: `Run ${runId} is waiting on approval for node ${approval.nodeId}.`,
            action: `Resolve with the resolve_approval MCP tool or: smithers approve ${runId} ${approval.nodeId}`,
        });
    }
    const humans = await Promise.resolve(adapter.listPendingHumanRequests()).catch(() => []);
    for (const request of humans) {
        if (request.runId !== runId) {
            continue;
        }
        emitOnce(`human:${request.requestId}`, {
            kind: "human-request",
            runId,
            nodeId: request.nodeId,
            requestId: request.requestId,
            summary: `Run ${runId} is waiting on a human answer for node ${request.nodeId}.`,
            action: "Answer via the ask_human follow-up in chat, or: smithers inspect " + runId,
        });
    }
}

/**
 * @param {string} kind
 * @param {string} runId
 * @param {Record<string, any> | undefined} payload
 */
function buildEventEntry(kind, runId, payload) {
    if (kind === "run-continued") {
        const newRunId = typeof payload?.newRunId === "string" ? payload.newRunId : undefined;
        return {
            kind,
            runId,
            ...(newRunId ? { newRunId } : {}),
            summary: `Run ${runId} continued as ${newRunId ?? "a new run"}.`,
            action: newRunId ? `Follow it with: smithers claude tick ${newRunId}` : `Inspect with: smithers inspect ${runId}`,
        };
    }
    if (kind === "run-failed") {
        return {
            kind,
            runId,
            summary: `Run ${runId} failed.`,
            action: `Diagnose with: smithers inspect ${runId} (logs: smithers logs ${runId})`,
        };
    }
    if (kind === "approval-pending") {
        const nodeId = typeof payload?.nodeId === "string" ? payload.nodeId : undefined;
        return {
            kind,
            runId,
            ...(nodeId ? { nodeId } : {}),
            summary: `Run ${runId} is waiting on approval${nodeId ? ` for node ${nodeId}` : ""}.`,
            action: `Resolve with the resolve_approval MCP tool or: smithers approve ${runId}${nodeId ? ` ${nodeId}` : ""}`,
        };
    }
    return {
        kind,
        runId,
        summary: `Run ${runId} ${kind === "run-finished" ? "finished" : "was cancelled"}.`,
        action: `Review with: smithers inspect ${runId}`,
    };
}

/**
 * @param {any} run
 * @param {number} stalledAfterMs
 * @param {Set<string>} stalledRuns
 * @param {(entry: Record<string, unknown>) => void} emit
 * @param {() => number} now
 */
function trackStall(run, stalledAfterMs, stalledRuns, emit, now) {
    const runId = run.runId;
    const heartbeat = typeof run.heartbeatAtMs === "number" ? run.heartbeatAtMs : undefined;
    const isStalled = run.status === "running" && heartbeat !== undefined && now() - heartbeat > stalledAfterMs;
    if (isStalled && !stalledRuns.has(runId)) {
        stalledRuns.add(runId);
        emit({
            kind: "run-stalled",
            runId,
            summary: `Run ${runId} has not heartbeaten for over ${Math.round(stalledAfterMs / 1000)}s.`,
            action: `Check it with: smithers why ${runId} (resume with: smithers up --resume ${runId})`,
        });
    }
    else if (!isStalled && stalledRuns.has(runId)) {
        stalledRuns.delete(runId);
    }
}

/** @param {unknown} payloadJson */
function parsePayload(payloadJson) {
    if (typeof payloadJson !== "string" || payloadJson.length === 0) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(payloadJson);
        return parsed && typeof parsed === "object" ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}

/** @param {unknown} requestJson */
function approvalTitle(requestJson) {
    if (typeof requestJson !== "string" || requestJson.length === 0) {
        return null;
    }
    try {
        const parsed = JSON.parse(requestJson);
        const title = parsed?.title ?? parsed?.prompt ?? parsed?.description;
        return typeof title === "string" && title.length > 0 ? title : null;
    }
    catch {
        return null;
    }
}

/** @param {number} ms */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
