import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Drop a run from the subscription registry at `path`. With a `sessionId`
 * (string or null) only that session's entry goes; leaving it undefined drops
 * the run for every session — used when a run turns terminal, which is
 * terminal for everyone. Expired entries are pruned on the way through.
 * Atomic write, last-write-wins, never throws (see upsert for the rationale).
 *
 * @param {string} path
 * @param {{ runId: string; sessionId?: string | null; nowMs?: number }} target
 * @returns {boolean} whether the registry was written
 */
export function removeClaudeMirrorSubscription(path, { runId, sessionId, nowMs = Date.now() }) {
  try {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
    const entries = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
    const kept = entries.filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.runId === "string" &&
        typeof entry.expiresAtMs === "number" &&
        entry.expiresAtMs > nowMs &&
        !(entry.runId === runId && (sessionId === undefined || entry.sessionId === sessionId)),
    );
    if (kept.length === entries.length) {
      return false;
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ contract: 1, subscriptions: kept }, null, 2)}\n`);
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}
