/** @jsxImportSource smithers-orchestrator */
/**
 * Cross-feature audit lane: RESTARTING A FAILED RUN when the failure came from
 * a <Subflow> child run.
 *
 * A non-technical user only ever says "restart my failed run" to their agent.
 * The shipped restart path is `retryTask(adapter, { runId, nodeId })` followed
 * by `runWorkflow(..., { resume: true })` (that is exactly what
 * `smithers retry-task` does). These tests drive that path against the two
 * ways a run fails:
 *
 *   (a) a top-level compute/agent task that throws  -> control, must work
 *   (b) a <Subflow> node whose CHILD run failed     -> the combo under audit
 *
 * plus the "child parked on a decision, misclassified as failure" case.
 *
 * Harness idioms copied from subflow-childrun-multi-output.e2e.test.jsx,
 * retry-task.e2e.test.jsx and resume-no-time-travel.e2e.test.jsx: temp-dir
 * sqlite via createTestSmithers, scripted in-process agents/compute fns, no
 * network, no paid models, no servers.
 *
 * RED (pinning defects, assert the correct behavior):
 *   - retry-task + resume on a failed <Subflow> node never re-executes the
 *     failed child; the run re-fails instantly on the child's recorded error.
 *   - a child parked on an <Approval> fails the PARENT run instead of parking
 *     it, and the durable error is `{"name":"FiberFailure","message":"An error
 *     has occurred"}` with no mention of the pending decision.
 *   - resuming a child run id with the parent workflow (the only shape
 *     `smithers retry-task` can express for a child run) executes the PARENT
 *     graph inside the child run, spawns a grandchild, and marks the child
 *     "finished" while its own task is still pending.
 *
 * GREEN (regression armor for the paths that DO recover):
 *   - resetting the child's failed node AND the parent's Subflow node, then
 *     resuming the parent.
 *   - replay from the last checkpoint (recovers under a NEW run id).
 *   - retry-task + resume after a human grants the child's approval.
 */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { z } from "zod";
import { Effect } from "effect";
import { Approval, Task, Workflow, approvalDecisionSchema } from "smithers-orchestrator";
import { Subflow } from "@smithers-orchestrator/components/components/index";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { listSnapshots } from "@smithers-orchestrator/time-travel/snapshot";
import { replayFromCheckpoint } from "@smithers-orchestrator/time-travel/replay";
// Relative so the run exercises THIS checkout's engine, not the installed one.
import { runWorkflow } from "../src/engine.js";
import { approveNode } from "../src/approvals.js";
import { retryTask } from "../../time-travel/src/retry-task.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

const TIMEOUT_MS = 60_000;

