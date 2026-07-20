import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Refreshed by every `claude tick`, so an actively mirrored run never expires;
// entries only age out after the session stops following the run.
const SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Record (or refresh) one session's subscription to a run in the registry at
 * `path`. Keyed by (runId, sessionId); expired entries are pruned on the way
 * through. The write is atomic (temp file + rename) but last-write-wins across
 * concurrent processes; a lost upsert is re-asserted by the next tick, so no
 * locking. Never throws: subscriptions are best-effort session state.
 *
 * @param {string} path
 * @param {{ runId: string; sessionId: string | null; nowMs: number }} entry
 * @returns {boolean} whether the registry was written
 */
export function upsertClaudeMirrorSubscription(path, { runId, sessionId, nowMs }) {
    try {
        const existing = readEntries(path);
        const kept = existing.filter((entry) => entry.expiresAtMs > nowMs
            && !(entry.runId === runId && entry.sessionId === sessionId));
        const previous = existing.find((entry) => entry.runId === runId && entry.sessionId === sessionId);
        kept.push({
            runId,
            sessionId,
            subscribedAtMs: previous?.subscribedAtMs ?? nowMs,
            expiresAtMs: nowMs + SUBSCRIPTION_TTL_MS,
        });
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ contract: 1, subscriptions: kept }, null, 2)}\n`);
        renameSync(tmp, path);
        return true;
    }
    catch {
        return false;
    }
}

/** @param {string} path */
function readEntries(path) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return [];
    }
    const entries = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
    return entries.filter((entry) => entry
        && typeof entry === "object"
        && typeof entry.runId === "string"
        && (entry.sessionId === null || typeof entry.sessionId === "string")
        && typeof entry.expiresAtMs === "number");
}
