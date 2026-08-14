/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Task, Workflow } from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { withTaskRuntime } from "@smthrs/driver/task-runtime";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { __childWorkflowInternals, executeChildWorkflow } from "../src/child-workflow.js";

const END_TO_END_TIMEOUT_MS = 30_000;
// The deterministic idempotency key for makeRuntime()'s identity below:
// parentRunId "parent-run", stepId "step", iteration 2.
const CHILD_RUN_ID = "parent-run:child:step:2";
// A pid far above any real one on macOS/Linux, so it always reads as dead.
const DEAD_PID = 2_000_000_000;

function buildSmithers() {
  return createTestSmithers({
    childOut: z.object({ value: z.number() }),
    grandchildOut: z.object({ value: z.number() }),
  });
}

function makeRuntime(overrides = {}) {
  return {
    runId: "parent-run",
    stepId: "step",
    attempt: 1,
    iteration: 2,
    signal: new AbortController().signal,
    db: null,
    heartbeat: () => {},
    lastHeartbeat: null,
    ...overrides,
  };
}

/**
 * The run row a live detached owner would hold: fresh heartbeat, live pid.
 * @param {Record<string, unknown>} [overrides]
 */
function liveChildRunRow(overrides = {}) {
  return {
    runId: CHILD_RUN_ID,
    parentRunId: "parent-run",
    workflowName: "workflow",
    workflowPath: null,
    workflowHash: null,
    status: "running",
    createdAtMs: Date.now(),
    startedAtMs: Date.now(),
    finishedAtMs: null,
    heartbeatAtMs: Date.now(),
    runtimeOwnerId: `pid:${process.pid}`,
    cancelRequestedAtMs: null,
    hijackRequestedAtMs: null,
    hijackTarget: null,
    vcsType: null,
    vcsRoot: null,
    vcsRevision: null,
    errorJson: null,
    configJson: null,
    ...overrides,
  };
}

