/**
 * `smithers supervise` on the flows route: the run driver's own sweep, not the
 * claim-by-proxy poll.
 *
 * Spec 1.4 of `.smithers/specs/flows-migration.md` deletes the claim-by-proxy
 * process. What replaces it is asserted here against a real on-disk SQLite
 * store through the shipping `SmithersDb`: the sweep finds stale-running rows,
 * released rows, and due wakes, spawns a process that can drive each one, and
 * — the property the claim existed for — leaves the row's owner untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { EventBus } from "@smthrs/engine/events";
import { createResumeAttemptLedger, runDriverSweepPoll } from "../src/supervisor-sweep.js";
import { usesRunDriverSweep } from "../src/supervisor.js";

const NOW = 1_800_000_000_000;

let store;

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-cli-sweep-"));
  const sqlite = new Database(join(dir, "smithers.db"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return {
    dir,
    sqlite,
    adapter: new SmithersDb(db),
    cleanup() {
      try {
        sqlite.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function insertRun(adapter, runId, patch) {
  return Effect.runPromise(
    adapter.insertRun({
      runId,
      workflowName: "sweep-workflow",
      workflowPath: join(store.dir, "workflow.tsx"),
      status: "running",
      createdAtMs: NOW - 600_000,
      startedAtMs: NOW - 600_000,
      ...patch,
    }),
  );
}

/** Journal a status change the way the engine does, annotation and all. */
async function journalStatusChange(runId, status, waiting) {
  const bus = new EventBus({ db: store.adapter, startSeq: 0 });
  await Effect.runPromise(
    bus.emitEventWithPersist({
      type: "RunStatusChanged",
      runId,
      status,
      timestampMs: NOW,
      ...(waiting ? { waiting } : {}),
    }),
  );
}

function sweepWith(overrides = {}) {
  const spawned = [];
  // Each sweep gets its own ledger: the attempt count is per supervisor, and a
  // test that shared the process-wide default would inherit another test's.
  const ledger = overrides.ledger ?? createResumeAttemptLedger();
  let nowMs = NOW;
  return {
    spawned,
    ledger,
    /** Advance the clock the sweep sees, e.g. past the respawn grace. */
    advance(ms) {
      nowMs += ms;
    },
    run: () =>
      runDriverSweepPoll({
        adapter: store.adapter,
        staleThresholdMs: 30_000,
        maxConcurrent: 3,
        deps: {
          now: () => nowMs,
          workflowExists: () => true,
          spawnResumeDetached: (target, runId) => {
            spawned.push({ runId, cwd: target.cwd });
            return 4321;
          },
        },
        ...overrides,
        ledger,
      }),
  };
}

beforeEach(() => {
  store = openStore();
});

afterEach(() => {
  store.cleanup();
});

describe("route selection", () => {
  test("the sweep owns the poll only on the flows engine", () => {
    expect(usesRunDriverSweep({ SMITHERS_ENGINE: "flows" })).toBe(true);
    expect(usesRunDriverSweep({ SMITHERS_ENGINE: "legacy" })).toBe(false);
    expect(usesRunDriverSweep({})).toBe(false);
  });
});

describe("the sweep re-drives without claiming", () => {
  test("a stale running run is resumed and its owner id is left alone", async () => {
    await insertRun(store.adapter, "stale", {
      heartbeatAtMs: NOW - 600_000,
      runtimeOwnerId: "pid:99999:owner",
    });
    const sweep = sweepWith();
    const summary = await sweep.run();

    expect(sweep.spawned.map((entry) => entry.runId)).toEqual(["stale"]);
    expect(summary.resumedCount).toBe(1);

    // The claim-by-proxy this replaces stamped `supervisor:<id>#aN` here and
    // had to release it by hand when the spawn failed. Nothing does that now.
    const run = await Effect.runPromise(store.adapter.getRun("stale"));
    expect(run.runtimeOwnerId).toBe("pid:99999:owner");
    expect(run.status).toBe("running");
  });

  test("a released row, a due wake, and a decided gate are one sweep, not three code paths", async () => {
    await insertRun(store.adapter, "released", {
      status: "paused",
      heartbeatAtMs: null,
      runtimeOwnerId: null,
    });
    await journalStatusChange("released", "paused", { reason: "released" });
    await insertRun(store.adapter, "quota-due", {
      status: "waiting-quota",
      heartbeatAtMs: null,
      errorJson: JSON.stringify({ waiting: { reason: "quota", wakeAt: NOW - 1 } }),
    });
    await insertRun(store.adapter, "timer-due", { status: "waiting-timer", heartbeatAtMs: null });
    await journalStatusChange("timer-due", "waiting-timer", { reason: "timer", wakeAt: NOW - 1 });
    const sweep = sweepWith();
    await sweep.run();
    expect(sweep.spawned.map((entry) => entry.runId).sort()).toEqual(["quota-due", "released", "timer-due"]);
  });

  test("a run a human paused is not resumed behind their back", async () => {
    // `smithers pause` completes by clearing `pauseRequestedAtMs`, so the row
    // is indistinguishable from a released one and only the journal says which
    // is which. Auto-resuming this would undo the operator's decision.
    await insertRun(store.adapter, "human-paused", {
      status: "paused",
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      pauseRequestedAtMs: null,
    });
    await journalStatusChange("human-paused", "paused", null);
    const sweep = sweepWith();
    const summary = await sweep.run();
    expect(sweep.spawned).toEqual([]);
    expect(summary.resumedCount).toBe(0);
  });

  test("a run this process cannot relaunch is left parked, not churned", async () => {
    await insertRun(store.adapter, "stale", { heartbeatAtMs: NOW - 600_000 });
    const sweep = sweepWith({
      deps: {
        now: () => NOW,
        workflowExists: () => false,
        spawnResumeDetached: () => {
          throw new Error("should not spawn");
        },
      },
    });
    const summary = await sweep.run();
    expect(sweep.spawned).toEqual([]);
    expect(summary.resumedCount).toBe(0);
    expect(summary.skippedCount).toBeGreaterThan(0);
  });

  test("a dry run reports what it would resume and spawns nothing", async () => {
    await insertRun(store.adapter, "stale", { heartbeatAtMs: NOW - 600_000 });
    const sweep = sweepWith({ dryRun: true });
    const summary = await sweep.run();
    expect(sweep.spawned).toEqual([]);
    expect(summary.wouldResumeRunIds).toEqual(["stale"]);
  });

  test("a scoped sweep ignores runs outside its scope", async () => {
    await insertRun(store.adapter, "mine", { heartbeatAtMs: NOW - 600_000 });
    await insertRun(store.adapter, "theirs", { heartbeatAtMs: NOW - 600_000 });
    const sweep = sweepWith({ runIds: new Set(["mine"]) });
    await sweep.run();
    expect(sweep.spawned.map((entry) => entry.runId)).toEqual(["mine"]);
  });
});

