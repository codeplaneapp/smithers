import { Effect } from "effect";
import { errorToJson } from "@smthrs/errors/errorToJson";

/**
 * @param {unknown} value
 * @returns {Array<Record<string, unknown>>}
 */
function parseJsonArray(value) {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      : [];
  } catch {
    return [];
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function asBoolean(value) {
  return value === true || value === 1 || value === "1";
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} camel
 * @param {string} snake
 * @returns {unknown}
 */
function rowValue(row, camel, snake) {
  return row[camel] ?? row[snake];
}

/**
 * Complete one journal call by its immutable token. A missing live token means
 * time travel archived or replaced the call, so the outcome is stamped on that
 * exact archive row and surfaced durably.
 *
 * @param {{
 *   adapter: import("@smthrs/db/adapter").SmithersDb;
 *   runId: string;
 *   nodeId: string;
 *   iteration: number;
 *   attempt: number;
 *   callToken: string;
 *   call: Record<string, unknown>;
 *   provenance: Record<string, unknown>;
 *   timestampMs: number;
 *   inTransaction?: boolean;
 * }} params
 * @returns {Effect.Effect<void, unknown>}
 */
export function completeToolJournalCall(params) {
  const seq = Number(params.call.seq);
  const status = params.call.phase === "finished" ? "succeeded" : "unknown";
  const livePatch = {
    ...params.provenance,
    ...(params.call.phase === "finished" ? { outputJson: JSON.stringify(params.call.output ?? null) } : {}),
    finishedAtMs: params.timestampMs,
    status,
    errorJson: params.call.phase === "failed" ? JSON.stringify(errorToJson(params.call.error)) : null,
  };

  return Effect.gen(function* () {
    const completeCall = Effect.gen(function* () {
      const lockSuffix = params.adapter.internalStorage.dialect === "postgres" ? " FOR UPDATE" : "";
      const live = yield* Effect.promise(() =>
        params.adapter.internalStorage.queryOne(
          `SELECT *
           FROM _smithers_tool_calls
          WHERE call_token = ?
          LIMIT 1${lockSuffix}`,
          [params.callToken],
        ),
      );
      if (live) {
        const priorRevertStatus = rowValue(live, "revertStatus", "revert_status");
        const revertStale = priorRevertStatus === "reverting" || priorRevertStatus === "reverted";
        const opId = ["late-tool-completion", params.callToken, "live"].join(":");
        const forcedPast = parseJsonArray(rowValue(live, "forcedPastJson", "forced_past_json"));
        if (revertStale && !forcedPast.some((entry) => entry.opId === opId)) {
          forcedPast.push({
            opId,
            timestampMs: params.timestampMs,
            operation: "late-tool-completion",
            lateCompletion: true,
            effectStatus: status,
            callToken: params.callToken,
            priorRevertStatus,
          });
        }
        const updated = yield* params.adapter.updateToolCallByToken(params.callToken, {
          ...livePatch,
          ...(revertStale
            ? {
                revertStatus: "revert-stale",
                forcedPastJson: JSON.stringify(forcedPast),
              }
            : {}),
        });
        if (updated === 0) {
          return yield* Effect.fail(
            new Error(`Live tool token disappeared before completion could be recorded: ${params.callToken}`),
          );
        }
        if (!revertStale) return;

        const effect = {
          kind: live.kind === "task" ? "task" : "tool",
          toolName: String(rowValue(live, "toolName", "tool_name") ?? params.call.toolName ?? ""),
          nodeId: String(rowValue(live, "nodeId", "node_id") ?? params.nodeId),
          iteration: Number(live.iteration ?? params.iteration),
          attempt: Number(live.attempt ?? params.attempt),
          seq: Number(live.seq ?? seq),
          effectStatus: status,
          idempotent: asBoolean(live.idempotent ?? params.provenance.idempotent),
          hasRevert: asBoolean(rowValue(live, "hasRevert", "has_revert") ?? params.provenance.hasRevert),
          startedAtMs: Number(rowValue(live, "startedAtMs", "started_at_ms") ?? params.timestampMs),
          reason: "Tool completed after compensation, so the prior revert is stale.",
        };
        const report = effect.hasRevert
          ? { blocking: [], revertible: [effect], warnings: [] }
          : { blocking: [effect], revertible: [], warnings: [] };
        const event = {
          type: "SideEffectBoundaryCrossed",
          runId: params.runId,
          opId,
          operation: "late-tool-completion",
          report,
          timestampMs: params.timestampMs,
          lateCompletion: true,
          callToken: params.callToken,
        };
        yield* params.adapter.insertEventWithNextSeq({
          runId: params.runId,
          timestampMs: params.timestampMs,
          type: event.type,
          payloadJson: JSON.stringify(event),
        });
        yield* params.adapter.updateRun(params.runId, {
          status: "failed",
          finishedAtMs: params.timestampMs,
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          errorJson: JSON.stringify({
            code: "LateToolCompletion",
            needsAttention: true,
            message: `Tool ${effect.toolName} completed after compensation.`,
            timestampMs: params.timestampMs,
            opId,
            nodeId: effect.nodeId,
            iteration: effect.iteration,
            attempt: effect.attempt,
            seq: effect.seq,
            callToken: params.callToken,
            priorRevertStatus,
            revertStatus: "revert-stale",
          }),
        });
        return;
      }

      const archived = yield* Effect.promise(() =>
        params.adapter.internalStorage.queryOne(
          `SELECT *
           FROM _smithers_tool_call_archive
          WHERE call_token = ?
          LIMIT 1`,
          [params.callToken],
        ),
      );
      if (!archived) {
        return yield* Effect.fail(
          new Error(`Tool ${params.call.phase} matched no live or archived journal token: ${params.callToken}`),
        );
      }

      const archivedByOp = String(rowValue(archived, "archivedByOp", "archived_by_op") ?? "");
      const archivedNodeId = String(rowValue(archived, "nodeId", "node_id") ?? params.nodeId);
      const archivedIteration = Number(archived.iteration ?? params.iteration);
      const archivedAttempt = Number(archived.attempt ?? params.attempt);
      const archivedSeq = Number(archived.seq ?? seq);
      const opId = ["late-tool-completion", params.callToken, archivedByOp].join(":");
      const marker = {
        opId,
        timestampMs: params.timestampMs,
        operation: "late-tool-completion",
        lateCompletion: true,
        effectStatus: status,
        archivedByOp,
        callToken: params.callToken,
        priorRevertStatus: rowValue(archived, "revertStatus", "revert_status") ?? null,
      };
      const forcedPast = parseJsonArray(rowValue(archived, "forcedPastJson", "forced_past_json"));
      if (!forcedPast.some((entry) => entry.opId === opId)) {
        forcedPast.push(marker);
      }
      const archivePatch = {
        ...livePatch,
        revertStatus: null,
        forcedPastJson: JSON.stringify(forcedPast),
      };
      const archivedUpdated = yield* Effect.promise(() =>
        params.adapter.internalStorage.updateWhere("_smithers_tool_call_archive", archivePatch, "call_token = ?", [
          params.callToken,
        ]),
      );
      if (archivedUpdated === 0) {
        return yield* Effect.fail(
          new Error(`Archived tool token disappeared before late completion could be recorded: ${params.callToken}`),
        );
      }

      const effect = {
        kind: archived.kind === "task" ? "task" : "tool",
        toolName: String(rowValue(archived, "toolName", "tool_name") ?? params.call.toolName ?? ""),
        nodeId: archivedNodeId,
        iteration: archivedIteration,
        attempt: archivedAttempt,
        seq: archivedSeq,
        effectStatus: status,
        idempotent: asBoolean(archived.idempotent ?? params.provenance.idempotent),
        hasRevert: asBoolean(rowValue(archived, "hasRevert", "has_revert") ?? params.provenance.hasRevert),
        startedAtMs: Number(rowValue(archived, "startedAtMs", "started_at_ms") ?? params.timestampMs),
        reason: "Tool completed after its live journal row was archived by time travel.",
      };
      const report = { blocking: [effect], revertible: [], warnings: [] };
      const event = {
        type: "SideEffectBoundaryCrossed",
        runId: params.runId,
        opId,
        operation: "late-tool-completion",
        report,
        timestampMs: params.timestampMs,
        lateCompletion: true,
        archivedByOp,
        callToken: params.callToken,
      };
      yield* params.adapter.insertEventWithNextSeq({
        runId: params.runId,
        timestampMs: params.timestampMs,
        type: event.type,
        payloadJson: JSON.stringify(event),
      });
      yield* params.adapter.updateRun(params.runId, {
        status: "failed",
        finishedAtMs: params.timestampMs,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        errorJson: JSON.stringify({
          code: "LateToolCompletion",
          needsAttention: true,
          message: `Tool ${effect.toolName} completed after its journal row was archived.`,
          timestampMs: params.timestampMs,
          opId,
          nodeId: archivedNodeId,
          iteration: archivedIteration,
          attempt: archivedAttempt,
          seq: archivedSeq,
          archivedByOp,
          callToken: params.callToken,
        }),
      });
    });

    if (params.inTransaction) {
      yield* completeCall;
    } else {
      yield* params.adapter.withTransactionEffect("late-tool-completion", completeCall);
    }
  });
}
