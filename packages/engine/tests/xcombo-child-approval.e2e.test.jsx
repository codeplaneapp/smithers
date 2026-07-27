/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { z } from "zod";
import { Approval, Sequence, Task, Workflow, runWorkflow, approvalDecisionSchema } from "smithers-orchestrator";
import { Subflow } from "@smithers-orchestrator/components/components/index";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { approveNode, denyNode } from "../src/approvals.js";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";

/**
 * COMBO UNDER TEST: <Subflow mode="childRun"> whose CHILD workflow contains a
 * human decision gate (<Approval>).
 *
 * Both features work alone: approval-gate-flow.e2e.test.jsx pins the gate, and
 * subflow-childrun-multi-output.e2e.test.jsx pins childRun fan-out. Combined,
 * the child's "please decide" is treated as a child-run FAILURE by
 * packages/engine/src/task-compute-fns.js (and the identical throw in
 * packages/graph/src/dom/extract.js), which reject every child status that is
 * not exactly "finished". A human question is a suspension, not a failure.
 *
 * Every test below asserts the CORRECT behavior, so the file is red today and
 * turns green when child suspension bubbles into the parent as a park.
 */

const END_TO_END_TIMEOUT_MS = 60_000;

/**
 * @param {any} workflow
 * @param {string} dbPath
 * @param {any} opts
 */
function runInTestRoot(workflow, dbPath, opts) {
  return Effect.runPromise(
    runWorkflow(workflow, {
      ...opts,
      rootDir: dirname(dbPath),
    }),
  );
}

function buildSmithers() {
  return createTestSmithers({
    approval: approvalDecisionSchema,
    childResult: z.object({ shipped: z.boolean() }),
    subflowResult: z.object({ shipped: z.boolean() }),
    announcement: z.object({ headline: z.string() }),
  });
}

/**
 * A child workflow that parks on a real human decision before producing its
 * declared output — the shape a user builds for "ask me before you ship".
 *
 * @param {ReturnType<typeof buildSmithers>} harness
 * @param {{ timeoutMs?: number }} [gateOpts]
 */
function buildChildWithGate(harness, gateOpts = {}) {
  const { smithers, outputs } = harness;
  return smithers(
    () => (
      <Workflow name="child-with-gate">
        <Sequence>
          <Approval
            id="child-gate"
            output={outputs.approval}
            request={{ title: "Ship the child?" }}
            onDeny="fail"
            timeoutMs={gateOpts.timeoutMs}
          />
          <Task
            id="child-final"
            output={outputs.childResult}
            deps={{ gate: outputs.approval }}
            needs={{ gate: "child-gate" }}
          >
            {(/** @type {any} */ deps) => ({ shipped: Boolean(deps.gate.approved) })}
          </Task>
        </Sequence>
      </Workflow>
    ),
    { output: outputs.childResult },
  );
}

/**
 * @param {ReturnType<typeof buildSmithers>} harness
 * @param {any} childWorkflow
 * @param {{ retries?: number }} [subflowOpts]
 */
function buildParent(harness, childWorkflow, subflowOpts = {}) {
  const { smithers, outputs } = harness;
  return smithers(() => (
    <Workflow name="parent-awaiting-child-approval">
      <Subflow
        id="review"
        mode="childRun"
        output={outputs.subflowResult}
        workflow={childWorkflow}
        input={{ topic: "nested approval" }}
        retries={subflowOpts.retries}
      />
      <Task id="announce" output={outputs.announcement} deps={{ review: outputs.subflowResult }}>
        {(/** @type {any} */ deps) => ({ headline: `child shipped=${deps.review.shipped}` })}
      </Task>
    </Workflow>
  ));
}

