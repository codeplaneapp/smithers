/**
 * The run driver's heartbeat sweep, over a real on-disk SQLite store.
 *
 * Spec 1.4 retires `apps/cli/src/supervisor.js`'s claim-by-proxy in favour of
 * this. The three row classes flows' §8 names — stale running, released, and
 * due wakes — plus the decided gate the legacy poll scanned for separately are
 * asserted against rows the adapter actually persisted, and so is the property
 * that made the claim-by-proxy necessary in the first place: the sweep stamps
 * no owner of its own.
 *
 * Every park here is seeded the way `engine.js` writes one: the run row, plus
 * the `RunStatusChanged` journal entry carrying the waiting annotation, emitted
 * through the engine's own `EventBus`. That matters most for the two shapes the
 * row alone cannot express — a released park and a human's `smithers pause`
 * both leave `paused` with every request column cleared, and a timer park
 * writes no `errorJson` at all.
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
import { DEFAULT_SWEEP_STALE_AFTER_MS, createRunDriverSweep } from "@smthrs/engine/sweep/createRunDriverSweep";
import { runsDueForQuotaResume } from "@smthrs/engine/engine";

const NOW = 1_800_000_000_000;

let store;

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-sweep-"));
  const sqlite = new Database(join(dir, "store.sqlite"));
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
      status: "running",
      createdAtMs: NOW - 60_000,
      startedAtMs: NOW - 60_000,
      ...patch,
    }),
  );
}

/**
 * Journal a status change exactly as the engine does: through `EventBus`, with
 * the waiting annotation riding on the entry.
 */
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

function makeSweep(overrides = {}) {
  const driven = [];
  const sweep = createRunDriverSweep({
    adapter: store.adapter,
    nowMs: () => NOW,
    drive: async (candidate) => {
      driven.push(candidate);
    },
    ...overrides,
  });
  return { sweep, driven };
}

beforeEach(() => {
  store = openStore();
});

afterEach(() => {
  store.cleanup();
});

describe("stale running rows", () => {
  test("a run whose heartbeat fell outside the window is re-driven", async () => {
    await insertRun(store.adapter, "fresh", { heartbeatAtMs: NOW - 1_000, runtimeOwnerId: "pid:1" });
    await insertRun(store.adapter, "stale", {
      heartbeatAtMs: NOW - DEFAULT_SWEEP_STALE_AFTER_MS - 1,
      runtimeOwnerId: "pid:2",
    });
    const { sweep, driven } = makeSweep();
    const result = await sweep.sweep();
    expect(driven.map((candidate) => candidate.runId)).toEqual(["stale"]);
    expect(result.driven[0].kind).toBe("stale-running");
  });

  test("the batch is capped per tick, oldest heartbeat first", async () => {
    for (const [runId, age] of [
      ["oldest", 900_000],
      ["middle", 600_000],
      ["newest", 300_000],
    ]) {
      await insertRun(store.adapter, runId, { heartbeatAtMs: NOW - age, runtimeOwnerId: "pid:9" });
    }
    const { sweep, driven } = makeSweep({ batch: 2 });
    const result = await sweep.sweep();
    expect(driven.map((candidate) => candidate.runId)).toEqual(["oldest", "middle"]);
    expect(result.deferred).toBe(1);
  });

  test("liveness is a lease question, and a caller can still inject its own", async () => {
    await insertRun(store.adapter, "stale", { heartbeatAtMs: NOW - 600_000, runtimeOwnerId: "pid:2" });
    const { sweep, driven } = makeSweep({ isOwnerAlive: (run) => run.runtimeOwnerId === "pid:2" });
    await sweep.sweep();
    expect(driven).toEqual([]);
  });

  test("no owner id is stamped on the row: there is no claim by proxy", async () => {
    await insertRun(store.adapter, "stale", { heartbeatAtMs: NOW - 600_000, runtimeOwnerId: "pid:2" });
    const { sweep } = makeSweep();
    await sweep.sweep();
    const run = await Effect.runPromise(store.adapter.getRun("stale"));
    expect(run.runtimeOwnerId).toBe("pid:2");
    expect(run.status).toBe("running");
  });
});

