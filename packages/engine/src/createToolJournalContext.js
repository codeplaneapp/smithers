import { Effect } from "effect";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { completeToolJournalCall } from "./completeToolJournalCall.js";

/**
 * Build the ambient defineTool context used by in-process compute callbacks.
 *
 * @param {{
 *   adapter: import("@smithers-orchestrator/db/adapter").SmithersDb;
 *   eventBus: import("./events.js").EventBus;
 *   runId: string;
 *   nodeId: string;
 *   iteration: number;
 *   attempt: number;
 *   rootDir: string;
 *   abortSignal?: AbortSignal;
 * }} params
 */
export function createToolJournalContext(params) {
  /** @type {Map<number, { promise: Promise<void>; resolve: () => void }>} */
  const pendingToolCalls = new Map();
  /** @type {Map<number, { callToken: string; call: Record<string, unknown> }>} */
  const callTokens = new Map();
  const beginToolCall = (seq) => {
    if (pendingToolCalls.has(seq)) return;
    let resolve = () => {};
    const promise = new Promise((next) => {
      resolve = next;
    });
    pendingToolCalls.set(seq, { promise, resolve });
  };
  const finishToolCall = (seq) => {
    const pending = pendingToolCalls.get(seq);
    if (!pending) return;
    pendingToolCalls.delete(seq);
    pending.resolve();
  };
  /**
   * @param {Record<string, unknown>} call
   * @param {number} [timestampMs]
   * @param {{ inTransaction?: boolean }} [options]
   * @returns {Effect.Effect<void, unknown>}
   */
  const recordToolCallEffect = (call, timestampMs = nowMs(), options = {}) => {
    const seq = Number(call.seq);
    const provenance = {
      kind: call.kind === "task" ? "task" : "tool",
      sideEffect: Boolean(call.sideEffect),
      idempotent: Boolean(call.idempotent),
      acceptsIdempotencyKey: Boolean(call.acceptsIdempotencyKey),
      hasRevert: Boolean(call.hasRevert),
      idempotencyKey: typeof call.idempotencyKey === "string" ? call.idempotencyKey : null,
    };
    if (call.phase === "started") {
      return Effect.gen(function* () {
        const callToken = crypto.randomUUID();
        const row = {
          runId: params.runId,
          nodeId: params.nodeId,
          iteration: params.iteration,
          attempt: params.attempt,
          seq,
          callToken,
          toolName: String(call.toolName),
          inputJson: call.kind === "task" ? null : JSON.stringify(call.input ?? null),
          outputJson: null,
          startedAtMs: timestampMs,
          finishedAtMs: null,
          status: "intended",
          errorJson: null,
          ...provenance,
          revertStatus: null,
          revertedAtMs: null,
          revertErrorJson: null,
          forcedPastJson: null,
        };
        yield* params.adapter.insertToolCall(row);
        callTokens.set(seq, { callToken, call });
        beginToolCall(seq);
        yield* params.eventBus.emitEventWithPersist({
          type: "ToolCallStarted",
          ...row,
          timestampMs,
        });
      });
    }
    const started = callTokens.get(seq);
    if (!started) {
      return Effect.fail(new Error(
        `Tool ${call.phase} has no started-call token: ${params.runId}/${params.nodeId}/${params.iteration}/${params.attempt}/${seq}`,
      ));
    }
    return completeToolJournalCall({
      adapter: params.adapter,
      runId: params.runId,
      nodeId: params.nodeId,
      iteration: params.iteration,
      attempt: params.attempt,
      callToken: started.callToken,
      call,
      provenance,
      timestampMs,
      inTransaction: options.inTransaction,
    }).pipe(Effect.ensuring(Effect.sync(() => {
      callTokens.delete(seq);
      finishToolCall(seq);
    })));
  };
  return {
    runId: params.runId,
    nodeId: params.nodeId,
    iteration: params.iteration,
    attempt: params.attempt,
    rootDir: params.rootDir,
    signal: params.abortSignal,
    recordToolCallEffect,
    failPendingToolCallsEffect: (error, timestampMs = nowMs(), options = {}) => Effect.forEach(
      [...callTokens.entries()],
      ([seq, started]) => {
        const provenance = {
          kind: started.call.kind === "task" ? "task" : "tool",
          sideEffect: Boolean(started.call.sideEffect),
          idempotent: Boolean(started.call.idempotent),
          acceptsIdempotencyKey: Boolean(started.call.acceptsIdempotencyKey),
          hasRevert: Boolean(started.call.hasRevert),
          idempotencyKey: typeof started.call.idempotencyKey === "string"
            ? started.call.idempotencyKey
            : null,
        };
        return completeToolJournalCall({
          adapter: params.adapter,
          runId: params.runId,
          nodeId: params.nodeId,
          iteration: params.iteration,
          attempt: params.attempt,
          callToken: started.callToken,
          call: {
            ...started.call,
            phase: "failed",
            seq,
            error,
          },
          provenance,
          timestampMs,
          inTransaction: options.inTransaction,
        }).pipe(Effect.ensuring(Effect.sync(() => {
          finishToolCall(seq);
        })));
      },
      { discard: true },
    ),
    waitForPendingToolCalls: async (graceMs) => {
      const pending = [...pendingToolCalls.values()].map((entry) => entry.promise);
      if (pending.length === 0) return true;
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, graceMs));
      });
      const settled = Promise.allSettled(pending).then(() => true);
      const joined = await Promise.race([settled, timedOut]);
      if (timer) clearTimeout(timer);
      return joined;
    },
    recordToolCall: (call) => Effect.runPromise(recordToolCallEffect(call)),
  };
}