/**
 * Poll the workspace-wide pending-approval listing until the child's gate
 * shows up, and return the child run id that owns it.
 *
 * @param {SmithersDb} adapter
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
async function waitForChildGate(adapter, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await adapter.listAllPendingApprovals();
    const match = pending.find((approval) => approval.nodeId === "child-gate");
    if (match) return match.runId;
    await sleep(100);
  }
  throw new Error("child gate never became pending");
}

describe("<Subflow childRun> + a human decision gate inside the child", () => {
  test(
    "a child parked on an <Approval> parks the PARENT as waiting-approval, it never fails it",
    async () => {
      const harness = buildSmithers();
      const { db, dbPath, cleanup } = harness;
      try {
        const childWorkflow = buildChildWithGate(harness);
        // retries={0} bounds the observation. Under the default (Infinity)
        // budget the same defect turns the parent into an endless retry storm
        // instead of a park — pinned separately below.
        const parentWorkflow = buildParent(harness, childWorkflow, { retries: 0 });
        const parent = await runInTestRoot(parentWorkflow, dbPath, { input: {} });
        const adapter = new SmithersDb(db);
        const childRun = await adapter.getLatestChildRun(parent.runId);
        // The child really parked on the gate with a decidable request.
        expect(childRun?.status).toBe("waiting-approval");
        const childApproval = await adapter.getApproval(/** @type {string} */ (childRun?.runId), "child-gate", 0);
        expect(childApproval?.status).toBe("requested");
        // THE REPORTED DEFECT: the parent is "failed". A child asking its human
        // a question must park the parent so the answer can unblock the run.
        expect(parent.status).toBe("waiting-approval");
        const parentRun = await adapter.getRun(parent.runId);
        expect(parentRun?.status).toBe("waiting-approval");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "answering the child's question and resuming the PARENT completes the whole tree",
    async () => {
      const harness = buildSmithers();
      const { db, dbPath, tables, cleanup } = harness;
      try {
        const childWorkflow = buildChildWithGate(harness);
        const parentWorkflow = buildParent(harness, childWorkflow, { retries: 0 });
        const first = await runInTestRoot(parentWorkflow, dbPath, { input: {} });
        const adapter = new SmithersDb(db);
        const childRun = await adapter.getLatestChildRun(first.runId);
        const childRunId = /** @type {string} */ (childRun?.runId);
        // Answer it exactly the way the shipped surfaces do: MCP
        // resolve_approval and `smithers approve` both call approveNode.
        await Effect.runPromise(approveNode(adapter, childRunId, "child-gate", 0, "ship it", "will"));
        const resumed = await runInTestRoot(parentWorkflow, dbPath, {
          input: {},
          runId: first.runId,
          resume: true,
        });
        expect(resumed.status).toBe("finished");
        expect((await adapter.getRun(childRunId))?.status).toBe("finished");
        expect(await db.select().from(tables.subflowResult)).toEqual([
          expect.objectContaining({ runId: first.runId, nodeId: "review", shipped: true }),
        ]);
        expect(await db.select().from(tables.announcement)).toEqual([
          expect.objectContaining({ runId: first.runId, nodeId: "announce", headline: "child shipped=true" }),
        ]);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "an answered child gate is consumed by the child instead of stranding it",
    async () => {
      const harness = buildSmithers();
      const { db, dbPath, tables, cleanup } = harness;
      try {
        const childWorkflow = buildChildWithGate(harness);
        // Default retry budget: exactly what a user writes.
        const parentWorkflow = buildParent(harness, childWorkflow);
        const adapter = new SmithersDb(db);
        const first = await runInTestRoot(parentWorkflow, dbPath, { input: {} });
        const childRunId = await waitForChildGate(adapter);
        await Effect.runPromise(approveNode(adapter, childRunId, "child-gate", 0, "ship it", "will"));
        await runInTestRoot(parentWorkflow, dbPath, {
          input: {},
          runId: first.runId,
          resume: true,
        });
        const parentRunId = childRunId.split(":child:")[0];
        const childNodes = await adapter.listNodes(childRunId);
        const subflowAttempts = await adapter.listAttempts(parentRunId, "review", 0);
        // The human answered; the child must move past its own gate. Today the
        // suspended child is never re-entered (its bridge instance stays
        // suspended), so the answered gate is stranded forever while the
        // parent burns retries against it.
        expect({
          childRunStatus: (await adapter.getRun(childRunId))?.status,
          childGateState: childNodes.find((node) => node.nodeId === "child-gate")?.state,
          childFinalRows: (await db.select().from(tables.childResult)).length,
          subflowAttempts: subflowAttempts.length,
        }).toEqual({
          childRunStatus: "finished",
          childGateState: "finished",
          childFinalRows: 1,
          subflowAttempts: 2,
        });
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "denying the child's question drives the parent to a terminal state that explains the denial",
    async () => {
      const harness = buildSmithers();
      const { db, dbPath, cleanup } = harness;
      try {
        const childWorkflow = buildChildWithGate(harness);
        const parentWorkflow = buildParent(harness, childWorkflow);
        const adapter = new SmithersDb(db);
        const first = await runInTestRoot(parentWorkflow, dbPath, { input: {} });
        const childRunId = await waitForChildGate(adapter);
        await Effect.runPromise(denyNode(adapter, childRunId, "child-gate", 0, "not this quarter", "will"));
        const parent = await runInTestRoot(parentWorkflow, dbPath, {
          input: {},
          runId: first.runId,
          resume: true,
        });
        const parentRunId = childRunId.split(":child:")[0];
        const parentRun = await adapter.getRun(parentRunId);
        const attempts = await adapter.listAttempts(parentRunId, "review", 0);
        const recorded = JSON.stringify({
          runError: parentRun?.errorJson ?? null,
          attemptErrors: attempts.map((attempt) => attempt.errorJson ?? null),
        });
        // A denial is a decision, not an opaque crash. The parent must settle
        // on its own (no external abort needed) and its recorded error must
        // name the denial so the user knows why their run stopped.
        expect({
          parentStatus: parent.status,
          errorNamesDenial: /deni/i.test(recorded),
          errorCarriesNote: recorded.includes("not this quarter"),
        }).toEqual({
          parentStatus: "failed",
          errorNamesDenial: true,
          errorCarriesNote: true,
        });
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "the parent's recorded failure names the child run and the decision it is waiting on",
    async () => {
      const harness = buildSmithers();
      const { db, dbPath, cleanup } = harness;
      try {
        const childWorkflow = buildChildWithGate(harness);
        const parentWorkflow = buildParent(harness, childWorkflow, { retries: 0 });
        const parent = await runInTestRoot(parentWorkflow, dbPath, { input: {} });
        const adapter = new SmithersDb(db);
        const childRun = await adapter.getLatestChildRun(parent.runId);
        const attempts = await adapter.listAttempts(parent.runId, "review", 0);
        const failedEvents = await adapter.listEventsByType(parent.runId, "NodeFailed");
        const recorded = JSON.stringify({
          attemptErrors: attempts.map((attempt) => attempt.errorJson ?? null),
          nodeFailed: failedEvents.map((event) => event.payloadJson ?? null),
          runError: (await adapter.getRun(parent.runId))?.errorJson ?? null,
        });
        // Whatever state the parent lands in, an operator must be able to read
        // WHY from the parent alone: the child run id and the fact that it is
        // blocked on an approval. Today every layer records the opaque
        // FiberFailure "An error has occurred" — the
        // WORKFLOW_EXECUTION_FAILED / "failed with status waiting-approval"
        // detail from task-compute-fns.js is swallowed entirely.
        expect({
          mentionsChildRun: recorded.includes(/** @type {string} */ (childRun?.runId)),
          mentionsApprovalWait: /waiting-approval|approval/i.test(recorded),
        }).toEqual({ mentionsChildRun: true, mentionsApprovalWait: true });
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "the parked child's question is discoverable from the PARENT run id",
    async () => {
      const harness = buildSmithers();
      const { db, dbPath, cleanup } = harness;
      try {
        const childWorkflow = buildChildWithGate(harness);
        const parentWorkflow = buildParent(harness, childWorkflow, { retries: 0 });
        const parent = await runInTestRoot(parentWorkflow, dbPath, { input: {} });
        const adapter = new SmithersDb(db);
        const childRun = await adapter.getLatestChildRun(parent.runId);
        const childRunId = /** @type {string} */ (childRun?.runId);
        // Sanity: the workspace-wide listing does see the child's question.
        const allPending = await adapter.listAllPendingApprovals();
        expect(allPending.map((approval) => approval.runId)).toContain(childRunId);
        // But a user only knows the PARENT run id — the run they started, the
        // run whose status changed. Asking the parent for its pending
        // approvals must surface the question raised anywhere in its tree,
        // otherwise `smithers why <parent>` / `smithers approve <parent>` and
        // every parent-scoped UI show a dead run with no question to answer.
        const parentPending = await adapter.listPendingApprovals(parent.runId);
        expect(parentPending.map((approval) => ({ runId: approval.runId, nodeId: approval.nodeId }))).toEqual([
          { runId: childRunId, nodeId: "child-gate" },
        ]);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
