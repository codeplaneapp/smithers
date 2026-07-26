/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { jsx, jsxs } from "smithers-orchestrator/jsx-runtime";
import {
  Approval,
  Sequence,
  SmithersDb,
  Task,
  WaitForEvent,
  Workflow,
  approvalDecisionSchema,
  runWorkflow,
  signalRun,
} from "smithers-orchestrator";
import { approveNode, denyNode } from "../src/approvals.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";
const contractSchemas = {
  decision: approvalDecisionSchema,
  optionalDecision: z.object({
    approved: z.boolean(),
    note: z.string().optional(),
  }),
  eventOut: z.object({ ok: z.boolean() }),
  result: z.object({ value: z.number() }),
};
function buildContractSmithers() {
  return createTestSmithers(contractSchemas);
}
/**
 * Inject a crash after the real signal transaction commits but before the
 * live durable-deferred bridge can inspect waiting nodes.
 * @param {SmithersDb} adapter
 */
function crashListNodesAfterSignalCommit(adapter) {
  const injectedFailure = new Error("injected post-commit signal bridge crash");
  let signalCommitted = false;
  const wrapped = new Proxy(adapter, {
    get(target, property) {
      if (property === "insertSignalWithNextSeq") {
        return (row) =>
          Effect.gen(function* () {
            const seq = yield* target.insertSignalWithNextSeq(row);
            signalCommitted = true;
            return seq;
          });
      }
      if (property === "listNodes") {
        return (runId) => (signalCommitted ? Effect.fail(injectedFailure) : target.listNodes(runId));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    adapter: wrapped,
    didCommit: () => signalCommitted,
    injectedFailure,
  };
}
describe("durable deferred contract", () => {
  test("approval waits for a decision and resumes through approveNode", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "durable-deferred-approval-approve",
          children: jsxs(Sequence, {
            children: [
              jsx(Approval, {
                id: "gate",
                output: outputs.decision,
                request: { title: "Approve deployment" },
              }),
              jsx(Task, {
                id: "after",
                output: outputs.result,
                children: { value: 1 },
              }),
            ],
          }),
        }),
      );
      const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(first.status).toBe("waiting-approval");
      await Effect.runPromise(approveNode(new SmithersDb(db), first.runId, "gate", 0, "ship it", "reviewer"));
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      const decisionRows = await db.select().from(tables.decision);
      expect(decisionRows).toEqual([
        expect.objectContaining({
          runId: first.runId,
          nodeId: "gate",
          iteration: 0,
          approved: true,
          note: "ship it",
          decidedBy: "reviewer",
        }),
      ]);
      const resultRows = await db.select().from(tables.result);
      expect(resultRows).toEqual([
        expect.objectContaining({
          runId: first.runId,
          nodeId: "after",
          iteration: 0,
          value: 1,
        }),
      ]);
    } finally {
      cleanup();
    }
  });
  test("approval without a note validates optional note output schemas", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "durable-deferred-approval-optional-note",
          children: jsx(Approval, {
            id: "gate",
            output: outputs.optionalDecision,
            request: { title: "Approve without note" },
          }),
        }),
      );
      const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(first.status).toBe("waiting-approval");
      await Effect.runPromise(approveNode(new SmithersDb(db), first.runId, "gate", 0));
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      const decisionRows = await db.select().from(tables.optionalDecision);
      expect(decisionRows).toEqual([
        expect.objectContaining({
          runId: first.runId,
          nodeId: "gate",
          iteration: 0,
          approved: true,
        }),
      ]);
    } finally {
      cleanup();
    }
  });
  test("approval denial preserves existing onDeny behavior", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "durable-deferred-approval-deny",
          children: jsxs(Sequence, {
            children: [
              jsx(Approval, {
                id: "gate",
                output: outputs.decision,
                request: { title: "Approve rollout" },
                onDeny: "skip",
              }),
              jsx(Task, {
                id: "after",
                output: outputs.result,
                children: { value: 2 },
              }),
            ],
          }),
        }),
      );
      const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(first.status).toBe("waiting-approval");
      await Effect.runPromise(denyNode(new SmithersDb(db), first.runId, "gate", 0, "not yet", "reviewer"));
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      const decisionRows = await db.select().from(tables.decision);
      expect(decisionRows).toEqual([
        expect.objectContaining({
          runId: first.runId,
          nodeId: "gate",
          iteration: 0,
          approved: false,
          note: "not yet",
          decidedBy: "reviewer",
        }),
      ]);
      const resultRows = await db.select().from(tables.result);
      expect(resultRows).toEqual([
        expect.objectContaining({
          runId: first.runId,
          nodeId: "after",
          iteration: 0,
          value: 2,
        }),
      ]);
    } finally {
      cleanup();
    }
  });
  test("WaitForEvent waits for signalRun and persists the delivered payload", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "durable-deferred-wait-for-event",
          children: jsx(WaitForEvent, {
            id: "wait",
            event: "deploy.ready",
            correlationId: "ticket-42",
            output: outputs.eventOut,
          }),
        }),
      );
      const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(first.status).toBe("waiting-event");
      await Effect.runPromise(
        signalRun(
          new SmithersDb(db),
          first.runId,
          "deploy.ready",
          { ok: true },
          { correlationId: "ticket-42", receivedBy: "tester" },
        ),
      );
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      const rows = await db.select().from(tables.eventOut);
      expect(rows).toEqual([
        expect.objectContaining({
          runId: first.runId,
          nodeId: "wait",
          iteration: 0,
          ok: true,
        }),
      ]);
    } finally {
      cleanup();
    }
  });
  test("WaitForEvent ignores non-matching signals and resolves on the matching one", async () => {
    const { smithers, outputs, db, cleanup } = buildContractSmithers();
    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "durable-deferred-wait-for-event-correlation",
          children: jsx(WaitForEvent, {
            id: "wait",
            event: "deploy.ready",
            correlationId: "ticket-42",
            output: outputs.eventOut,
          }),
        }),
      );
      const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(first.status).toBe("waiting-event");
      const adapter = new SmithersDb(db);
      await Effect.runPromise(
        signalRun(
          adapter,
          first.runId,
          "deploy.ready",
          { ok: false },
          { correlationId: "ticket-99", receivedBy: "tester" },
        ),
      );
      const stillWaiting = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
      expect(stillWaiting.status).toBe("waiting-event");
      await Effect.runPromise(
        signalRun(
          adapter,
          first.runId,
          "deploy.ready",
          { ok: true },
          { correlationId: "ticket-42", receivedBy: "tester" },
        ),
      );
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
    } finally {
      cleanup();
    }
  });
  test("signalRun normalizes correlation before the durable commit so DB-only resume survives a bridge crash", async () => {
    const { smithers, outputs, db, cleanup } = buildContractSmithers();
    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "durable-deferred-signal-correlation-crash",
          children: jsx(WaitForEvent, {
            id: "wait",
            event: "deploy.ready",
            correlationId: "pr-42",
            output: outputs.eventOut,
          }),
        }),
      );
      const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(first.status).toBe("waiting-event");
      const realAdapter = new SmithersDb(db);
      const crash = crashListNodesAfterSignalCommit(realAdapter);
      await expect(
        Effect.runPromise(
          signalRun(
            crash.adapter,
            first.runId,
            " deploy.ready ",
            { ok: true },
            {
              correlationId: " pr-42 ",
              receivedBy: "tester",
            },
          ),
        ),
      ).rejects.toThrow(crash.injectedFailure.message);
      expect(crash.didCommit()).toBe(true);

      const rawRows = db.$client
        .query(`SELECT signal_name AS signalName, correlation_id AS correlationId
                        FROM _smithers_signals WHERE run_id = ? ORDER BY seq`)
        .all(first.runId);
      expect(rawRows).toHaveLength(1);
      const normalizedRows = await Effect.runPromise(
        realAdapter.listSignals(first.runId, {
          signalName: "deploy.ready",
          correlationId: "pr-42",
        }),
      );
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );

      const controlFirst = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(controlFirst.status).toBe("waiting-event");
      await Effect.runPromise(
        realAdapter.insertSignalWithNextSeq({
          runId: controlFirst.runId,
          signalName: "deploy.ready",
          correlationId: "pr-42",
          payloadJson: JSON.stringify({ ok: true }),
          receivedAtMs: Date.now() + 1,
          receivedBy: "tester",
        }),
      );
      const controlResumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: controlFirst.runId,
          resume: true,
        }),
      );

      expect({
        rawRows,
        normalizedSignalCount: normalizedRows.length,
        resumedStatus: resumed.status,
        controlStatus: controlResumed.status,
      }).toEqual({
        rawRows: [{ signalName: "deploy.ready", correlationId: "pr-42" }],
        normalizedSignalCount: 1,
        resumedStatus: "finished",
        controlStatus: "finished",
      });
    } finally {
      cleanup();
    }
  });
  test("signalRun returns and stores normalized, blank, absent, and explicit-null correlations consistently", async () => {
    const { smithers, outputs, db, cleanup } = buildContractSmithers();
    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "durable-deferred-signal-correlation-success",
          children: jsx(WaitForEvent, {
            id: "wait",
            event: "deploy.ready",
            correlationId: "pr-42",
            output: outputs.eventOut,
          }),
        }),
      );
      const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(first.status).toBe("waiting-event");
      const adapter = new SmithersDb(db);
      const blank = await Effect.runPromise(
        signalRun(
          adapter,
          first.runId,
          " deploy.ready ",
          { ok: false, source: "blank" },
          {
            correlationId: "   ",
            receivedBy: "tester",
          },
        ),
      );
      const absent = await Effect.runPromise(
        signalRun(
          adapter,
          first.runId,
          " deploy.ready ",
          { ok: false, source: "absent" },
          {
            receivedBy: "tester",
          },
        ),
      );
      const explicitNull = await Effect.runPromise(
        signalRun(
          adapter,
          first.runId,
          " deploy.ready ",
          { ok: false, source: "explicit-null" },
          {
            correlationId: null,
            receivedBy: "tester",
          },
        ),
      );
      const matching = await Effect.runPromise(
        signalRun(
          adapter,
          first.runId,
          " deploy.ready ",
          { ok: true },
          {
            correlationId: " pr-42 ",
            receivedBy: "tester",
          },
        ),
      );
      const stored = await Effect.runPromise(adapter.listSignals(first.runId));
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );

      expect({
        returned: [blank.correlationId, absent.correlationId, explicitNull.correlationId, matching.correlationId],
        matchingSignalName: matching.signalName,
        stored: stored.map((row) => ({ signalName: row.signalName, correlationId: row.correlationId })),
        resumedStatus: resumed.status,
      }).toEqual({
        returned: [null, null, null, "pr-42"],
        matchingSignalName: "deploy.ready",
        stored: [
          { signalName: "deploy.ready", correlationId: null },
          { signalName: "deploy.ready", correlationId: null },
          { signalName: "deploy.ready", correlationId: null },
          { signalName: "deploy.ready", correlationId: "pr-42" },
        ],
        resumedStatus: "finished",
      });
    } finally {
      cleanup();
    }
  });
});
