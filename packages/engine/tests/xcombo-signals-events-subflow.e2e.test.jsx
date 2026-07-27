/** @jsxImportSource smithers-orchestrator */
// Cross-feature audit lane: signals / events / observability x child runs
// (<Subflow mode="childRun">). Every test here drives the REAL engine over a
// temp sqlite db with compute tasks only (no model calls), the same harness
// idioms as wait-for-event-correlation.e2e.test.jsx and
// dynamic-workflow-file-subflow.e2e.test.jsx.
//
// The combination under test: a durable external wait (<WaitForEvent> /
// <Signal>) that lives INSIDE a child workflow. Single-feature behaviour is
// covered elsewhere; the pins below are the combination defects.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Subflow, Task, WaitForEvent, Workflow, runWorkflow, signalRun, SmithersDb } from "smithers-orchestrator";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { diagnoseRunEffect } from "../../../apps/cli/src/why-diagnosis.js";
import { Effect } from "effect";

const END_TO_END_TIMEOUT_MS = 90_000;

function buildSmithers() {
  return createTestSmithers({
    childOut: z.object({ ok: z.boolean() }),
    subOut: z.object({ ok: z.boolean() }),
    warmupOut: z.object({ ok: z.boolean() }),
  });
}

/**
 * A parent whose only node is a childRun <Subflow>, and a child whose only
 * node is a durable event wait. The child shares the parent's db so the test
 * can read both runs' rows, nodes, events and signals from one place.
 *
 * @param {ReturnType<typeof buildSmithers>} api
 * @param {{ retries?: number; parentName?: string }} [opts]
 */
function buildParentWithWaitingChild(api, opts = {}) {
  const { smithers, outputs } = api;
  const child = smithers(
    () => (
      <Workflow name="child-waits-for-ops">
        <WaitForEvent id="await-ops" event="ops.ready" output={outputs.childOut} />
      </Workflow>
    ),
    { output: outputs.childOut },
  );
  const parent = smithers(() => (
    <Workflow name={opts.parentName ?? "parent-of-waiting-child"}>
      <Subflow
        id="sub"
        workflow={child}
        output={outputs.subOut}
        {...(opts.retries === undefined ? {} : { retries: opts.retries })}
      />
    </Workflow>
  ));
  return { child, parent };
}