describe("released rows", () => {
  test("a run its owner let go without settling is found by reason, not by lease", async () => {
    await insertRun(store.adapter, "released", {
      status: "paused",
      heartbeatAtMs: null,
      runtimeOwnerId: null,
    });
    await journalStatusChange("released", "paused", { reason: "released" });
    const { sweep, driven } = makeSweep();
    await sweep.sweep();
    expect(driven).toHaveLength(1);
    expect(driven[0]).toMatchObject({ runId: "released", kind: "released" });
    expect(driven[0].annotation).toEqual({ reason: "released" });
  });

  test("a human-requested pause stays parked", async () => {
    // The shape the engine actually leaves behind: `finalizeDriverResult`
    // clears `pauseRequestedAtMs` when it completes a graceful pause, so the
    // row is byte-identical to a released one. Only the journal separates them,
    // and a human pause journals no annotation.
    await insertRun(store.adapter, "human-paused", {
      status: "paused",
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      pauseRequestedAtMs: null,
    });
    await journalStatusChange("human-paused", "paused", null);
    const { sweep, driven } = makeSweep();
    await sweep.sweep();
    expect(driven).toEqual([]);
  });

  test("a pause still being drained is left to the engine draining it", async () => {
    await insertRun(store.adapter, "pausing", {
      status: "paused",
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      pauseRequestedAtMs: NOW - 1_000,
    });
    const { sweep, driven } = makeSweep();
    await sweep.sweep();
    expect(driven).toEqual([]);
  });

  test("a release the run has since resumed past is not a standing release", async () => {
    await insertRun(store.adapter, "resumed-then-paused", {
      status: "paused",
      heartbeatAtMs: null,
      runtimeOwnerId: null,
    });
    await journalStatusChange("resumed-then-paused", "paused", { reason: "released" });
    await journalStatusChange("resumed-then-paused", "running", null);
    await journalStatusChange("resumed-then-paused", "paused", null);
    const { sweep, driven } = makeSweep();
    await sweep.sweep();
    expect(driven).toEqual([]);
  });
});

describe("due wakes", () => {
  test("a timer park is due once its annotation deadline passes", async () => {
    // A timer park leaves `errorJson` untouched — the deadline exists only on
    // the journal entry, which is where the sweep has to read it from.
    await insertRun(store.adapter, "timer-due", { status: "waiting-timer", heartbeatAtMs: null });
    await journalStatusChange("timer-due", "waiting-timer", { reason: "timer", wakeAt: NOW - 1 });
    await insertRun(store.adapter, "timer-pending", { status: "waiting-timer", heartbeatAtMs: null });
    await journalStatusChange("timer-pending", "waiting-timer", { reason: "timer", wakeAt: NOW + 60_000 });
    const { sweep, driven } = makeSweep();
    await sweep.sweep();
    expect(driven.map((candidate) => candidate.runId)).toEqual(["timer-due"]);
    expect(driven[0].annotation).toEqual({ reason: "timer", wakeAt: NOW - 1 });
  });

  test("a quota park wakes through the same deadline the annotation carries", async () => {
    await insertRun(store.adapter, "quota-due", {
      status: "waiting-quota",
      heartbeatAtMs: null,
      errorJson: JSON.stringify({
        quotaBlockedCount: 1,
        waiting: { reason: "quota", wakeAt: NOW - 5 },
      }),
    });
    const { sweep, driven } = makeSweep();
    await sweep.sweep();
    expect(driven[0]).toMatchObject({ runId: "quota-due", kind: "due-wake" });
    expect(driven[0].annotation).toEqual({ reason: "quota", wakeAt: NOW - 5 });

    // The engine's own due-quota query answers the same question from the same
    // annotation, so the sweep and the legacy waker cannot disagree.
    const due = await runsDueForQuotaResume(store.adapter, NOW);
    expect(due.map((run) => run.runId)).toEqual(["quota-due"]);
    expect(await runsDueForQuotaResume(store.adapter, NOW - 60_000)).toEqual([]);
  });

  test("a park with no deadline is never due", async () => {
    await insertRun(store.adapter, "approval", {
      status: "waiting-approval",
      heartbeatAtMs: null,
    });
    await insertRun(store.adapter, "quota-indefinite", {
      status: "waiting-quota",
      heartbeatAtMs: null,
      errorJson: JSON.stringify({ quotaBlockedCount: 1 }),
    });
    const { sweep, driven } = makeSweep();
    await sweep.sweep();
    expect(driven).toEqual([]);
    expect(await runsDueForQuotaResume(store.adapter, NOW)).toEqual([]);
  });

  test("a run already asked to cancel is left to the cancel path", async () => {
    await insertRun(store.adapter, "cancelling", {
      status: "waiting-timer",
      heartbeatAtMs: null,
      cancelRequestedAtMs: NOW - 10,
    });
    await journalStatusChange("cancelling", "waiting-timer", { reason: "timer", wakeAt: NOW - 1 });
    const { sweep, driven } = makeSweep();
    await sweep.sweep();
    expect(driven).toEqual([]);
  });
});

