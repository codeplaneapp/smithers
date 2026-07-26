import { readFileSync } from "node:fs";

/**
 * Read the live entries of the claude-mirror subscription registry. Expired
 * entries are filtered out (not rewritten; writers prune on their next write).
 * A missing, corrupt, or unreadable registry reads as empty: the monitor must
 * degrade to silence, never crash a session over a scratch file.
 *
 * @param {string} path
 * @param {number} nowMs
 * @returns {Array<{ runId: string; sessionId: string | null; subscribedAtMs: number; expiresAtMs: number }>}
 */
export function readClaudeMirrorSubscriptions(path, nowMs) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
  return entries.filter(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.runId === "string" &&
      entry.runId.length > 0 &&
      (entry.sessionId === null || typeof entry.sessionId === "string") &&
      typeof entry.expiresAtMs === "number" &&
      entry.expiresAtMs > nowMs,
  );
}