function buildSmithers() {
  return createTestSmithers({
    childOut: z.object({ value: z.number() }),
    subflowOut: z.object({ value: z.number() }),
    afterOut: z.object({ value: z.number() }),
    gate: approvalDecisionSchema,
  });
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function dumpRun(adapter, runId) {
  const run = await adapter.getRun(runId);
  const nodes = await adapter.listNodes(runId);
  return {
    status: run?.status ?? null,
    errorJson: run?.errorJson ?? null,
    nodes: nodes.map((node) => `${node.nodeId}=${node.state}`),
  };
}

describe("xcombo restart-failed: control (no child run)", () => {
  test(
    "a top-level compute task that throws restarts cleanly with retry-task + resume",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        let calls = 0;
        const workflow = smithers(() => (
          <Workflow name="xcombo-restart-toplevel">
            <Task id="flaky" output={outputs.subflowOut} retries={0}>
              {() => {
                calls += 1;
                if (calls === 1) throw new Error("transient boom");
                return { value: 7 };
              }}
            </Task>
          </Workflow>
        ));
        const runId = "xcombo-restart-toplevel-run";
        const failed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        expect(failed.status).toBe("failed");

        const reset = await retryTask(adapter, { runId, nodeId: "flaky" });
        expect(reset.success).toBe(true);

        const resumed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
        expect(resumed.status).toBe("finished");
        expect(calls).toBe(2);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("xcombo restart-failed: <Subflow> whose child run failed", () => {
  test(
    "retry-task on the failed Subflow node + resume re-executes the child and finishes the run",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        let childCalls = 0;
        const child = smithers(
          () => (
            <Workflow name="xcombo-child">
              <Task id="work" output={outputs.childOut} retries={0}>
                {() => {
                  childCalls += 1;
                  // Transient: the very failure a user restarts a run for.
                  if (childCalls === 1) throw new Error("child transient boom");
                  return { value: 42 };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-parent">
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={0} />
            <Task id="after" output={outputs.afterOut} deps={{ review: outputs.subflowOut }} retries={0}>
              {(deps) => ({ value: deps.review.value + 1 })}
            </Task>
          </Workflow>
        ));
        const runId = "xcombo-restart-subflow-run";
        const failed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(failed.status).toBe("failed");
        expect(childCalls).toBe(1);
        const childRunId = `${runId}:child:review:0`;
        const childBefore = await dumpRun(adapter, childRunId);
        expect(childBefore.status).toBe("failed");

        // === the shipped "restart my failed run" path ===
        const reset = await retryTask(adapter, { runId, nodeId: "review" });
        expect(reset.success).toBe(true);
        expect(reset.resetNodes).toContain("review");

        const resumed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, resume: true }));

        const parentAfter = await dumpRun(adapter, runId);
        const childAfter = await dumpRun(adapter, childRunId);
        const diagnostics = JSON.stringify({ reset, resumed: resumed.status, parentAfter, childAfter, childCalls });

        // Restarting a failed run must actually restart the work: the child
        // re-executes and the parent completes.
        expect(childCalls, `child never re-executed: ${diagnostics}`).toBe(2);
        expect(resumed.status, `run did not recover: ${diagnostics}`).toBe("finished");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "resetting the CHILD run's failed node too is the only recipe that recovers the parent",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        let childCalls = 0;
        const child = smithers(
          () => (
            <Workflow name="xcombo-child-2">
              <Task id="work" output={outputs.childOut} retries={0}>
                {() => {
                  childCalls += 1;
                  if (childCalls === 1) throw new Error("child transient boom");
                  return { value: 42 };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-parent-2">
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={0} />
            <Task id="after" output={outputs.afterOut} deps={{ review: outputs.subflowOut }} retries={0}>
              {(deps) => ({ value: deps.review.value + 1 })}
            </Task>
          </Workflow>
        ));
        const runId = "xcombo-restart-subflow-deep-run";
        const failed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(failed.status).toBe("failed");
        const childRunId = `${runId}:child:review:0`;

        // What an agent would have to figure out on its own: reach INTO the
        // child run and reset its failed node, then reset the parent node.
        const childReset = await retryTask(adapter, { runId: childRunId, nodeId: "work" });
        const parentReset = await retryTask(adapter, { runId, nodeId: "review" });
        const resumed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, resume: true }));
        const diagnostics = JSON.stringify({
          childReset,
          parentReset,
          resumed: resumed.status,
          parentAfter: await dumpRun(adapter, runId),
          childAfter: await dumpRun(adapter, childRunId),
          childCalls,
        });
        expect(childReset.success, diagnostics).toBe(true);
        expect(parentReset.success, diagnostics).toBe(true);
        expect(resumed.status, diagnostics).toBe("finished");
        expect(childCalls, diagnostics).toBe(2);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "replay from the last checkpoint restarts a run whose child failed",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        let childCalls = 0;
        // A scripted agent (not a compute fn): the failure shape a real run has.
        const agent = {
          id: "xcombo-child-agent",
          tools: {},
          async generate() {
            childCalls += 1;
            if (childCalls === 1) throw new Error("child agent transient boom");
            return { text: '{"value":42}', output: { value: 42 } };
          },
        };
        const child = smithers(
          () => (
            <Workflow name="xcombo-child-3">
              <Task id="work" output={outputs.childOut} agent={agent} retries={0}>
                do the child work
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-parent-3">
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={0} />
          </Workflow>
        ));
        const runId = "xcombo-restart-subflow-replay-run";
        const failed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(failed.status).toBe("failed");
        expect(childCalls).toBe(1);

        const snapshots = await listSnapshots(adapter, runId);
        expect(snapshots.length).toBeGreaterThan(0);
        const replay = await replayFromCheckpoint(adapter, {
          parentRunId: runId,
          frameNo: snapshots[snapshots.length - 1].frameNo,
          resetNodes: ["review"],
        });
        const resumed = await Effect.runPromise(
          runWorkflow(parent, { input: {}, runId: replay.runId, resume: true }),
        );
        const diagnostics = JSON.stringify({
          forkedRunId: replay.runId,
          resumed: resumed.status,
          forkedRun: await dumpRun(adapter, replay.runId),
          childCalls,
        });
        expect(resumed.status, diagnostics).toBe("finished");
        expect(childCalls, diagnostics).toBe(2);
        // Replay recovers by forking a NEW run id, so the child identity is
        // new too and re-executes from scratch. Caveat the user lives with:
        // the run id they asked about stays failed forever.
        const forkedChild = await adapter.getRun(`${replay.runId}:child:review:0`);
        expect(forkedChild?.status, diagnostics).toBe("finished");
        expect((await adapter.getRun(runId))?.status, diagnostics).toBe("failed");
        expect((await adapter.getRun(`${runId}:child:review:0`))?.status, diagnostics).toBe("failed");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("xcombo restart-failed: child parked on a human decision", () => {
  test(
    "a child waiting on an approval does not report the parent run as failed",
    async () => {
      const { smithers, outputs, db, dbPath, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        const child = smithers(
          () => (
            <Workflow name="xcombo-approval-child">
              <Approval id="gate" output={outputs.gate} request={{ title: "Ship the child?" }} />
              <Task id="ship" output={outputs.childOut} deps={{ gate: outputs.gate }} retries={0}>
                {() => ({ value: 9 })}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-approval-parent">
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={0} />
          </Workflow>
        ));
        const runId = "xcombo-restart-approval-run";
        const first = await Effect.runPromise(
          runWorkflow(parent, { input: {}, runId, rootDir: dirname(dbPath) }),
        );
        const childRunId = `${runId}:child:review:0`;
        const diagnostics = JSON.stringify({
          parent: await dumpRun(adapter, runId),
          child: await dumpRun(adapter, childRunId),
          pendingApprovals: (await adapter.listAllPendingApprovals()).map((approval) => ({
            runId: approval.runId,
            nodeId: approval.nodeId,
          })),
        });
        // The user's run is blocked on THEIR decision, not broken. Reporting
        // "failed" sends the agent down a restart path instead of asking for
        // the approval that would unblock it.
        expect(first.status, diagnostics).toBe("waiting-approval");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "after the child's approval is granted, retry-task + resume finishes the run",
    async () => {
      const { smithers, outputs, db, dbPath, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        const child = smithers(
          () => (
            <Workflow name="xcombo-approval-child-2">
              <Approval id="gate" output={outputs.gate} request={{ title: "Ship the child?" }} />
              <Task id="ship" output={outputs.childOut} deps={{ gate: outputs.gate }} retries={0}>
                {() => ({ value: 9 })}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-approval-parent-2">
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={0} />
          </Workflow>
        ));
        const runId = "xcombo-restart-approval-resolve-run";
        const first = await Effect.runPromise(
          runWorkflow(parent, { input: {}, runId, rootDir: dirname(dbPath) }),
        );
        const childRunId = `${runId}:child:review:0`;
        const beforeApproval = JSON.stringify({
          first: first.status,
          parent: await dumpRun(adapter, runId),
          child: await dumpRun(adapter, childRunId),
        });
        // The human approves the child's gate.
        await Effect.runPromise(approveNode(adapter, childRunId, "gate", 0, "go ahead", "tester"));
        const reset = await retryTask(adapter, { runId, nodeId: "review" });
        const resumed = await Effect.runPromise(
          runWorkflow(parent, { input: {}, runId, resume: true, rootDir: dirname(dbPath) }),
        );
        const diagnostics = JSON.stringify({
          beforeApproval,
          reset,
          resumed: resumed.status,
          parentAfter: await dumpRun(adapter, runId),
          childAfter: await dumpRun(adapter, childRunId),
        });
        expect(resumed.status, diagnostics).toBe("finished");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("xcombo restart-failed: retrying the CHILD run through the parent workflow", () => {
  test(
    "resuming a child run id with the parent workflow must not execute the parent graph inside the child run",
    async () => {
      // The shipped CLI shape an agent is pushed into: a child run has no
      // workflow file of its own, so `smithers retry-task --runId
      // <parentRunId>:child:<node>:0 --nodeId <childNode> <parentWorkflow>`
      // resets the child node and then resumes the CHILD run id with the
      // PARENT workflow module. Nothing rejects the mismatch.
      const { smithers, outputs, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        let childCalls = 0;
        const child = smithers(
          () => (
            <Workflow name="xcombo-child-4">
              <Task id="work" output={outputs.childOut} retries={0}>
                {() => {
                  childCalls += 1;
                  if (childCalls === 1) throw new Error("child transient boom");
                  return { value: 42 };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-parent-4">
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={0} />
          </Workflow>
        ));
        const runId = "xcombo-restart-child-crossgraph-run";
        const failed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(failed.status).toBe("failed");
        const childRunId = `${runId}:child:review:0`;

        const childReset = await retryTask(adapter, { runId: childRunId, nodeId: "work" });
        expect(childReset.success).toBe(true);
        let threw = null;
        let out = null;
        try {
          out = await Effect.runPromise(runWorkflow(parent, { input: {}, runId: childRunId, resume: true }));
        } catch (error) {
          threw = { name: error?.name, code: error?.code, message: error?.message };
        }
        const childAfter = await dumpRun(adapter, childRunId);
        const grandchild = await adapter.getRun(`${childRunId}:child:review:0`);
        const diagnostics = JSON.stringify({ out, threw, childAfter, grandchild: grandchild?.status ?? null });

        // A workflow that is not the child's own workflow must never drive the
        // child run: either the resume is rejected, or the child's own graph
        // runs. Executing the PARENT graph under the child's run id spawns a
        // grandchild and corrupts the child run's node set.
        expect(childAfter.nodes, diagnostics).not.toContain("review=finished");
        expect(grandchild, diagnostics).toBeUndefined();
        // And the child run must never be reported finished while its own task
        // is still pending — that state makes every later restart a no-op.
        expect({ status: childAfter.status, nodes: childAfter.nodes }, diagnostics).not.toEqual({
          status: "finished",
          nodes: ["review=finished", "work=pending"],
        });
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