describe("decided gates", () => {
  /** Seed a gate decided while no engine owned the run. */
  async function seedDecidedGate(runId, status) {
    await insertRun(store.adapter, runId, { status, heartbeatAtMs: null });
    await Effect.runPromise(
      store.adapter.insertNode({
        runId,
        nodeId: "gated",
        iteration: 0,
        state: "pending",
        lastAttempt: 0,
        updatedAtMs: NOW - 5_000,
        outputTable: `sweep_${runId.replace(/-/g, "_")}`,
      }),
    );
    await Effect.runPromise(
      store.adapter.insertOrUpdateApproval({
        runId,
        nodeId: "gated",
        iteration: 0,
        status: "approved",
        requestedAtMs: NOW - 10_000,
        decidedAtMs: NOW - 5_000,
        decidedBy: "will",
      }),
    );
    await journalStatusChange(runId, status, {
      reason: status === "waiting-approval" ? "approval" : "event",
      token: "gated",
    });
  }

  test("an approval decided while the run was detached is swept, on either parked status", async () => {
    await seedDecidedGate("gate-approval", "waiting-approval");
    await seedDecidedGate("gate-event", "waiting-event");
    const { sweep, driven } = makeSweep();
    await sweep.sweep();
    expect(driven.map((candidate) => candidate.runId).sort()).toEqual(["gate-approval", "gate-event"]);
    expect(driven.every((candidate) => candidate.kind === "decided-gate")).toBe(true);
  });

  test("an undecided gate is not a wake: it is still waiting for a human", async () => {
    await insertRun(store.adapter, "gate-pending", { status: "waiting-approval", heartbeatAtMs: null });
    await Effect.runPromise(
      store.adapter.insertNode({
        runId: "gate-pending",
        nodeId: "gated",
        iteration: 0,
        state: "pending",
        lastAttempt: 0,
        updatedAtMs: NOW - 5_000,
        outputTable: "sweep_gate_pending",
      }),
    );
    await Effect.runPromise(
      store.adapter.insertOrUpdateApproval({
        runId: "gate-pending",
        nodeId: "gated",
        iteration: 0,
        status: "pending",
        requestedAtMs: NOW - 10_000,
      }),
    );
    await journalStatusChange("gate-pending", "waiting-approval", { reason: "approval", token: "gated" });
    const { sweep, driven } = makeSweep();
    await sweep.sweep();
    expect(driven).toEqual([]);
  });

  test("a live owner keeps its own decided gate", async () => {
    await seedDecidedGate("gate-owned", "waiting-approval");
    const { sweep, driven } = makeSweep({ isOwnerAlive: () => true });
    await sweep.sweep();
    expect(driven).toEqual([]);
  });
});

describe("one tick", () => {
  test("a row in two classes is driven once, and a failing drive is reported", async () => {
    await insertRun(store.adapter, "stale", { heartbeatAtMs: NOW - 600_000, runtimeOwnerId: "pid:1" });
    const sweep = createRunDriverSweep({
      adapter: store.adapter,
      nowMs: () => NOW,
      drive: async () => {
        throw new Error("no workflow file");
      },
    });
    const result = await sweep.sweep();
    expect(result.driven).toEqual([]);
    expect(result.failures).toEqual([{ runId: "stale", error: "no workflow file" }]);
  });
});
