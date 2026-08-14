/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { HumanTask, Workflow, Task, Sequence, runWorkflow } from "smthrs";
import { approveNode } from "../src/approvals.js";
import { buildHumanRequestId } from "../src/human-requests.js";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
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
describe("<HumanTask> end-to-end", () => {
  test("full loop: request row is created, a valid answer resolves the task with schema-checked output", async () => {
    const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      review: z.object({ score: z.number(), comment: z.string() }),
    });
    const workflow = smithers(() => (
      <Workflow name="human-loop">
        <HumanTask id="review" output={outputs.review} prompt="Score the release" timeoutMs={60_000} />
      </Workflow>
    ));
    try {
      const first = await runInTestRoot(workflow, dbPath, { input: {} });
      expect(first.status).toBe("waiting-approval");
      const adapter = new SmithersDb(db);
      const requestId = buildHumanRequestId(first.runId, "review", 0);
      expect(requestId).toBe(`human:${first.runId}:review:0`);
      const request = await adapter.getHumanRequest(requestId);
      expect(request).toEqual(
        expect.objectContaining({
          requestId,
          runId: first.runId,
          nodeId: "review",
          iteration: 0,
          kind: "json",
          status: "pending",
          prompt: "Score the release",
          responseJson: null,
          answeredAtMs: null,
          answeredBy: null,
        }),
      );
      // timeoutMs is wired into the expiry anchor for the human request.
      expect(request?.timeoutAtMs).toBe((request?.requestedAtMs ?? 0) + 60_000);
      const schema = JSON.parse(request?.schemaJson ?? "{}");
      expect(schema.required).toEqual(["score", "comment"]);
      await adapter.answerHumanRequest(
        requestId,
        JSON.stringify({ score: 5, comment: "ship it" }),
        Date.now(),
        "qa:carol",
      );
      await Effect.runPromise(approveNode(adapter, first.runId, "review", 0, undefined, "qa:carol"));
      const resumed = await runInTestRoot(workflow, dbPath, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(resumed.status).toBe("finished");
      const rows = await db.select().from(tables.review);
      expect(rows).toEqual([
        expect.objectContaining({
          runId: first.runId,
          nodeId: "review",
          iteration: 0,
          score: 5,
          comment: "ship it",
        }),
      ]);
    } finally {
      cleanup();
    }
  });
  test("approval-note fallback: a pre-decided approval note doubles as the human answer", async () => {
    const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      review: z.object({ score: z.number() }),
    });
    const workflow = smithers(() => (
      <Workflow name="human-note-fallback">
        <HumanTask id="review" output={outputs.review} prompt="Score it" />
      </Workflow>
    ));
    try {
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      const runId = "11111111-2222-4333-8444-555555555555";
      const note = JSON.stringify({ score: 4 });
      // An approval decided before the human task ever parks (e.g. an operator
      // pre-approving with the answer in the note) resolves via the note fallback.
      await Effect.runPromise(
        adapter.insertOrUpdateApproval({
          runId,
          nodeId: "review",
          iteration: 0,
          status: "approved",
          requestedAtMs: Date.now() - 1000,
          decidedAtMs: Date.now(),
          note,
          decidedBy: "qa:dave",
          requestJson: JSON.stringify({ mode: "decision" }),
          decisionJson: null,
          autoApproved: false,
        }),
      );
      const result = await runInTestRoot(workflow, dbPath, { input: {}, runId });
      expect(result.status).toBe("finished");
      const rows = await db.select().from(tables.review);
      expect(rows).toEqual([expect.objectContaining({ runId, nodeId: "review", score: 4 })]);
    } finally {
      cleanup();
    }
  });
  test("prompt fallback: without a prompt the request falls back to the human:<id> label", async () => {
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
      review: z.object({ ok: z.boolean() }),
    });
    const workflow = smithers(() => (
      <Workflow name="human-prompt-fallback">
        <HumanTask id="review" output={outputs.review} />
      </Workflow>
    ));
    try {
      const first = await runInTestRoot(workflow, dbPath, { input: {} });
      expect(first.status).toBe("waiting-approval");
      const adapter = new SmithersDb(db);
      const request = await adapter.getHumanRequest(buildHumanRequestId(first.runId, "review", 0));
      expect(request?.prompt).toBe("human:review");
    } finally {
      cleanup();
    }
  });
  test("async human tasks do not block unrelated downstream work", async () => {
    const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      review: z.object({ ok: z.boolean() }),
      result: z.object({ v: z.number() }),
    });
    const workflow = smithers(() => (
      <Workflow name="human-async">
        <Sequence>
          <HumanTask id="review" output={outputs.review} prompt="Check later" async />
          <Task id="after" output={outputs.result}>
            {{ v: 7 }}
          </Task>
        </Sequence>
      </Workflow>
    ));
    try {
      const first = await runInTestRoot(workflow, dbPath, { input: {} });
      expect(first.status).toBe("waiting-approval");
      // Downstream work completed while the human request is still pending.
      const resultRows = await db.select().from(tables.result);
      expect(resultRows).toEqual([expect.objectContaining({ nodeId: "after", v: 7 })]);
      const adapter = new SmithersDb(db);
      const request = await adapter.getHumanRequest(buildHumanRequestId(first.runId, "review", 0));
      expect(request?.status).toBe("pending");
      await adapter.answerHumanRequest(request?.requestId ?? "", JSON.stringify({ ok: true }), Date.now(), "qa:erin");
      await Effect.runPromise(approveNode(adapter, first.runId, "review", 0, undefined, "qa:erin"));
      const resumed = await runInTestRoot(workflow, dbPath, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(resumed.status).toBe("finished");
    } finally {
      cleanup();
    }
  });
  test("maxAttempts=1: one schema-invalid answer fails the run after exactly one attempt, then the request reopens", async () => {
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
      review: z.object({ score: z.number() }),
    });
    const workflow = smithers(() => (
      <Workflow name="human-invalid-answer">
        <HumanTask id="review" output={outputs.review} prompt="Score it" maxAttempts={1} />
      </Workflow>
    ));
    try {
      const first = await runInTestRoot(workflow, dbPath, { input: {} });
      expect(first.status).toBe("waiting-approval");
      const adapter = new SmithersDb(db);
      const requestId = buildHumanRequestId(first.runId, "review", 0);
      await adapter.answerHumanRequest(requestId, JSON.stringify({ score: "high" }), Date.now(), "qa:frank");
      await Effect.runPromise(approveNode(adapter, first.runId, "review", 0, undefined, "qa:frank"));
      const failed = await runInTestRoot(workflow, dbPath, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      // maxAttempts bounds the retry loop: exactly one validation attempt, then failure.
      expect(failed.status).toBe("failed");
      const attempts = await Effect.runPromise(adapter.listAttempts(first.runId, "review", 0));
      expect(attempts).toHaveLength(1);
      expect(JSON.parse(attempts[0]?.errorJson ?? "{}").code).toBe("HUMAN_TASK_VALIDATION_FAILED");
      // The bad answer is cleared on the next resume so a human can correct it.
      const reopenedRun = await runInTestRoot(workflow, dbPath, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(reopenedRun.status).toBe("waiting-approval");
      const reopened = await adapter.getHumanRequest(requestId);
      expect(reopened?.status).toBe("pending");
      expect(reopened?.responseJson).toBeNull();
    } finally {
      cleanup();
    }
  });
});
