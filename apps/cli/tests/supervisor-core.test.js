import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { runsDueForQuotaResume } from "../../../packages/engine/src/engine.js";
import { denyNode } from "../../../packages/engine/src/approvals.js";
import { cascadeCancelRun } from "../src/cancel-cascade.js";
import { SUPERVISOR_EVENT_RUN_ID, supervisorLoopEffect, supervisorPollEffect } from "../src/supervisor.js";
const now = Date.now();
function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  return { adapter, sqlite };
}
/**
 * @param {string} runId
 * @param {any} [extra]
 */
function runRow(runId, extra = {}) {
  return {
    runId,
    workflowName: "test-workflow",
    workflowPath: `/tmp/${runId}.tsx`,
    status: "running",
    createdAtMs: now - 120_000,
    startedAtMs: now - 120_000,
    heartbeatAtMs: now - 60_000,
    runtimeOwnerId: "pid:99999:owner",
    ...extra,
  };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function listEventTypes(adapter, runId) {
  const events = await adapter.listEvents(runId, -1, 500);
  return events.map((event) => event.type);
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function skipReasonFor(adapter, runId) {
  const events = await adapter.listEvents(runId, -1, 50);
  const skip = events.find((event) => event.type === "RunAutoResumeSkipped");
  return skip ? JSON.parse(skip.payloadJson).reason : null;
}
/**
 * Seed a waiting-event run whose approval gate was decided while the run was
 * detached: the gate node is already "pending" in the DB (the engine moved it
 * there on approval), but no engine is alive to execute it. The runtime owner
 * is a dead pid and the heartbeat is stale.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ approvalStatus?: "approved" | "denied" | "requested"; heartbeatAtMs?: number | null }} [opts]
 */
async function insertApprovalDecidedRun(adapter, runId, opts = {}) {
  const approvalStatus = opts.approvalStatus ?? "approved";
  const decided = approvalStatus === "approved" || approvalStatus === "denied";
  await adapter.insertRun(
    runRow(runId, {
      status: "waiting-event",
      heartbeatAtMs: opts.heartbeatAtMs ?? now - 60_000,
      runtimeOwnerId: "pid:99999:owner",
    }),
  );
  await adapter.insertNode({
    runId,
    nodeId: "review",
    iteration: 0,
    // The gate node is "pending" after the decision was recorded; this is
    // what listDecidedApprovals joins against (n.state = 'pending').
    state: "pending",
    lastAttempt: 1,
    updatedAtMs: now - 2_000,
    outputTable: "",
    label: "approval:review",
  });
  await adapter.insertOrUpdateApproval({
    runId,
    nodeId: "review",
    iteration: 0,
    status: approvalStatus,
    requestedAtMs: now - 2_000,
    decidedAtMs: decided ? now - 1_000 : null,
    note: null,
    decidedBy: decided ? "user:test" : null,
  });
}
/**
 * Seed a run parked PURELY on the approval gate: it persists as
 * `waiting-approval` (engine markRunWaiting), which the waiting-event scan never
 * sees. After the operator recorded the decision detached, the gate node is
 * re-armed to "pending" and the approval is decided, but no engine is alive to
 * act on it. This is the exact gap the waiting-approval supervisor branch fills.
 *
 * NOTE: this seeds an APPROVED or still-REQUESTED gate only. A denied gate is
 * deliberately NOT expressible here — denyNode moves the node to state "failed"
 * (and the run to waiting-event), so a (denied + pending-node) fixture is a state
 * the engine never produces. Denied runs are seeded through the real engine path
 * by {@link insertRealDeniedDetachedRun} so a test can never re-mask the denied
 * resume gap with an impossible fixture.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ approvalStatus?: "approved" | "requested"; runtimeOwnerId?: string | null }} [opts]
 */
async function insertGateDecidedRun(adapter, runId, opts = {}) {
  const approvalStatus = opts.approvalStatus ?? "approved";
  const decided = approvalStatus === "approved";
  await adapter.insertRun(
    runRow(runId, {
      status: "waiting-approval",
      heartbeatAtMs: now - 60_000,
      runtimeOwnerId: opts.runtimeOwnerId ?? "pid:99999:owner",
    }),
  );
  await adapter.insertNode({
    runId,
    nodeId: "review",
    iteration: 0,
    // approveNode re-arms the gate node to "pending"; that's what
    // listResumableDecidedApprovals joins against. (A run stays waiting-approval
    // with an approved gate only while a sibling gate is still pending.)
    state: "pending",
    lastAttempt: 1,
    updatedAtMs: now - 2_000,
    outputTable: "",
    label: "approval:review",
  });
  await adapter.insertOrUpdateApproval({
    runId,
    nodeId: "review",
    iteration: 0,
    status: approvalStatus,
    requestedAtMs: now - 2_000,
    decidedAtMs: decided ? now - 1_000 : null,
    note: null,
    decidedBy: decided ? "user:test" : null,
  });
}
/**
 * Seed a run parked at a gate and DENY it through the real engine `denyNode`
 * path — no hand-forged fixture. This is what a gateway / serve API / interactive
 * `approve --watch` denial does. denyNode moves the gate node to state "failed"
 * and (0 pending remaining) the run to status "waiting-event": the exact state a
 * detached deny leaves behind. The heartbeat is stale and the runtime owner is a
 * dead pid, so the run is a genuine orphan awaiting the supervisor safety net —
 * and the pending-node-only query the supervisor used to gate on would silently
 * skip it.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function insertRealDeniedDetachedRun(adapter, runId) {
  await adapter.insertRun(
    runRow(runId, {
      status: "waiting-approval",
      heartbeatAtMs: now - 60_000,
      runtimeOwnerId: "pid:99999:owner",
    }),
  );
  await adapter.insertNode({
    runId,
    nodeId: "review",
    iteration: 0,
    state: "waiting-approval",
    lastAttempt: 1,
    updatedAtMs: now - 2_000,
    outputTable: "",
    label: "approval:review",
  });
  await adapter.insertOrUpdateApproval({
    runId,
    nodeId: "review",
    iteration: 0,
    status: "requested",
    requestedAtMs: now - 2_000,
    decidedAtMs: null,
    note: null,
    decidedBy: null,
  });
  // Drive the REAL deny path. Post-conditions (asserted by callers): the gate
  // node is "failed" and the run is "waiting-event".
  await Effect.runPromise(denyNode(adapter, runId, "review", 0, "denied by test", "user:test"));
}
describe("supervisor poll core", () => {
  test("auto-resumes stale runs", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await adapter.insertRun(runRow("run-stale"));
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        maxConcurrent: 3,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 4242;
          },
        },
      }),
    );
    expect(summary).toEqual({
      staleCount: 1,
      resumedCount: 1,
      skippedCount: 0,
      durationMs: 0,
      wouldResumeRunIds: [],
    });
    expect(resumed).toEqual(["run-stale"]);
    expect(await listEventTypes(adapter, "run-stale")).toContain("RunAutoResumed");
    sqlite.close();
  });
  test("does not resume healthy runs", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await adapter.insertRun(
      runRow("run-fresh", {
        heartbeatAtMs: now - 1_000,
      }),
    );
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 111;
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(0);
    expect(summary.resumedCount).toBe(0);
    expect(resumed.length).toBe(0);
    sqlite.close();
  });
  test("resumes only due, in-scope quota parks whose owner is not alive", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await adapter.insertRun(
      runRow("run-quota-due", {
        status: "waiting-quota",
        heartbeatAtMs: now - 1_000,
        runtimeOwnerId: null,
        errorJson: JSON.stringify({ resetAtMs: now - 1 }),
      }),
    );
    await adapter.insertRun(
      runRow("run-quota-future", {
        status: "waiting-quota",
        runtimeOwnerId: null,
        errorJson: JSON.stringify({ resetAtMs: now + 60_000 }),
      }),
    );
    await adapter.insertRun(
      runRow("run-quota-other-scope", {
        status: "waiting-quota",
        runtimeOwnerId: null,
        errorJson: JSON.stringify({ resetAtMs: now - 1 }),
      }),
    );
    await adapter.insertRun(
      runRow("run-quota-owner-alive", {
        status: "waiting-quota",
        runtimeOwnerId: `pid:${process.pid}:owner`,
        errorJson: JSON.stringify({ resetAtMs: now - 1 }),
      }),
    );
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        runIds: ["run-quota-due", "run-quota-future", "run-quota-owner-alive"],
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: (pid) => pid === process.pid,
          runsDueForQuotaResume,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 7777;
          },
        },
      }),
    );
    expect(summary.resumedCount).toBe(1);
    expect(resumed).toEqual(["run-quota-due"]);
    expect((await adapter.getRun("run-quota-future"))?.runtimeOwnerId).toBeNull();
    expect((await adapter.getRun("run-quota-other-scope"))?.runtimeOwnerId).toBeNull();
    expect(await listEventTypes(adapter, "run-quota-owner-alive")).toContain("RunAutoResumeSkipped");
    sqlite.close();
  });
  test("never wakes a due quota park after cancellation wins", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await adapter.insertRun(
      runRow("run-quota-cancelled", {
        status: "waiting-quota",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        errorJson: JSON.stringify({ resetAtMs: now - 1 }),
      }),
    );
    await cascadeCancelRun(adapter, "run-quota-cancelled");

    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        runIds: ["run-quota-cancelled"],
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          runsDueForQuotaResume,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 7777;
          },
        },
      }),
    );

    expect((await adapter.getRun("run-quota-cancelled"))?.status).toBe("cancelled");
    expect(summary.resumedCount).toBe(0);
    expect(resumed).toEqual([]);
    sqlite.close();
  });
  test("scoped supervisor exits after every bound run becomes terminal", async () => {
    const { adapter, sqlite } = createTestDb();
    await adapter.insertRun(
      runRow("run-scoped-loop", {
        heartbeatAtMs: now - 1_000,
        runtimeOwnerId: null,
      }),
    );
    const loop = Effect.runPromise(
      supervisorLoopEffect({
        adapter,
        runIds: ["run-scoped-loop"],
        pollIntervalMs: 10,
        staleThresholdMs: 30_000,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: () => {
            throw new Error("fresh run must not resume");
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await adapter.updateRun("run-scoped-loop", {
      status: "finished",
      finishedAtMs: now,
    });
    let timeout;
    const result = await Promise.race([
      loop.then(() => "exited"),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve("timed-out"), 10_000);
      }),
    ]);
    clearTimeout(timeout);
    expect(result).toBe("exited");
    sqlite.close();
  });
  test("resumes waiting-timer runs when timer is due", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await adapter.insertRun(
      runRow("run-timer-due", {
        status: "waiting-timer",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
      }),
    );
    await adapter.insertNode({
      runId: "run-timer-due",
      nodeId: "cooldown",
      iteration: 0,
      state: "waiting-timer",
      lastAttempt: 1,
      updatedAtMs: now - 1_000,
      outputTable: "",
      label: "timer:cooldown",
    });
    await adapter.insertAttempt({
      runId: "run-timer-due",
      nodeId: "cooldown",
      iteration: 0,
      attempt: 1,
      state: "waiting-timer",
      startedAtMs: now - 1_000,
      finishedAtMs: null,
      errorJson: null,
      jjPointer: null,
      jjCwd: null,
      cached: false,
      metaJson: JSON.stringify({
        kind: "timer",
        timer: {
          timerId: "cooldown",
          timerType: "duration",
          createdAtMs: now - 1_000,
          firesAtMs: now - 10,
          firedAtMs: null,
        },
      }),
      responseText: null,
    });
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 999;
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(0);
    expect(summary.resumedCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
    expect(resumed).toEqual(["run-timer-due"]);
    sqlite.close();
  });
  test("skips stale run when runtime owner pid is alive", async () => {
    const { adapter, sqlite } = createTestDb();
    await adapter.insertRun(
      runRow("run-alive", {
        runtimeOwnerId: `pid:${process.pid}:same-process`,
      }),
    );
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => true,
          spawnResumeDetached: () => {
            throw new Error("should not be called");
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(1);
    expect(summary.resumedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    expect(summary.wouldResumeRunIds).toEqual([]);
    const events = await adapter.listEvents("run-alive", -1, 20);
    const skip = events.find((event) => event.type === "RunAutoResumeSkipped");
    expect(skip).toBeDefined();
    const payload = JSON.parse(skip.payloadJson);
    expect(payload.reason).toBe("pid-alive");
    sqlite.close();
  });
  test("scoped supervision only considers the named run", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await adapter.insertRun(runRow("run-x"));
    await adapter.insertRun(runRow("run-y"));
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        runIds: ["run-x"],
        staleThresholdMs: 30_000,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 456;
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(1);
    expect(resumed).toEqual(["run-x"]);
    expect((await adapter.getRun("run-y")).runtimeOwnerId).toBe("pid:99999:owner");
    sqlite.close();
  });
  test("dry-run reports stale runs without resuming", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await adapter.insertRun(runRow("run-dry"));
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        dryRun: true,
        staleThresholdMs: 30_000,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 222;
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(1);
    expect(summary.resumedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    expect(summary.wouldResumeRunIds).toEqual(["run-dry"]);
    expect(resumed.length).toBe(0);
    expect(await listEventTypes(adapter, "run-dry")).not.toContain("RunAutoResumed");
    sqlite.close();
  });
  test("skips stale runs whose workflow file is missing", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await adapter.insertRun(runRow("run-missing-workflow"));
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        deps: {
          now: () => now,
          workflowExists: () => false,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 888;
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(1);
    expect(summary.resumedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    expect(resumed).toHaveLength(0);
    const events = await adapter.listEvents("run-missing-workflow", -1, 20);
    const skip = events.find((event) => event.type === "RunAutoResumeSkipped");
    expect(skip).toBeDefined();
    const payload = JSON.parse(skip.payloadJson);
    expect(payload.reason).toBe("missing-workflow");
    sqlite.close();
  });
  test("ignores non-running stale runs", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await adapter.insertRun(runRow("run-failed", { status: "failed" }));
    await adapter.insertRun(runRow("run-cancelled", { status: "cancelled" }));
    await adapter.insertRun(runRow("run-running"));
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 777;
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(1);
    expect(summary.resumedCount).toBe(1);
    expect(resumed).toEqual(["run-running"]);
    sqlite.close();
  });
  test("rate-limits stale resumes per poll", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    for (let i = 0; i < 5; i++) {
      await adapter.insertRun(
        runRow(`run-${i}`, {
          heartbeatAtMs: now - 60_000 - i * 1_000,
        }),
      );
    }
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        maxConcurrent: 3,
        staleThresholdMs: 30_000,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 333;
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(5);
    expect(summary.resumedCount).toBe(3);
    expect(summary.skippedCount).toBe(2);
    expect(resumed.length).toBe(3);
    let rateLimitedEvents = 0;
    for (let i = 0; i < 5; i++) {
      const events = await adapter.listEvents(`run-${i}`, -1, 50);
      for (const event of events) {
        if (event.type !== "RunAutoResumeSkipped") continue;
        const payload = JSON.parse(event.payloadJson);
        if (payload.reason === "rate-limited") rateLimitedEvents++;
      }
    }
    expect(rateLimitedEvents).toBe(2);
    sqlite.close();
  });
  test("poll emits SupervisorPollCompleted event", async () => {
    const { adapter, sqlite } = createTestDb();
    await adapter.insertRun(runRow("run-supervisor-event"));
    await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: () => 444,
        },
      }),
    );
    const events = await adapter.listEvents(SUPERVISOR_EVENT_RUN_ID, -1, 20);
    const types = events.map((event) => event.type);
    expect(types).toContain("SupervisorPollCompleted");
    sqlite.close();
  });
  test("a freshly claimed run is not resumed twice across immediate polls", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await adapter.insertRun(runRow("run-idempotent"));
    const options = {
      adapter,
      staleThresholdMs: 30_000,
      deps: {
        now: () => now,
        workflowExists: () => true,
        isPidAlive: () => false,
        spawnResumeDetached: (_workflowPath, runId) => {
          resumed.push(runId);
          return 555;
        },
      },
    };
    const first = await Effect.runPromise(supervisorPollEffect(options));
    const second = await Effect.runPromise(supervisorPollEffect(options));
    expect(first.resumedCount).toBe(1);
    expect(second.resumedCount).toBe(0);
    expect(resumed).toEqual(["run-idempotent"]);
    sqlite.close();
  });
  test("resumes a waiting-event run whose approval was decided while detached", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await insertApprovalDecidedRun(adapter, "run-approval-decided");
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        maxConcurrent: 3,
        supervisorId: "approval-resume",
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 9090;
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(0);
    expect(summary.resumedCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
    expect(resumed).toEqual(["run-approval-decided"]);
    expect(await listEventTypes(adapter, "run-approval-decided")).toContain("RunAutoResumed");
    const run = await adapter.getRun("run-approval-decided");
    expect(run?.runtimeOwnerId).toBe("supervisor:approval-resume");
    expect(run?.heartbeatAtMs).toBe(now);
    sqlite.close();
  });
  test("a scoped approval resume cannot be crowded out by 500 newer unrelated runs", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await insertApprovalDecidedRun(adapter, "run-scoped-approval");
    for (let index = 0; index < 500; index++) {
      await adapter.insertRun(
        runRow(`run-unrelated-${index}`, {
          status: "waiting-event",
          createdAtMs: now + index,
          heartbeatAtMs: now - 60_000,
        }),
      );
    }
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        runIds: ["run-scoped-approval"],
        staleThresholdMs: 30_000,
        maxConcurrent: 1,
        supervisorId: "scoped-approval-resume",
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 9094;
          },
        },
      }),
    );
    expect(summary.resumedCount).toBe(1);
    expect(resumed).toEqual(["run-scoped-approval"]);
    sqlite.close();
  });
  test("does not resume a waiting-event run whose approval is still undecided", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await insertApprovalDecidedRun(adapter, "run-approval-pending", {
      approvalStatus: "requested",
    });
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        maxConcurrent: 3,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 9091;
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(0);
    expect(summary.resumedCount).toBe(0);
    expect(resumed).toHaveLength(0);
    expect(await listEventTypes(adapter, "run-approval-pending")).not.toContain("RunAutoResumed");
    sqlite.close();
  });
  test("resumes a waiting-approval run whose gate was decided (approved) while detached", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await insertGateDecidedRun(adapter, "run-gate-approved");
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        maxConcurrent: 3,
        supervisorId: "gate-resume",
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 9490;
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(0);
    expect(summary.resumedCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
    expect(resumed).toEqual(["run-gate-approved"]);
    expect(await listEventTypes(adapter, "run-gate-approved")).toContain("RunAutoResumed");
    const run = await adapter.getRun("run-gate-approved");
    expect(run?.runtimeOwnerId).toBe("supervisor:gate-resume");
    sqlite.close();
  });
  test("resumes a genuinely-denied detached run (real denyNode: node failed, run waiting-event)", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await insertRealDeniedDetachedRun(adapter, "run-gate-denied");
    // Guard the fixture against silently reverting to an impossible state:
    // a real deny leaves the gate node "failed" and the run "waiting-event".
    // (The old pending-node-only supervisor query dropped exactly this, so a
    // pending-node fixture would have masked the resume gap.)
    expect((await adapter.getNode("run-gate-denied", "review", 0))?.state).toBe("failed");
    expect((await adapter.getRun("run-gate-denied"))?.status).toBe("waiting-event");
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        maxConcurrent: 3,
        supervisorId: "gate-denied-resume",
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 9491;
          },
        },
      }),
    );
    expect(summary.resumedCount).toBe(1);
    expect(resumed).toEqual(["run-gate-denied"]);
    expect(await listEventTypes(adapter, "run-gate-denied")).toContain("RunAutoResumed");
    sqlite.close();
  });
  test("does not resume a waiting-approval run whose gate is still undecided", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await insertGateDecidedRun(adapter, "run-gate-pending", { approvalStatus: "requested" });
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        maxConcurrent: 3,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 9492;
          },
        },
      }),
    );
    expect(summary.resumedCount).toBe(0);
    expect(resumed).toHaveLength(0);
    expect(await listEventTypes(adapter, "run-gate-pending")).not.toContain("RunAutoResumed");
    sqlite.close();
  });
  test("does not resume a waiting-approval gate whose owner pid is still alive", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await insertGateDecidedRun(adapter, "run-gate-live-owner", {
      runtimeOwnerId: `pid:${process.pid}:live-driver`,
    });
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        maxConcurrent: 3,
        deps: {
          now: () => now,
          workflowExists: () => true,
          // real isPidAlive: process.pid is genuinely alive
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 9493;
          },
        },
      }),
    );
    expect(summary.resumedCount).toBe(0);
    expect(resumed).toHaveLength(0);
    expect(await skipReasonFor(adapter, "run-gate-live-owner")).toBe("pid-alive");
    sqlite.close();
  });
  test("rate-limits an approval-decided run behind a stale run when slots are exhausted", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    await adapter.insertRun(runRow("run-stale"));
    await insertApprovalDecidedRun(adapter, "run-approval-rate-limited");
    const summary = await Effect.runPromise(
      supervisorPollEffect({
        adapter,
        staleThresholdMs: 30_000,
        maxConcurrent: 1,
        deps: {
          now: () => now,
          workflowExists: () => true,
          isPidAlive: () => false,
          spawnResumeDetached: (_workflowPath, runId) => {
            resumed.push(runId);
            return 9092;
          },
        },
      }),
    );
    expect(summary.staleCount).toBe(1);
    expect(summary.resumedCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
    expect(resumed).toEqual(["run-stale"]);
    expect(await listEventTypes(adapter, "run-approval-rate-limited")).not.toContain("RunAutoResumed");
    const skip = (await adapter.listEvents("run-approval-rate-limited", -1, 50)).find(
      (event) => event.type === "RunAutoResumeSkipped",
    );
    expect(skip).toBeDefined();
    expect(JSON.parse(skip.payloadJson).reason).toBe("rate-limited");
    sqlite.close();
  });
  test("releases the claim when spawn fails so the next poll retries", async () => {
    const { adapter, sqlite } = createTestDb();
    const resumed = [];
    const original = runRow("run-spawn-fail");
    await adapter.insertRun(original);
    let throwOnSpawn = true;
    const options = {
      adapter,
      staleThresholdMs: 30_000,
      maxConcurrent: 3,
      supervisorId: "spawn-fail",
      deps: {
        now: () => now,
        workflowExists: () => true,
        isPidAlive: () => false,
        spawnResumeDetached: (_workflowPath, runId) => {
          if (throwOnSpawn) {
            throw new Error("spawn boom");
          }
          resumed.push(runId);
          return 9093;
        },
      },
    };
    const first = await Effect.runPromise(supervisorPollEffect(options));
    expect(first.staleCount).toBe(1);
    expect(first.resumedCount).toBe(0);
    expect(first.skippedCount).toBe(1);
    expect(resumed).toHaveLength(0);
    expect(await listEventTypes(adapter, "run-spawn-fail")).not.toContain("RunAutoResumed");
    // Claim must have been rolled back to the pre-claim owner/heartbeat so the
    // run still looks stale and a later poll can re-attempt it.
    const afterFail = await adapter.getRun("run-spawn-fail");
    expect(afterFail?.runtimeOwnerId).toBe(original.runtimeOwnerId);
    expect(afterFail?.heartbeatAtMs).toBe(original.heartbeatAtMs);
    // Second poll with a working spawn must succeed (run was not left stuck).
    throwOnSpawn = false;
    const second = await Effect.runPromise(supervisorPollEffect(options));
    expect(second.resumedCount).toBe(1);
    expect(resumed).toEqual(["run-spawn-fail"]);
    expect(await listEventTypes(adapter, "run-spawn-fail")).toContain("RunAutoResumed");
    sqlite.close();
  });
});
