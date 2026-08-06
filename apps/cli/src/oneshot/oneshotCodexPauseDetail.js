import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountsRoot } from "@smthrs/accounts";

/**
 * Why codex is paused for oneshot. `oneshotCodexPaused` reduces this to a
 * boolean; callers that report the pause to a human want the marker's own
 * `until`/`reason` and which mechanism paused it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ paused: boolean, pausedBy?: "env" | "marker", until?: string, reason?: string, markerPath?: string }}
 */
export function oneshotCodexPauseDetail(env = process.env) {
  const flag = env.SMITHERS_CODEX_PAUSED?.trim().toLowerCase();
  if (flag) {
    return ["0", "false", "off", "no"].includes(flag) ? { paused: false } : { paused: true, pausedBy: "env" };
  }
  const markerPath = join(accountsRoot(env), "codex-paused.json");
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    const until = typeof marker?.until === "string" ? marker.until : undefined;
    const reason = typeof marker?.reason === "string" ? marker.reason : undefined;
    if (until) {
      const parsed = Date.parse(until);
      if (Number.isFinite(parsed)) {
        return Date.now() < parsed ? { paused: true, pausedBy: "marker", until, reason, markerPath } : { paused: false };
      }
    }
    return { paused: true, pausedBy: "marker", until, reason, markerPath };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return { paused: false };
    return { paused: true, pausedBy: "marker", markerPath };
  }
}
