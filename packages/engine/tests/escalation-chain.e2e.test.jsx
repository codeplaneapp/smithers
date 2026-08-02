/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { EscalationChain, Workflow, runWorkflow } from "smthrs";
import { approveNode } from "../src/approvals.js";
import { SmithersDb } from "@smthrs/db/adapter";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
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
// One table holds both the escalation-check rows and the human-fallback
// decision row, so every column is optional.
const escalationSchema = z.object({
  escalated: z.boolean().optional(),
  fromLevel: z.number().optional(),
  toLevel: z.number().optional(),
  approved: z.boolean().optional(),
  note: z.string().nullable().optional(),
  decidedBy: z.string().nullable().optional(),
  decidedAt: z.string().nullable().optional(),
});
/**
 * @param {string} id
 * @param {Record<string, unknown>} output
 */
function makeAgent(id, output) {
  return { id, generate: async () => ({ output }) };
}
describe("<EscalationChain> end-to-end", () => {
  test("a successful first level stops the chain: no level 1, no human fallback", async () => {
    const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      level0: z.object({ ok: z.boolean() }),
      level1: z.object({ ok: z.boolean() }),
      escalation: escalationSchema,
    });
    const workflow = smithers(() => (
      <Workflow name="esc-stop">
        <EscalationChain
          id="incident"
          escalationOutput={outputs.escalation}
          levels={[
            { agent: makeAgent("junior", { ok: true }), output: outputs.level0 },
            { agent: makeAgent("senior", { ok: true }), output: outputs.level1 },
          ]}
          humanFallback
        >
          investigate the incident
        </EscalationChain>
      </Workflow>
    ));
    try {
      const result = await runInTestRoot(workflow, dbPath, { input: {} });
      expect(result.status).toBe("finished");
      const level0Rows = await db.select().from(tables.level0);
      expect(level0Rows).toEqual([expect.objectContaining({ nodeId: "incident-level-0", ok: true })]);
      expect(await db.select().from(tables.level1)).toEqual([]);
      const escalationRows = await db.select().from(tables.escalation);
      expect(escalationRows).toEqual([
        expect.objectContaining({
          nodeId: "incident-check-0",
          escalated: false,
          fromLevel: 0,
          toLevel: 1,
        }),
      ]);
    } finally {
      cleanup();
    }
  });
  test("a custom escalateIf predicate escalates even when the default predicate would not", async () => {
    const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      level0: z.object({ ok: z.boolean(), severity: z.string() }),
      level1: z.object({ ok: z.boolean(), severity: z.string() }),
      escalation: escalationSchema,
    });
    const workflow = smithers(() => (
      <Workflow name="esc-custom-predicate">
        <EscalationChain
          id="incident"
          escalationOutput={outputs.escalation}
          levels={[
            {
              agent: makeAgent("junior", { ok: true, severity: "high" }),
              output: outputs.level0,
              // ok=true would stop the default predicate; severity escalates anyway.
              escalateIf: (result) => result?.severity === "high",
            },
            {
              agent: makeAgent("senior", { ok: true, severity: "low" }),
              output: outputs.level1,
            },
          ]}
        >
          investigate the incident
        </EscalationChain>
      </Workflow>
    ));
    try {
      const result = await runInTestRoot(workflow, dbPath, { input: {} });
      expect(result.status).toBe("finished");
      const level1Rows = await db.select().from(tables.level1);
      expect(level1Rows).toEqual([expect.objectContaining({ nodeId: "incident-level-1", severity: "low" })]);
      const escalationRows = await db.select().from(tables.escalation);
      expect(escalationRows).toEqual([
        expect.objectContaining({
          nodeId: "incident-check-0",
          escalated: true,
          fromLevel: 0,
          toLevel: 1,
        }),
      ]);
    } finally {
      cleanup();
    }
  });
  test("when every level escalates, the human fallback approval gates the run until a real decision", async () => {
    const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      level0: z.object({ ok: z.boolean() }),
      level1: z.object({ ok: z.boolean() }),
      escalation: escalationSchema,
    });
    const workflow = smithers(() => (
      <Workflow name="esc-fallback">
        <EscalationChain
          id="incident"
          escalationOutput={outputs.escalation}
          levels={[
            { agent: makeAgent("junior", { ok: false }), output: outputs.level0 },
            { agent: makeAgent("senior", { ok: false }), output: outputs.level1 },
          ]}
          humanFallback
        >
          investigate the incident
        </EscalationChain>
      </Workflow>
    ));
    try {
      const first = await runInTestRoot(workflow, dbPath, { input: {} });
      expect(first.status).toBe("waiting-approval");
      const adapter = new SmithersDb(db);
      const pending = await Effect.runPromise(adapter.listPendingApprovals(first.runId));
      expect(pending.map((p) => p.nodeId)).toEqual(["incident-human-fallback"]);
      // Both automated levels ran and escalated before the human was pulled in.
      expect(await db.select().from(tables.level0)).toEqual([
        expect.objectContaining({ nodeId: "incident-level-0", ok: false }),
      ]);
      expect(await db.select().from(tables.level1)).toEqual([
        expect.objectContaining({ nodeId: "incident-level-1", ok: false }),
      ]);
      await Effect.runPromise(
        approveNode(adapter, first.runId, "incident-human-fallback", 0, "human took over", "oncall"),
      );
      const resumed = await runInTestRoot(workflow, dbPath, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(resumed.status).toBe("finished");
      const escalationRows = await db.select().from(tables.escalation);
      expect(escalationRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: "incident-check-0",
            escalated: true,
          }),
          expect.objectContaining({
            nodeId: "incident-human-fallback",
            approved: true,
            note: "human took over",
            decidedBy: "oncall",
          }),
        ]),
      );
    } finally {
      cleanup();
    }
  });
});
