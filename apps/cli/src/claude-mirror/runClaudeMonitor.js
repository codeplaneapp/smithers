import { claudeMirrorContract } from "./claudeMirrorContract.js";
import { isTerminalClaudeMirrorRunStatus } from "./isTerminalClaudeMirrorRunStatus.js";

const RUN_SCAN_LIMIT = 50;
const EVENT_PAGE_SIZE = 200;

const NOTABLE_EVENT_KINDS = new Map([
    ["ApprovalRequested", "approval-pending"],
    ["RunFailed", "run-failed"],
    ["RunFinished", "run-finished"],
    ["RunCancelled", "run-cancelled"],
    ["RunContinuedAsNew", "run-continued"],
]);

/**
 * NDJSON follower behind the Claude Code plugin's background monitor: one line
 * per notable transition across local runs (approval pending, human request,
 * run finished/failed/cancelled/continued, stalled heartbeat), each with the
 * resolving command. History before the monitor started is not replayed;
 * already-pending approvals and human requests are surfaced once at startup.
 *
 * @param {any} adapter
 * @param {{ intervalMs?: number; stalledAfterMs?: number; ticks?: number; write?: (line: string) => void; now?: () => number }} [options]
 */
export async function runClaudeMonitor(adapter, options = {}) {
    const intervalMs = Math.max(250, Math.floor(options.intervalMs ?? 2000));
    const stalledAfterMs = Math.max(5000, Math.floor(options.stalledAfterMs ?? 120000));
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
        const runs = await Promise.resolve(adapter.listRuns(RUN_SCAN_LIMIT)).catch(() => []);
        for (const run of runs) {
            const runId = run.runId;
            if (!cursors.has(runId)) {
                // First sight: skip history, but surface anything already waiting.
                const newest = await Promise.resolve(adapter.getLastEventSeq(runId)).catch(() => undefined);
                cursors.set(runId, typeof newest === "number" ? newest : 0);
                if (!isTerminalClaudeMirrorRunStatus(run.status)) {
                    await emitPendingGates(adapter, runId, emitOnce);
                }
                continue;
            }
            if (isTerminalClaudeMirrorRunStatus(run.status)) {
                // One final scan so the RunFinished/RunFailed line is not lost
                // to the race between the status flip and the last event read.
                if (finalScanned.has(runId)) {
                    continue;
                }
                finalScanned.add(runId);
            }
            let cursor = cursors.get(runId) ?? 0;
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
                emit(buildEventEntry(kind, runId, payload));
            }
            cursors.set(runId, cursor);
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
            action: `Diagnose with: smithers autopsy ${runId}`,
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
            action: `Check it with: smithers explain ${runId} (resume with: smithers up --resume ${runId})`,
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
