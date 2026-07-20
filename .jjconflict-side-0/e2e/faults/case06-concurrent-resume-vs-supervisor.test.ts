/**
 * Case 6 (ticket 0022): concurrent resume vs supervisor takeover of a stale
 * running run must resolve to exactly one winner, and post-takeover writes from
 * the loser (and the deposed original owner) must be fenced out.
 *
 * REAL product path (no-mocks):
 *   - Build a real in-memory DB via `ensureSmithersTables` and drive it through
 *     the real `@smithers-orchestrator/db/adapter` `SmithersDb`.
 *   - The takeover is the REAL `adapter.claimRunForResume` compare-and-swap
 *     (owner + heartbeat expectation, stale-before gate) — the same primitive
 *     the resume path and the supervisor use in production.
 *   - The post-takeover fence is the REAL `adapter.heartbeatRun`, whose
 *     `WHERE run_id = ? AND runtime_owner_id = ?` clause is what actually
 *     rejects writes from a non-owner.
 *
 * This case previously fabricated its own `_smithers_runs` table and
 * reimplemented the CAS in the `takeoverRun` test harness plus a local
 * `fencedHeartbeatBump`,
 * so it validated a mock of the fencing contract rather than the product. The
 * conversion below exercises the shipping adapter methods directly.
 */

import { describe, expect, onTestFinished, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";

const STALE_THRESHOLD_MS = 30_000;

function buildAdapter(): { sqlite: Database; adapter: SmithersDb } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedStaleRunningRun(
  adapter: SmithersDb,
  runId: string,
  ownerId: string,
  now: number,
): Promise<void> {
  // Heartbeat well past the stale threshold: the victim engine looks dead.
  const heartbeatAtMs = now - 10 * STALE_THRESHOLD_MS;
  await adapter.insertRun({
    runId,
    workflowName: "case06-workflow",
    status: "running",
    createdAtMs: heartbeatAtMs - 5_000,
    startedAtMs: heartbeatAtMs - 5_000,
    heartbeatAtMs,
    runtimeOwnerId: ownerId,
  });
}

/**
 * Attempt a stale-run takeover against the REAL adapter CAS. Both the resume
 * path and the supervisor observe the same pre-race snapshot (owner +
 * heartbeat) and try to claim it; only one swap can succeed.
 */
function claimStale(
  adapter: SmithersDb,
  runId: string,
  snapshot: { owner: string | null; heartbeat: number | null },
  claimOwnerId: string,
  claimHeartbeatAtMs: number,
  now: number,
): Promise<boolean> {
  return Promise.resolve(
    adapter.claimRunForResume({
    runId,
    expectedStatus: "running",
    expectedRuntimeOwnerId: snapshot.owner,
    expectedHeartbeatAtMs: snapshot.heartbeat,
    staleBeforeMs: now - STALE_THRESHOLD_MS,
    claimOwnerId,
    claimHeartbeatAtMs,
    requireStale: true,
    }),
  );
}

describe("case 06: concurrent resume vs supervisor takeover", () => {
  test("CAS-on-runtime_owner_id: exactly one of (resume, supervisor) wins", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    const runId = "case06-run";
    const originalOwnerId = "pid:11111:engine-victim";
    const now = Date.now();
    await seedStaleRunningRun(adapter, runId, originalOwnerId, now);

    // Both contenders read the same stale snapshot before either swaps.
    const seen = await adapter.getRun(runId);
    const snapshot = {
      owner: seen?.runtimeOwnerId ?? null,
      heartbeat: seen?.heartbeatAtMs ?? null,
    };

    const resumeClaimed = await claimStale(
      adapter,
      runId,
      snapshot,
      "resume-cli:case06",
      now,
      now,
    );
    const supervisorClaimed = await claimStale(
      adapter,
      runId,
      snapshot,
      "supervisor:case06",
      now + 1,
      now,
    );

    expect([resumeClaimed, supervisorClaimed].filter(Boolean).length).toBe(1);
    expect(resumeClaimed).toBe(true);
    expect(supervisorClaimed).toBe(false);

    const row = await adapter.getRun(runId);
    expect(row?.runtimeOwnerId).toBe("resume-cli:case06");
  });

  test("supervisor wins when it swaps first; resume is fenced out", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    const runId = "case06-supervisor-first";
    const originalOwnerId = "pid:22222:engine-victim";
    const now = Date.now();
    await seedStaleRunningRun(adapter, runId, originalOwnerId, now);

    const seen = await adapter.getRun(runId);
    const snapshot = {
      owner: seen?.runtimeOwnerId ?? null,
      heartbeat: seen?.heartbeatAtMs ?? null,
    };

    const supervisorClaimed = await claimStale(
      adapter,
      runId,
      snapshot,
      "supervisor:case06b",
      now,
      now,
    );
    const resumeClaimed = await claimStale(
      adapter,
      runId,
      snapshot,
      "resume-cli:case06b",
      now + 1,
      now,
    );

    expect(supervisorClaimed).toBe(true);
    expect(resumeClaimed).toBe(false);

    const row = await adapter.getRun(runId);
    expect(row?.runtimeOwnerId).toBe("supervisor:case06b");
  });

  test("post-takeover writes are fenced: only the winning owner can heartbeat", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    const runId = "case06-fence";
    const originalOwnerId = "pid:33333:engine-victim";
    const now = Date.now();
    await seedStaleRunningRun(adapter, runId, originalOwnerId, now);

    const seen = await adapter.getRun(runId);
    const snapshot = {
      owner: seen?.runtimeOwnerId ?? null,
      heartbeat: seen?.heartbeatAtMs ?? null,
    };

    const resumerOwnerId = "resume-cli:case06c";
    const supervisorOwnerId = "supervisor:case06c";

    const resumeClaimed = await claimStale(adapter, runId, snapshot, resumerOwnerId, now, now);
    const supervisorClaimed = await claimStale(
      adapter,
      runId,
      snapshot,
      supervisorOwnerId,
      now + 1,
      now,
    );
    expect(resumeClaimed).toBe(true);
    expect(supervisorClaimed).toBe(false);

    const afterClaim = await adapter.getRun(runId);
    expect(afterClaim?.runtimeOwnerId).toBe(resumerOwnerId);
    const heartbeatAfterClaim = afterClaim?.heartbeatAtMs ?? null;

    // The fenced-out supervisor cannot advance the heartbeat: heartbeatRun is
    // scoped to the current owner, so a non-owner write matches zero rows.
    await adapter.heartbeatRun(runId, supervisorOwnerId, now + 1_000);
    expect((await adapter.getRun(runId))?.heartbeatAtMs).toBe(heartbeatAfterClaim);

    // Neither can the deposed original owner.
    await adapter.heartbeatRun(runId, originalOwnerId, now + 2_000);
    expect((await adapter.getRun(runId))?.heartbeatAtMs).toBe(heartbeatAfterClaim);

    // The winner can.
    const winnerBumpAtMs = now + 3_000;
    await adapter.heartbeatRun(runId, resumerOwnerId, winnerBumpAtMs);
    const finalRow = await adapter.getRun(runId);
    expect(finalRow?.runtimeOwnerId).toBe(resumerOwnerId);
    expect(finalRow?.heartbeatAtMs).toBe(winnerBumpAtMs);
  });
});