describe("child run parked on <WaitForEvent> through the real engine", () => {
  test(
    "a child parked on an event parks the parent instead of failing it",
    async () => {
      const api = buildSmithers();
      const { db, cleanup } = api;
      try {
        const { parent } = buildParentWithWaitingChild(api, { retries: 0 });
        const runId = "xcombo-park-parent";
        const childRunId = `${runId}:child:sub:0`;
        const result = await Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        const adapter = new SmithersDb(db);
        // The child really did park durably: its run row and its wait node are
        // both `waiting-event`, exactly like a top-level parked run.
        const childRun = await Effect.runPromise(adapter.getRun(childRunId));
        expect(childRun?.status).toBe("waiting-event");
        expect((await Effect.runPromise(adapter.getNode(childRunId, "await-ops", 0)))?.state).toBe("waiting-event");
        // A durable suspend inside a child is not a failure: the parent must
        // park too (resumable), the way it parks for its own <WaitForEvent>.
        // Today attachSubflowComputeFns throws WORKFLOW_EXECUTION_FAILED for
        // any non-"finished" child status, so the parent run FAILS and the
        // child is orphaned at `waiting-event` with nothing able to resume it.
        expect(result.status).toBe("waiting-event");
        expect((await Effect.runPromise(adapter.getNode(runId, "sub", 0)))?.state).not.toBe("failed");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "the parent does not burn retries in a busy-spin while the child waits for its event",
    async () => {
      const api = buildSmithers();
      const { db, cleanup } = api;
      try {
        // No `retries` prop: the shipped default is infinite retries.
        const { parent } = buildParentWithWaitingChild(api, { parentName: "parent-default-retries" });
        const runId = "xcombo-retry-spin";
        const controller = new AbortController();
        const runPromise = Effect.runPromise(runWorkflow(parent, { input: {}, runId, signal: controller.signal }));
        await sleep(6_000);
        controller.abort();
        await runPromise.catch(() => undefined);
        const adapter = new SmithersDb(db);
        const attempts = await Effect.runPromise(adapter.listAttempts(runId, "sub", 0));
        // A child that is durably waiting is not a retryable error: the parent
        // should record ONE parked attempt and rest. Today every retry
        // re-resumes the child, gets `waiting-event` back, treats it as a
        // failure and schedules another attempt forever, so the run never
        // reaches rest and never becomes resumable.
        expect(attempts.map((attempt) => attempt.state)).toEqual(["waiting-event"]);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "a signal addressed to the parent run id reaches a waiter inside its child run",
    async () => {
      const api = buildSmithers();
      const { tables, db, cleanup } = api;
      try {
        const { parent } = buildParentWithWaitingChild(api, { retries: 0 });
        const runId = "xcombo-parent-addressed";
        const first = await Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(first.runId).toBe(runId);
        const adapter = new SmithersDb(db);
        // The parent run id is the ONLY id a user or their agent has: the docs
        // (`smithers signal RUN_ID <signal-name>`, Gateway submitSignal) never
        // mention that a waiter living inside a childRun subflow is addressed
        // by the undocumented derived id `<parent>:child:<nodeId>:<iteration>`.
        const delivered = await Effect.runPromise(
          signalRun(adapter, runId, "ops.ready", { ok: true }, { receivedBy: "tester" }),
        );
        // Accepted with no error and no hint that nothing is listening.
        expect(delivered.signalName).toBe("ops.ready");
        await Effect.runPromise(runWorkflow(parent, { input: {}, runId, resume: true })).catch(() => undefined);
        // Either the signal must fan out to the run's child waiters, or
        // signalRun must refuse it and name the run id that owns the waiter.
        // Today it is silently dropped: the child stays parked forever.
        expect(await db.select().from(tables.childOut)).toEqual([
          expect.objectContaining({ nodeId: "await-ops", ok: true }),
        ]);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "a signal that arrives before the child's waiter parks is not silently dropped",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = buildSmithers();
      try {
        // The child works for a moment BEFORE it starts waiting - the normal
        // shape of a child workflow (do something, then wait for the world).
        const child = smithers(
          () => (
            <Workflow name="child-works-then-waits">
              <Task id="warmup" output={outputs.warmupOut}>
                {async () => {
                  await sleep(2_000);
                  return { ok: true };
                }}
              </Task>
              <WaitForEvent id="await-ops" event="ops.ready" output={outputs.childOut} dependsOn={["warmup"]} />
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="parent-early-signal">
            <Subflow id="sub" workflow={child} output={outputs.subOut} retries={0} />
          </Workflow>
        ));
        const runId = "xcombo-early-signal";
        const childRunId = `${runId}:child:sub:0`;
        const adapter = new SmithersDb(db);
        // Before the parent launches the child there is nothing to arm at all:
        // signalRun rejects the derived child run id outright, so an agent
        // cannot pre-deliver the event.
        const preArm = await Effect.runPromise(
          signalRun(adapter, childRunId, "ops.ready", { ok: true }),
        ).then(
          () => null,
          (error) => String(error?.message ?? error),
        );
        expect(preArm).toContain("Run not found");
        const runPromise = Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        // Deliver the event the instant the child run becomes addressable -
        // still inside its warmup task, before the waiter parks.
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if (await Effect.runPromise(adapter.getRun(childRunId))) break;
          await sleep(25);
        }
        await Effect.runPromise(signalRun(adapter, childRunId, "ops.ready", { ok: true }, { receivedBy: "tester" }));
        await runPromise.catch(() => undefined);
        expect((await Effect.runPromise(adapter.getNode(childRunId, "await-ops", 0)))?.state).toBe("waiting-event");
        // Resume the child (the only recovery path that exists today).
        const resumed = await Effect.runPromise(
          runWorkflow(child, { input: {}, runId: childRunId, resume: true, parentRunId: runId }),
        );
        // The signal row is durably stored against the child run - it is the
        // matching that discards it, not the delivery.
        expect(await Effect.runPromise(adapter.listSignals(childRunId, {}))).toHaveLength(1);
        // A durable signal accepted by the run must never evaporate:
        // bridgeSignalResolve only resolves nodes ALREADY in `waiting-event`,
        // and the fallback sync filters stored signals by
        // `received_at_ms >= attempt.startedAtMs`, so an event that lands
        // before the waiter registers is lost forever with no error.
        expect(resumed.status).toBe("finished");
        expect(await db.select().from(tables.childOut)).toHaveLength(1);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "the parent's event stream surfaces its child run",
    async () => {
      const api = buildSmithers();
      const { db, cleanup } = api;
      try {
        const { parent } = buildParentWithWaitingChild(api, { retries: 0 });
        const runId = "xcombo-parent-events";
        const childRunId = `${runId}:child:sub:0`;
        await Effect.runPromise(runWorkflow(parent, { input: {}, runId })).catch(() => undefined);
        const adapter = new SmithersDb(db);
        const parentEvents = await Effect.runPromise(adapter.listEvents(runId, -1, 500));
        const childEvents = await Effect.runPromise(adapter.listEvents(childRunId, -1, 500));
        // The child logs its own lifecycle under its own run id...
        expect(childEvents.map((event) => event.type)).toContain("RunStarted");
        // ...but nothing in the parent's stream references the child run, so
        // `get_run_events(parentRunId)` (and `smithers events`, and the run
        // UI timeline) cannot show the child's work, nor even hand an agent
        // the child run id to pivot to. The parent only sees NodeStarted /
        // NodeFailed for the subflow node itself.
        const mentionsChild = parentEvents.filter((event) => JSON.stringify(event).includes(childRunId));
        expect(mentionsChild.length).toBeGreaterThan(0);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "why/explain on the parent names the child's event wait as the cause",
    async () => {
      const api = buildSmithers();
      const { db, cleanup } = api;
      try {
        const { parent } = buildParentWithWaitingChild(api, { retries: 0 });
        const runId = "xcombo-explain";
        const childRunId = `${runId}:child:sub:0`;
        await Effect.runPromise(runWorkflow(parent, { input: {}, runId })).catch(() => undefined);
        const adapter = new SmithersDb(db);
        const diagnosis = await Effect.runPromise(diagnoseRunEffect(adapter, runId));
        // Today: a single "retries-exhausted" blocker whose reason is
        // "All retries exhausted. Last error: FiberFailure: An error has
        // occurred" and whose unblocker (`smithers up ... --resume true`)
        // provably does not unblock anything. The real cause - a child run
        // parked on signal 'ops.ready' - appears nowhere, so an agent cannot
        // answer "what is my run waiting for?".
        const rendered = JSON.stringify(diagnosis);
        expect(rendered.includes("ops.ready") || rendered.includes(childRunId)).toBe(true);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "launch attribution carries from the parent run to its subflow child run",
    async () => {
      const api = buildSmithers();
      const { db, cleanup } = api;
      try {
        const { parent } = buildParentWithWaitingChild(api, { retries: 0 });
        const runId = "xcombo-startedby";
        const childRunId = `${runId}:child:sub:0`;
        const startedBy = { harness: "claude", sessionId: "sess-xcombo", prompt: "watch the deploy" };
        await Effect.runPromise(runWorkflow(parent, { input: {}, runId, startedBy })).catch(() => undefined);
        const adapter = new SmithersDb(db);
        const parentRun = await Effect.runPromise(adapter.getRun(runId));
        expect(JSON.parse(parentRun?.configJson ?? "{}").startedBy).toEqual(startedBy);
        const childRun = await Effect.runPromise(adapter.getRun(childRunId));
        // A child run shows up in list_runs / `smithers ps` next to its
        // parent. Attribution documented as carrying to continue-as-new child
        // runs must carry here too, otherwise "which runs did I start?" and
        // per-harness accounting silently miss every subflow child.
        expect(JSON.parse(childRun?.configJson ?? "{}").startedBy).toEqual(startedBy);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "regression armor: the orphaned child run can still be resumed standalone once its own run id gets the signal",
    async () => {
      const api = buildSmithers();
      const { child, parent } = buildParentWithWaitingChild(api, { retries: 0 });
      const { tables, db, cleanup } = api;
      try {
        const runId = "xcombo-standalone-resume";
        const childRunId = `${runId}:child:sub:0`;
        await Effect.runPromise(runWorkflow(parent, { input: {}, runId })).catch(() => undefined);
        const adapter = new SmithersDb(db);
        // The ONLY working delivery today: the derived child run id, after the
        // waiter has parked, resumed as its own run.
        await Effect.runPromise(signalRun(adapter, childRunId, "ops.ready", { ok: true }));
        const resumed = await Effect.runPromise(
          runWorkflow(child, { input: {}, runId: childRunId, resume: true, parentRunId: runId }),
        );
        expect(resumed.status).toBe("finished");
        expect(await db.select().from(tables.childOut)).toEqual([
          expect.objectContaining({ runId: childRunId, nodeId: "await-ops", ok: true }),
        ]);
        // The parent can now resume the parked subflow and preserve the
        // completed child's result instead of treating the suspension as a
        // terminal failure.
        const parentAfter = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, resume: true })).catch(
          () => ({ status: "failed" }),
        );
        expect(parentAfter.status).toBe("finished");
        expect(await db.select().from(tables.subOut)).toHaveLength(1);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
