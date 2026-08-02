/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smthrs/db/adapter";
import { captureSnapshot, loadLatestSnapshot, parseSnapshot } from "@smthrs/time-travel/snapshot";
import { Effect } from "effect";
import { Task, Workflow, runWorkflow } from "smthrs";
import { z } from "zod";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

describe("workflow input handling", () => {
  test("input is accessible via ctx.input", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ topic: z.string() }),
    });
    const workflow = smithers((ctx) => (
      <Workflow name="input-access">
        <Task id="t" output={outputs.out}>
          {{ topic: ctx.input.topic }}
        </Task>
      </Workflow>
    ));
    const r = await Effect.runPromise(runWorkflow(workflow, { input: { topic: "testing" } }));
    expect(r.status).toBe("finished");
    const rows = db.select().from(tables.out).all();
    expect(rows[0].topic).toBe("testing");
    cleanup();
  });
  test("empty input works", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    const workflow = smithers(() => (
      <Workflow name="empty-input">
        <Task id="t" output={outputs.out}>
          {{ v: 1 }}
        </Task>
      </Workflow>
    ));
    const r = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(r.status).toBe("finished");
    cleanup();
  });
  test("complex input with nested objects", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ name: z.string() }),
    });
    const workflow = smithers((ctx) => (
      <Workflow name="complex-input">
        <Task id="t" output={outputs.out}>
          {{ name: ctx.input.user?.name ?? "unknown" }}
        </Task>
      </Workflow>
    ));
    const r = await Effect.runPromise(
      runWorkflow(workflow, {
        input: { user: { name: "alice", role: "admin" } },
      }),
    );
    expect(r.status).toBe("finished");
    const rows = db.select().from(tables.out).all();
    expect(rows[0].name).toBe("alice");
    cleanup();
  });
  test("custom runId is used", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    const workflow = smithers(() => (
      <Workflow name="custom-runid">
        <Task id="t" output={outputs.out}>
          {{ v: 1 }}
        </Task>
      </Workflow>
    ));
    const r = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId: "my-custom-run",
      }),
    );
    expect(r.status).toBe("finished");
    expect(r.runId).toBe("my-custom-run");
    cleanup();
  });
  test("auto-generated runId is a UUID", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    const workflow = smithers(() => (
      <Workflow name="auto-runid">
        <Task id="t" output={outputs.out}>
          {{ v: 1 }}
        </Task>
      </Workflow>
    ));
    const r = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(r.status).toBe("finished");
    expect(typeof r.runId).toBe("string");
    expect(r.runId.length).toBeGreaterThan(0);
    cleanup();
  });
  test("resume coerces numeric strings recorded by legacy snapshots", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      input: z.object({ maxRounds: z.number().int() }),
      out: z.object({ v: z.number() }),
    });
    const workflow = smithers(() => (
      <Workflow name="legacy-snapshot-input">
        <Task id="t" output={outputs.out}>
          {{ v: 1 }}
        </Task>
      </Workflow>
    ));
    const runId = "legacy-snapshot-input";
    try {
      const first = await Effect.runPromise(runWorkflow(workflow, { input: { maxRounds: 8 }, runId }));
      expect(first.status).toBe("finished");

      const adapter = new SmithersDb(db);
      const latest = await loadLatestSnapshot(adapter, runId);
      const parsed = parseSnapshot(latest);
      await captureSnapshot(adapter, runId, latest.frameNo + 1, {
        nodes: Object.values(parsed.nodes),
        outputs: parsed.outputs,
        ralph: Object.values(parsed.ralph),
        input: { maxRounds: "8" },
      });
      db.$client.query(`DELETE FROM "input" WHERE run_id = ?`).run(runId);

      const resumed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
      expect(resumed.status).toBe("finished");
      expect(db.$client.query(`SELECT max_rounds AS maxRounds FROM "input" WHERE run_id = ?`).get(runId)).toEqual({
        maxRounds: 8,
      });
    } finally {
      cleanup();
    }
  });
});
