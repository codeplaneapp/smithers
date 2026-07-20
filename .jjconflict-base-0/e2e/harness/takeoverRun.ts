import type { Database } from "bun:sqlite";

export type TakeoverResult = {
  claimed: boolean;
  newOwnerId: string;
  newHeartbeatAtMs: number;
};

export type TakeoverOptions = {
  staleThresholdMs?: number;
  now?: () => number;
};

const DEFAULT_STALE_THRESHOLD_MS = 30_000;

export function takeoverRun(
  db: Database,
  runId: string,
  newOwnerId: string,
  options: TakeoverOptions = {},
): TakeoverResult {
  const now = options.now ? options.now() : Date.now();
  const staleBefore = now - (options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS);

  const current = db
    .query(
      "SELECT runtime_owner_id, heartbeat_at_ms FROM _smithers_runs WHERE run_id = ?",
    )
    .get(runId) as
    | { runtime_owner_id: string | null; heartbeat_at_ms: number | null }
    | null;

  if (!current) {
    return { claimed: false, newOwnerId, newHeartbeatAtMs: now };
  }

  db.query(
    `UPDATE _smithers_runs
       SET runtime_owner_id = ?, heartbeat_at_ms = ?
     WHERE run_id = ?
       AND COALESCE(runtime_owner_id, '') = COALESCE(?, '')
       AND COALESCE(heartbeat_at_ms, -1) = COALESCE(?, -1)
       AND (heartbeat_at_ms IS NULL OR heartbeat_at_ms < ?)`,
  ).run(
    newOwnerId,
    now,
    runId,
    current.runtime_owner_id,
    current.heartbeat_at_ms,
    staleBefore,
  );

  const { count } = db.query("SELECT changes() AS count").get() as {
    count: number;
  };
  return {
    claimed: Number(count) > 0,
    newOwnerId,
    newHeartbeatAtMs: now,
  };
}
