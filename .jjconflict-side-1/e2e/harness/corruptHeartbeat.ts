import type { Database } from "bun:sqlite";

export type CorruptHeartbeatMode = "stale" | "missing" | "future";

const STALE_THRESHOLD_MS = 30_000;

export async function corruptHeartbeat(
  db: Database,
  runId: string,
  mode: CorruptHeartbeatMode,
): Promise<void> {
  const now = Date.now();
  let heartbeatAtMs: number | null;

  if (mode === "stale") {
    heartbeatAtMs = now - 10 * STALE_THRESHOLD_MS;
  } else if (mode === "missing") {
    heartbeatAtMs = null;
  } else if (mode === "future") {
    heartbeatAtMs = now + 60 * 60 * 1000;
  } else {
    const exhaustive: never = mode;
    throw new Error(`Unknown corruptHeartbeat mode: ${String(exhaustive)}`);
  }

  db.query("UPDATE _smithers_runs SET heartbeat_at_ms = ? WHERE run_id = ?").run(
    heartbeatAtMs,
    runId,
  );
}
