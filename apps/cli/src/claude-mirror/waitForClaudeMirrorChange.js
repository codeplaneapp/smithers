import { claudeMirrorRelevantEventTypes } from "./claudeMirrorRelevantEventTypes.js";
import { isTerminalClaudeMirrorRunStatus } from "./isTerminalClaudeMirrorRunStatus.js";

const EVENT_PAGE_SIZE = 200;

/**
 * Block until the run emits a mirror-relevant event with seq > afterSeq, the
 * run reaches a terminal status, or the timeout expires. Irrelevant chatter
 * (tool calls, heartbeats, token usage) advances the internal cursor without
 * waking the caller.
 *
 * @param {any} adapter
 * @param {string} runId
 * @param {{ afterSeq?: number; timeoutMs?: number; intervalMs?: number }} [options]
 * @returns {Promise<{ timedOut: boolean }>}
 */
export async function waitForClaudeMirrorChange(adapter, runId, options = {}) {
    let cursor = Math.max(0, Math.floor(options.afterSeq ?? 0));
    const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 420000));
    const intervalMs = Math.max(100, Math.floor(options.intervalMs ?? 750));
    const deadline = Date.now() + timeoutMs;

    while (true) {
        const run = await adapter.getRun(runId);
        if (!run || isTerminalClaudeMirrorRunStatus(run.status)) {
            return { timedOut: false };
        }
        const newestSeq = await adapter.getLastEventSeq(runId);
        if (typeof newestSeq === "number" && newestSeq > cursor) {
            let scanCursor = cursor;
            while (scanCursor < newestSeq) {
                const rows = await adapter.listEventHistory(runId, { afterSeq: scanCursor, limit: EVENT_PAGE_SIZE });
                if (!Array.isArray(rows) || rows.length === 0) {
                    break;
                }
                for (const row of rows) {
                    const seq = Number(row.seq ?? 0);
                    if (seq > scanCursor) {
                        scanCursor = seq;
                    }
                    if (claudeMirrorRelevantEventTypes.has(String(row.type ?? ""))) {
                        return { timedOut: false };
                    }
                }
            }
            cursor = scanCursor;
        }
        if (Date.now() >= deadline) {
            return { timedOut: true };
        }
        await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    }
}

/** @param {number} ms */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
