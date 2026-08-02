/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { Approval, Workflow, runWorkflow, approvalDecisionSchema } from "smthrs";
import { approveNode } from "../src/approvals.js";
import { buildHumanRequestId } from "../src/human-requests.js";
import { SmithersDb } from "@smthrs/db/adapter";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";
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
/**
 * KNOWN GAP (approval timeout auto-deny): `timeoutMs` on a plain <Approval> is
 * inert at the engine layer. The scheduler exposes `approvalTimedOut` — which
 * maps a timed-out approval onto the task's onDeny policy (see
 * packages/scheduler/tests/approval-timeout-ondeny.test.js) — but nothing in
 * the engine ever schedules or invokes it, and `ensurePendingHumanRequest`
 * only anchors `timeoutAtMs` for human-task nodes, which a plain <Approval>
 * is not. So an approval with timeoutMs parks in waiting-approval forever.
 *
 * This test pins the current behavior so the gap is visible; if approval
 * timeout auto-deny is ever wired end-to-end, these expectations should flip
 * to assert the auto-denial (status "denied", ApprovalDenied event, onDeny
 * policy honored) and this file should be renamed accordingly.
 */
describe("<Approval timeoutMs> is inert: no auto-deny is wired at the engine layer", () => {
  test("a long-expired timeoutMs neither denies the approval nor unblocks the run; the gate stays decidable", async () => {
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
      approval: approvalDecisionSchema,
    });
    const workflow = smithers(() => (
      <Workflow name="approval-timeout-inert">
        <Approval id="gate" output={outputs.approval} request={{ title: "Ship it?" }} timeoutMs={5} />
      </Workflow>
    ));
    try {
      const first = await runInTestRoot(workflow, dbPath, { input: {} });
      expect(first.status).toBe("waiting-approval");
      const adapter = new SmithersDb(db);
      // A plain <Approval> creates no human-request row, so timeoutMs has
      // no expiry anchor at all — nothing can ever sweep it.
      const requestId = buildHumanRequestId(first.runId, "gate", 0);
      expect(await adapter.getHumanRequest(requestId)).toBeUndefined();
      // Wait far past the 5ms timeout, then resume: the run parks again
      // instead of auto-denying.
      await sleep(25);
      const resumed = await runInTestRoot(workflow, dbPath, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(resumed.status).toBe("waiting-approval");
      const approval = await adapter.getApproval(first.runId, "gate", 0);
      expect(approval?.status).toBe("requested");
      expect(await adapter.listEventsByType(first.runId, "ApprovalDenied")).toEqual([]);
      // The parked gate is still live: a real decision resolves the run.
      await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "ok", "ops"));
      const finished = await runInTestRoot(workflow, dbPath, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(finished.status).toBe("finished");
    } finally {
      cleanup();
    }
  });
});
