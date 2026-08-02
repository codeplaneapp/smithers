import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { archiveDiscardedEffects } from "@smthrs/time-travel/archiveDiscardedEffects";
import { assessEffectBoundary } from "@smthrs/time-travel/assessEffectBoundary";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { createToolJournalContext } from "../src/createToolJournalContext.js";

describe("compute tool journal context", () => {
  test("stale completion cannot overwrite a fresh row that reused the archived primary key", async () => {
    const api = createTestSmithers(outputSchemas);
    ensureSmithersTables(api.db);
    const adapter = new SmithersDb(api.db);
    const runId = "late-completion-run";
    await Effect.runPromise(
      adapter.insertRun({
        runId,
        workflowName: "late-completion",
        status: "finished",
        createdAtMs: Date.now(),
        finishedAtMs: Date.now(),
      }),
    );
    const eventBus = {
      emitEventWithPersist: () => Effect.void,
    };
    const context = createToolJournalContext({
      adapter,
      eventBus,
      runId,
      nodeId: "publish",
      iteration: 0,
      attempt: 1,
      rootDir: process.cwd(),
    });
    const provenance = {
      kind: "tool",
      toolName: "late-publish",
      sideEffect: true,
      idempotent: false,
      acceptsIdempotencyKey: false,
      hasRevert: true,
      idempotencyKey: null,
    };
    try {
      await context.recordToolCall({
        phase: "started",
        effectStatus: "intended",
        seq: 1,
        input: { channel: "ops" },
        ...provenance,
      });
      const staleCallToken = (await Effect.runPromise(adapter.listToolCalls(runId, "publish", 0)))[0].callToken;
      await Effect.runPromise(
        adapter.updateToolCall(runId, "publish", 0, 1, 1, {
          status: "unknown",
          revertStatus: "reverted",
          revertedAtMs: Date.now(),
        }),
      );
      expect(
        await archiveDiscardedEffects(adapter, {
          runId,
          opId: "rewind-op",
          archivedAtMs: Date.now(),
          archiveReason: "rewind",
          attempts: [{ nodeId: "publish", iteration: 0, attempt: 1 }],
        }),
      ).toBe(1);
      const freshCallToken = crypto.randomUUID();
      await Effect.runPromise(
        adapter.insertToolCall({
          runId,
          nodeId: "publish",
          iteration: 0,
          attempt: 1,
          seq: 1,
          callToken: freshCallToken,
          toolName: "late-publish",
          inputJson: '{"generation":"fresh"}',
          outputJson: null,
          startedAtMs: Date.now(),
          finishedAtMs: null,
          status: "intended",
          errorJson: null,
          ...provenance,
          revertStatus: null,
          revertedAtMs: null,
          revertErrorJson: null,
          forcedPastJson: null,
        }),
      );

      await context.recordToolCall({
        phase: "finished",
        effectStatus: "succeeded",
        seq: 1,
        output: { messageId: "m-late" },
        ...provenance,
      });

      const archived = await adapter.internalStorage.queryOne(
        `SELECT * FROM _smithers_tool_call_archive
                  WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ? AND seq = ?`,
        [runId, "publish", 0, 1, 1],
      );
      expect(archived).toMatchObject({
        callToken: staleCallToken,
        status: "succeeded",
        outputJson: '{"messageId":"m-late"}',
        revertStatus: null,
      });
      const live = await adapter.internalStorage.queryOne(`SELECT * FROM _smithers_tool_calls WHERE call_token = ?`, [
        freshCallToken,
      ]);
      expect(live).toMatchObject({
        inputJson: '{"generation":"fresh"}',
        outputJson: null,
        status: "intended",
      });
      expect(staleCallToken).not.toBe(freshCallToken);
      expect(JSON.parse(archived.forcedPastJson)).toContainEqual(
        expect.objectContaining({
          operation: "late-tool-completion",
          lateCompletion: true,
          effectStatus: "succeeded",
          archivedByOp: "rewind-op",
          priorRevertStatus: "reverted",
        }),
      );

      const events = await Effect.runPromise(adapter.listEventsByType(runId, "SideEffectBoundaryCrossed"));
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].payloadJson)).toMatchObject({
        type: "SideEffectBoundaryCrossed",
        operation: "late-tool-completion",
        lateCompletion: true,
        archivedByOp: "rewind-op",
        report: {
          blocking: [
            {
              toolName: "late-publish",
              effectStatus: "succeeded",
            },
          ],
        },
      });
      const run = await Effect.runPromise(adapter.getRun(runId));
      expect(run?.status).toBe("failed");
      expect(JSON.parse(run?.errorJson ?? "{}")).toMatchObject({
        code: "LateToolCompletion",
        needsAttention: true,
      });
    } finally {
      api.cleanup();
    }
  });

  test("late completion after live compensation marks revert-stale and remains active", async () => {
    const api = createTestSmithers(outputSchemas);
    ensureSmithersTables(api.db);
    const adapter = new SmithersDb(api.db);
    const runId = "live-revert-stale-run";
    await Effect.runPromise(
      adapter.insertRun({
        runId,
        workflowName: "live-revert-stale",
        status: "running",
        createdAtMs: Date.now(),
        startedAtMs: Date.now(),
      }),
    );
    const context = createToolJournalContext({
      adapter,
      eventBus: { emitEventWithPersist: () => Effect.void },
      runId,
      nodeId: "publish",
      iteration: 0,
      attempt: 1,
      rootDir: process.cwd(),
    });
    const provenance = {
      kind: "tool",
      toolName: "late-publish",
      sideEffect: true,
      idempotent: false,
      acceptsIdempotencyKey: false,
      hasRevert: false,
      idempotencyKey: null,
    };
    try {
      await context.recordToolCall({
        phase: "started",
        effectStatus: "intended",
        seq: 1,
        input: { channel: "ops" },
        ...provenance,
      });
      const [started] = await Effect.runPromise(adapter.listToolCalls(runId, "publish", 0));
      await Effect.runPromise(
        adapter.updateToolCallByToken(String(started.callToken), {
          status: "unknown",
          revertStatus: "reverted",
          revertedAtMs: Date.now(),
        }),
      );

      await context.recordToolCall({
        phase: "finished",
        effectStatus: "succeeded",
        seq: 1,
        output: { messageId: "m-rematerialized" },
        ...provenance,
      });

      const [completed] = await Effect.runPromise(adapter.listToolCalls(runId, "publish", 0));
      expect(completed).toMatchObject({
        status: "succeeded",
        revertStatus: "revert-stale",
        outputJson: '{"messageId":"m-rematerialized"}',
      });
      expect(JSON.parse(String(completed.forcedPastJson))).toContainEqual(
        expect.objectContaining({
          operation: "late-tool-completion",
          lateCompletion: true,
          priorRevertStatus: "reverted",
        }),
      );

      const report = await assessEffectBoundary(adapter, {
        runId,
        cutoffMs: 0,
      });
      expect(report).toMatchObject({
        blocking: [
          {
            toolName: "late-publish",
            effectStatus: "succeeded",
          },
        ],
        revertible: [],
      });
      const events = await Effect.runPromise(adapter.listEventsByType(runId, "SideEffectBoundaryCrossed"));
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].payloadJson)).toMatchObject({
        operation: "late-tool-completion",
        lateCompletion: true,
        report: {
          blocking: [
            {
              toolName: "late-publish",
              effectStatus: "succeeded",
            },
          ],
        },
      });
      const run = await Effect.runPromise(adapter.getRun(runId));
      expect(run?.status).toBe("failed");
      expect(JSON.parse(run?.errorJson ?? "{}")).toMatchObject({
        code: "LateToolCompletion",
        needsAttention: true,
        revertStatus: "revert-stale",
      });
    } finally {
      api.cleanup();
    }
  });
});
