import { recoverInProgressRewindAudits } from "./recoverInProgressRewindAudits.js";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * Best-effort startup recovery of rewinds interrupted by a prior crash. Call
 * once per run-driving process boot (CLI `up`, served runs). It finds audit rows
 * left in `in_progress`, marks them `partial`, and fails the runs with a
 * `needsAttention` error payload. The durable marker `jumpToFrame` writes
 * before mutating is useless unless something runs this on startup.
 *
 * NEVER throws: startup must not be blocked. Recovery runs on every backend
 * (bun:sqlite, PostgreSQL, PGlite); an adapter with no usable storage layer is a
 * silent no-op. Any unexpected failure is reported via `onError` but swallowed.
 *
 * @param {SmithersDb} adapter
 * @param {{ onRecovered?: (count: number) => void; onError?: (error: unknown) => void; nowMs?: () => number; staleAfterMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function recoverRewindAuditsAtStartup(adapter, options = {}) {
  try {
    const { recovered } = await recoverInProgressRewindAudits(adapter, {
      nowMs: options.nowMs,
      staleAfterMs: options.staleAfterMs,
    });
    if (recovered.length > 0) {
      options.onRecovered?.(recovered.length);
    }
  } catch (error) {
    options.onError?.(error);
  }
}