describe("child fan-out prefer-resume identity", () => {
  test("classifies live, stale, and settled child runs", () => {
    const { isChildRunLiveElsewhere } = __childWorkflowInternals;
    const now = Date.now();
    expect(
      isChildRunLiveElsewhere(
        {
          status: "running",
          heartbeatAtMs: now - 1_000,
          runtimeOwnerId: `pid:${DEAD_PID}`,
        },
        now,
      ),
    ).toBe(true);
    expect(
      isChildRunLiveElsewhere(
        {
          status: "running",
          heartbeatAtMs: now - 120_000,
          runtimeOwnerId: `pid:${process.pid}`,
        },
        now,
      ),
    ).toBe(true);
    expect(
      isChildRunLiveElsewhere(
        {
          status: "running",
          heartbeatAtMs: now - 120_000,
          runtimeOwnerId: `pid:${DEAD_PID}`,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isChildRunLiveElsewhere(
        {
          status: "finished",
          heartbeatAtMs: now,
          runtimeOwnerId: `pid:${process.pid}`,
        },
        now,
      ),
    ).toBe(false);
    expect(isChildRunLiveElsewhere(undefined, now)).toBe(false);
  });
});

describe("child fan-out prefer-resume execution", () => {
  test(
    "a parent restart preserves a finished child's output and terminal state without re-executing it",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        let executions = 0;
        const childWorkflow = smithers(
          () => (
            <Workflow name="prefer-resume-finished">
              <Task id="produce" output={outputs.childOut}>
                {() => {
                  executions += 1;
                  return { value: 41 + executions };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        ensureSmithersTables(childWorkflow.db);
        const adapter = new SmithersDb(db);

        const first = await withTaskRuntime(makeRuntime({ db }), () =>
          executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
        );
        expect(first.runId).toBe(CHILD_RUN_ID);
        expect(first.status).toBe("finished");
        expect(first.output).toMatchObject({ value: 42 });
        expect(executions).toBe(1);
        const runAfterFirst = await adapter.getRun(CHILD_RUN_ID);
        expect(runAfterFirst?.status).toBe("finished");

        // Crash/restart: the orchestrator relaunches and re-runs the same
        // fan-out step — same parent run, step, and iteration recompute the
        // same idempotency key, so the finished child is rediscovered.
        const second = await withTaskRuntime(makeRuntime({ db }), () =>
          executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
        );
        expect(second.runId).toBe(CHILD_RUN_ID);
        expect(second.status).toBe("finished");
        expect(second.output).toMatchObject({ value: 42 });
        expect(executions).toBe(1);
        const runAfterSecond = await adapter.getRun(CHILD_RUN_ID);
        expect(runAfterSecond?.status).toBe("finished");
        expect(runAfterSecond?.finishedAtMs).toBe(runAfterFirst?.finishedAtMs);
        const runs = await adapter.listRuns(100);
        expect(runs.filter((r) => r.runId === CHILD_RUN_ID).length).toBe(1);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "a child live in another process is attached to, not double-launched, and its output is preserved",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = buildSmithers();
      try {
        let executions = 0;
        const childWorkflow = smithers(
          () => (
            <Workflow name="prefer-resume-attach">
              <Task id="produce" output={outputs.childOut}>
                {() => {
                  executions += 1;
                  return { value: -1 };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        ensureSmithersTables(childWorkflow.db);
        const adapter = new SmithersDb(db);
        await adapter.insertRun(liveChildRunRow());

        let settled = false;
        const pending = withTaskRuntime(makeRuntime({ db }), () =>
          executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
        );
        const observed = pending.then((result) => {
          settled = true;
          return result;
        });
        await sleep(700);
        // Still attached to the in-flight child: no local duplicate engine.
        expect(settled).toBe(false);
        expect(executions).toBe(0);

        // The remote owner finishes the child and records its output.
        await db.insert(tables.childOut).values({
          runId: CHILD_RUN_ID,
          nodeId: "produce",
          iteration: 0,
          value: 7,
        });
        await adapter.updateRun(CHILD_RUN_ID, {
          status: "finished",
          finishedAtMs: Date.now(),
          heartbeatAtMs: null,
          runtimeOwnerId: null,
        });

        const result = await observed;
        expect(result).toEqual({
          runId: CHILD_RUN_ID,
          status: "finished",
          output: { value: 7 },
        });
        expect(executions).toBe(0);
        const runs = await adapter.listRuns(100);
        expect(runs.filter((r) => r.runId === CHILD_RUN_ID).length).toBe(1);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "attaching preserves a remote terminal failure instead of silently relaunching",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        let executions = 0;
        const childWorkflow = smithers(
          () => (
            <Workflow name="prefer-resume-remote-failure">
              <Task id="produce" output={outputs.childOut}>
                {() => {
                  executions += 1;
                  return { value: -1 };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        ensureSmithersTables(childWorkflow.db);
        const adapter = new SmithersDb(db);
        await adapter.insertRun(liveChildRunRow());

        const pending = withTaskRuntime(makeRuntime({ db }), () =>
          executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
        );
        await sleep(300);
        await adapter.updateRun(CHILD_RUN_ID, {
          status: "failed",
          finishedAtMs: Date.now(),
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          errorJson: JSON.stringify({ message: "remote child failed" }),
        });

        const result = await pending;
        expect(result.runId).toBe(CHILD_RUN_ID);
        expect(result.status).toBe("failed");
        expect(executions).toBe(0);
        const run = await adapter.getRun(CHILD_RUN_ID);
        expect(run?.status).toBe("failed");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "a parent retry resumes the same failed child, preserving its terminal state without a duplicate",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        let executions = 0;
        const childWorkflow = smithers(
          () => (
            <Workflow name="prefer-resume-retry">
              <Task id="produce" output={outputs.childOut} noRetry>
                {() => {
                  executions += 1;
                  throw new Error("child attempt fails");
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        ensureSmithersTables(childWorkflow.db);
        const adapter = new SmithersDb(db);

        const first = await withTaskRuntime(makeRuntime({ db }), () =>
          executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
        );
        expect(first.runId).toBe(CHILD_RUN_ID);
        expect(first.status).toBe("failed");
        expect(executions).toBe(1);

        // The parent task retries: the same identity resumes the failed
        // child run durably instead of fanning out a second child. The
        // noRetry attempt budget is durably exhausted, so the resume
        // replays the recorded failure rather than re-executing the task.
        const second = await withTaskRuntime(makeRuntime({ db }), () =>
          executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
        );
        expect(second.runId).toBe(CHILD_RUN_ID);
        expect(second.status).toBe("failed");
        expect(executions).toBe(1);
        const runs = await adapter.listRuns(100);
        expect(runs.filter((r) => r.runId === CHILD_RUN_ID).length).toBe(1);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "a stale abandoned child (crashed owner) is resumed in place, not duplicated",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        let executions = 0;
        const childWorkflow = smithers(
          () => (
            <Workflow name="prefer-resume-stale">
              <Task id="produce" output={outputs.childOut}>
                {() => {
                  executions += 1;
                  return { value: 5 };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        ensureSmithersTables(childWorkflow.db);
        const adapter = new SmithersDb(db);

        const first = await withTaskRuntime(makeRuntime({ db }), () =>
          executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
        );
        expect(first.status).toBe("finished");
        expect(executions).toBe(1);

        // Simulate the child's owner crashing mid-flight: running status,
        // stale heartbeat, dead pid — abandoned, so prefer-resume takes it
        // over durably instead of attaching forever or duplicating it.
        await adapter.updateRun(CHILD_RUN_ID, {
          status: "running",
          finishedAtMs: null,
          heartbeatAtMs: Date.now() - 120_000,
          runtimeOwnerId: `pid:${DEAD_PID}`,
        });

        const second = await withTaskRuntime(makeRuntime({ db }), () =>
          executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
        );
        expect(second.runId).toBe(CHILD_RUN_ID);
        expect(second.status).toBe("finished");
        expect(second.output).toMatchObject({ value: 5 });
        // The finished task replays from its recorded node state.
        expect(executions).toBe(1);
        const runs = await adapter.listRuns(100);
        expect(runs.filter((r) => r.runId === CHILD_RUN_ID).length).toBe(1);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "nested fan-out composes stable identities and survives a restart without duplicate grandchildren",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        let childExecutions = 0;
        let grandchildExecutions = 0;
        const grandchildWorkflow = smithers(
          () => (
            <Workflow name="prefer-resume-grandchild">
              <Task id="deep" output={outputs.grandchildOut}>
                {() => {
                  grandchildExecutions += 1;
                  return { value: 10 };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.grandchildOut },
        );
        const childWorkflow = smithers(
          () => (
            <Workflow name="prefer-resume-nested">
              <Task id="spawn" output={outputs.childOut}>
                {async () => {
                  childExecutions += 1;
                  const grand = await executeChildWorkflow(grandchildWorkflow, {
                    workflow: grandchildWorkflow,
                  });
                  if (grand.status !== "finished") {
                    throw new Error(`grandchild failed with status ${grand.status}`);
                  }
                  return { value: grand.output.value + 1 };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        ensureSmithersTables(childWorkflow.db);
        const adapter = new SmithersDb(db);
        const grandchildRunId = `${CHILD_RUN_ID}:child:spawn:0`;

        const first = await withTaskRuntime(makeRuntime({ db }), () =>
          executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
        );
        expect(first.runId).toBe(CHILD_RUN_ID);
        expect(first.status).toBe("finished");
        expect(first.output).toMatchObject({ value: 11 });
        expect(childExecutions).toBe(1);
        expect(grandchildExecutions).toBe(1);
        const grandchildRun = await adapter.getRun(grandchildRunId);
        expect(grandchildRun?.status).toBe("finished");
        expect(grandchildRun?.parentRunId).toBe(CHILD_RUN_ID);

        // Restart the whole fan-out: neither the child nor the grandchild
        // is launched again, and both preserved outputs come back.
        const second = await withTaskRuntime(makeRuntime({ db }), () =>
          executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
        );
        expect(second.runId).toBe(CHILD_RUN_ID);
        expect(second.status).toBe("finished");
        expect(second.output).toMatchObject({ value: 11 });
        expect(childExecutions).toBe(1);
        expect(grandchildExecutions).toBe(1);
        const runs = await adapter.listRuns(100);
        expect(runs.filter((r) => r.runId === CHILD_RUN_ID).length).toBe(1);
        expect(runs.filter((r) => r.runId === grandchildRunId).length).toBe(1);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