describe("the give-up guard the claim used to carry", () => {
  /** Every tick sees the same unchanged row, which is what a dead spawn leaves. */
  async function insertUnchangingStaleRun() {
    await insertRun(store.adapter, "wont-start", {
      heartbeatAtMs: NOW - 600_000,
      runtimeOwnerId: "pid:99999:owner",
    });
  }

  test("a resume that never claims is not respawned on the very next tick", async () => {
    await insertUnchangingStaleRun();
    const sweep = sweepWith();
    await sweep.run();
    // The poll interval is 10s and a cold resume takes tens of seconds to
    // reach its claim. Spawning again here is the churn loop.
    sweep.advance(10_000);
    const second = await sweep.run();
    expect(sweep.spawned.map((entry) => entry.runId)).toEqual(["wont-start"]);
    expect(second.resumedCount).toBe(0);
    expect(second.gaveUpRunIds).toEqual([]);
  });

  test("after maxResumeAttempts spawns change nothing the run is given up on, not respawned forever", async () => {
    await insertUnchangingStaleRun();
    const sweep = sweepWith({ ledger: createResumeAttemptLedger({ maxAttempts: 3, graceMs: 120_000 }) });

    for (let tick = 0; tick < 3; tick += 1) {
      const summary = await sweep.run();
      expect(summary.gaveUpRunIds).toEqual([]);
      sweep.advance(120_000);
    }
    expect(sweep.spawned.map((entry) => entry.runId)).toEqual(["wont-start", "wont-start", "wont-start"]);

    const gaveUp = await sweep.run();
    expect(gaveUp.gaveUpRunIds).toEqual(["wont-start"]);
    // Three spawns, and no fourth.
    expect(sweep.spawned).toHaveLength(3);

    // Durable, so a restarted supervisor with an empty ledger does not begin
    // the whole cycle again, and an operator can see why it stopped.
    const run = await Effect.runPromise(store.adapter.getRun("wont-start"));
    expect(run.status).toBe("failed");
    expect(JSON.parse(run.errorJson).code).toBe("AUTO_RESUME_GAVE_UP");
    expect(JSON.parse(run.errorJson).details.attempts).toBe(3);

    // The row is terminal now, so it is not even a candidate any more.
    sweep.advance(120_000);
    const after = await sweep.run();
    expect(sweep.spawned).toHaveLength(3);
    expect(after.gaveUpRunIds).toEqual([]);
  });

  test("a resume that does claim resets the attempt count", async () => {
    await insertUnchangingStaleRun();
    const sweep = sweepWith({ ledger: createResumeAttemptLedger({ maxAttempts: 2, graceMs: 60_000 }) });
    await sweep.run();
    sweep.advance(60_000);
    await sweep.run();
    // Two attempts used: one more unchanged tick would give up.
    expect(sweep.spawned).toHaveLength(2);

    // What a successful resume looks like from the sweep's side: a heartbeat
    // inside the staleness window. The row stops being a candidate.
    sweep.advance(60_000);
    await Effect.runPromise(
      store.adapter.updateRun("wont-start", { runtimeOwnerId: "pid:1234:new", heartbeatAtMs: NOW + 120_000 }),
    );
    const healthy = await sweep.run();
    expect(sweep.spawned).toHaveLength(2);
    expect(healthy.staleCount).toBe(0);

    // When that owner later dies, the run is a new candidate with a new
    // heartbeat, so it gets the whole budget again rather than the zero
    // attempts a monotonic counter would have left it.
    sweep.advance(600_000);
    const revived = await sweep.run();
    expect(sweep.spawned).toHaveLength(3);
    expect(revived.gaveUpRunIds).toEqual([]);
    expect((await Effect.runPromise(store.adapter.getRun("wont-start"))).status).toBe("running");
  });
});
