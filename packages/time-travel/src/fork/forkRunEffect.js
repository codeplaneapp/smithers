import { Effect, Metric } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { smithersBranches } from "../schema.js";
import { persistSnapshotRow, snapshotContentHashFromJson } from "../snapshot/captureSnapshotEffect.js";
import { loadSnapshot } from "../snapshot/loadSnapshotEffect.js";
import { parseSnapshot } from "../snapshot/parseSnapshot.js";
import { parseSnapshotJson } from "../snapshot/parseSnapshotJson.js";
import { runForksCreated } from "../runForksCreated.js";
import { expandResetSet } from "./_helpers.js";
import { guardEffectBoundary } from "../guardEffectBoundary.js";
import { assessEffectBoundary } from "../assessEffectBoundary.js";
import { recordForcedEffectBoundary } from "../recordForcedEffectBoundary.js";
import { isRunLikelyLive } from "../isRunLikelyLive.js";
/** @typedef {import("../BranchInfo.ts").BranchInfo} BranchInfo */
/** @typedef {import("../ForkParams.ts").ForkParams} ForkParams */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("../snapshot/Snapshot.ts").Snapshot} Snapshot */

const DURABILITY_CONFIG_KEY = "__smithersDurability";
const DURABILITY_METADATA_VERSION = 2;

/**
 * @param {import("../CrossedEffect.ts").CrossedEffect} effect
 * @returns {string}
 */
function effectKey(effect) {
  return [effect.runId, effect.kind, effect.nodeId, effect.iteration, effect.attempt, effect.seq].join(":");
}

/**
 * Apply fork/replay disposition semantics to a raw assessment.
 *
 * @param {import("../EffectBoundaryReport.ts").EffectBoundaryReport} report
 * @param {boolean} warningOnly
 * @returns {import("../EffectBoundaryReport.ts").EffectBoundaryReport}
 */
function normalizeBranchReport(report, warningOnly) {
  if (warningOnly) {
    return {
      blocking: [],
      revertible: [],
      warnings: [
        ...report.warnings,
        ...report.blocking.map((effect) => ({
          ...effect,
          reason: "Fork warning: effect may execute again if the child is resumed.",
        })),
        ...report.revertible.map((effect) => ({
          ...effect,
          reason: "Fork warning: effect may execute again if the child is resumed.",
        })),
      ],
    };
  }
  return {
    blocking: [
      ...report.blocking,
      ...report.revertible.map((effect) => ({
        ...effect,
        reason: "Branch operations never revert parent effects.",
      })),
    ],
    revertible: [],
    warnings: report.warnings,
  };
}

/**
 * @param {import("../EffectBoundaryReport.ts").EffectBoundaryReport} before
 * @param {import("../EffectBoundaryReport.ts").EffectBoundaryReport} after
 * @returns {import("../EffectBoundaryReport.ts").EffectBoundaryReport}
 */
function newlyCrossedEffects(before, after) {
  const seen = new Set([...before.blocking, ...before.revertible, ...before.warnings].map(effectKey));
  return {
    blocking: after.blocking.filter((effect) => !seen.has(effectKey(effect))),
    revertible: after.revertible.filter((effect) => !seen.has(effectKey(effect))),
    warnings: after.warnings.filter((effect) => !seen.has(effectKey(effect))),
  };
}

/**
 * @param {string | null | undefined} configJson
 * @param {string | null | undefined} entryWorkflowHash
 * @returns {string | null}
 */
function patchDurabilityConfigJson(configJson, entryWorkflowHash) {
  if (entryWorkflowHash === undefined) {
    return configJson ?? null;
  }
  /** @type {Record<string, unknown>} */
  let config = {};
  if (configJson) {
    try {
      const parsed = JSON.parse(configJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = /** @type {Record<string, unknown>} */ (parsed);
      }
    } catch {
      config = {};
    }
  }
  return JSON.stringify({
    ...config,
    [DURABILITY_CONFIG_KEY]: {
      version: DURABILITY_METADATA_VERSION,
      entryWorkflowHash: entryWorkflowHash ?? null,
    },
  });
}

/**
 * @param {Record<string, unknown> | null | undefined} parentRun
 * @param {string} parentRunId
 * @param {ForkParams} params
 * @returns {SmithersError | null}
 */
function liveParentForkError(parentRun, parentRunId, params) {
  if (
    params.autoRun !== true ||
    params.force === true ||
    parentRun?.status !== "running" ||
    !isRunLikelyLive(parentRun)
  ) {
    return null;
  }
  return new SmithersError(
    "INVALID_INPUT",
    `Parent run ${parentRunId} is still running with a live owner or fresh heartbeat. Stop it before replaying or forking with run, or pass force: true.`,
    {
      runId: parentRunId,
      runtimeOwnerId: parentRun.runtimeOwnerId ?? null,
      heartbeatAtMs: parentRun.heartbeatAtMs ?? null,
      operation: params.operation ?? "fork",
    },
  );
}

/**
 * @param {SmithersDb} adapter
 * @param {ForkParams} params
 * @returns {Effect.Effect<{ runId: string; branch: BranchInfo; snapshot: Snapshot; effectBoundary: import("../EffectBoundaryReport.ts").EffectBoundaryReport }, SmithersError>}
 */
export function forkRun(adapter, params) {
  return Effect.gen(function* () {
    const { parentRunId, frameNo, inputOverrides, resetNodes, branchLabel, forkDescription } = params;
    // 1. Load source snapshot
    const source = yield* loadSnapshot(adapter, parentRunId, frameNo);
    if (!source) {
      return yield* Effect.fail(
        new SmithersError("SNAPSHOT_NOT_FOUND", `No snapshot found for run=${parentRunId} frame=${frameNo}`, {
          frameNo,
          runId: parentRunId,
        }),
      );
    }
    let boundary = yield* Effect.tryPromise({
      try: () =>
        guardEffectBoundary(adapter, {
          runId: parentRunId,
          cutoffMs: source.createdAtMs,
          operation: params.operation ?? "fork",
          force: params.force,
          runsReverts: false,
          warningOnly: params.autoRun !== true,
        }),
      catch: (cause) => (cause instanceof SmithersError ? cause : toSmithersError(cause, "assess fork side effects")),
    });
    // 2. Create new run ID
    const childRunId = crypto.randomUUID();
    const ts = nowMs();
    const parentRun = yield* Effect.tryPromise({
      try: () => adapter.getRun(parentRunId),
      catch: (cause) =>
        toSmithersError(cause, "load parent run metadata", {
          code: "DB_QUERY_FAILED",
          details: { runId: parentRunId },
        }),
    });
    const initialLiveParentError = liveParentForkError(parentRun, parentRunId, params);
    if (initialLiveParentError) {
      return yield* Effect.fail(initialLiveParentError);
    }
    // 3. Optionally override input and reset nodes
    let nodesJson = source.nodesJson;
    let inputJson = source.inputJson;
    if (inputOverrides) {
      const existingInput = yield* Effect.try({
        try: () => parseSnapshotJson(source.inputJson, "inputJson", { runId: parentRunId, frameNo }),
        catch: (cause) =>
          toSmithersError(cause, "parse snapshot input", {
            code: "DB_QUERY_FAILED",
            details: { runId: parentRunId, frameNo, field: "inputJson" },
          }),
      });
      inputJson = JSON.stringify({ ...existingInput, ...inputOverrides });
    }
    if (resetNodes && resetNodes.length > 0) {
      const parsed = yield* Effect.try({
        try: () => parseSnapshot(source),
        catch: (cause) =>
          toSmithersError(cause, "parse snapshot", {
            code: "DB_QUERY_FAILED",
            details: { runId: parentRunId, frameNo },
          }),
      });
      const keysToReset = expandResetSet(parsed.nodes, resetNodes);
      const nodesArr = yield* Effect.try({
        try: () => parseSnapshotJson(source.nodesJson, "nodesJson", { runId: parentRunId, frameNo }),
        catch: (cause) =>
          toSmithersError(cause, "parse snapshot nodes", {
            code: "DB_QUERY_FAILED",
            details: { runId: parentRunId, frameNo, field: "nodesJson" },
          }),
      });
      const updatedNodes = nodesArr.map((n) => {
        const key = `${n.nodeId}::${n.iteration}`;
        if (keysToReset.includes(key) || resetNodes.includes(n.nodeId)) {
          return { ...n, state: "pending", lastAttempt: null };
        }
        return n;
      });
      nodesJson = JSON.stringify(updatedNodes);
    }
    // 4. Build rows for the child fork.
    const childWorkflowHash = params.workflowHash !== undefined ? params.workflowHash : source.workflowHash;
    const childWorkflowPath =
      params.workflowPath !== undefined ? params.workflowPath : (parentRun?.workflowPath ?? null);
    const childConfigJson = patchDurabilityConfigJson(parentRun?.configJson ?? null, params.entryWorkflowHash);
    const childContentHash = snapshotContentHashFromJson(nodesJson, source.outputsJson, source.ralphJson, inputJson);
    const childSnapshot = {
      runId: childRunId,
      frameNo: 0,
      nodesJson,
      outputsJson: source.outputsJson,
      ralphJson: source.ralphJson,
      inputJson,
      vcsPointer: source.vcsPointer,
      workflowHash: childWorkflowHash,
      contentHash: childContentHash,
      createdAtMs: ts,
    };
    const childRun = parentRun
      ? {
          runId: childRunId,
          parentRunId,
          workflowName: parentRun.workflowName,
          workflowPath: childWorkflowPath,
          workflowHash: childWorkflowHash ?? parentRun.workflowHash ?? null,
          status: parentRun.status === "running" ? "failed" : parentRun.status,
          createdAtMs: ts,
          startedAtMs: null,
          finishedAtMs: parentRun.finishedAtMs ?? ts,
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          cancelRequestedAtMs: null,
          hijackRequestedAtMs: null,
          hijackTarget: null,
          vcsType: parentRun.vcsType ?? null,
          vcsRoot: parentRun.vcsRoot ?? null,
          vcsRevision: source.vcsPointer ?? parentRun.vcsRevision ?? null,
          errorJson: null,
          configJson: childConfigJson,
        }
      : null;
    const branch = {
      runId: childRunId,
      parentRunId,
      parentFrameNo: frameNo,
      branchLabel: branchLabel ?? null,
      forkDescription: forkDescription ?? null,
      createdAtMs: ts,
    };
    // 5. Persist the fork atomically: snapshot, optional run metadata, and
    // branch relationship must either all commit or all roll back.
    const isPostgres = adapter.internalStorage?.dialect === "postgres";
    yield* adapter.withTransactionEffect(
      "fork run",
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => persistSnapshotRow(adapter, childSnapshot, { inTransaction: true }),
          catch: (cause) =>
            toSmithersError(cause, "insert forked snapshot", {
              code: "DB_WRITE_FAILED",
              details: { frameNo: 0, runId: childRunId },
            }),
        });
        // Output provenance is part of the snapshot's durable identity.
        // Copy it verbatim so a fork cannot reorder inherited rows.
        yield* Effect.tryPromise({
          try: async () => {
            const snapshotOutputs = JSON.parse(source.outputsJson);
            const present = new Set();
            for (const [tableName, outputRows] of Object.entries(snapshotOutputs)) {
              if (!Array.isArray(outputRows)) continue;
              for (const row of outputRows)
                present.add(`${tableName}::${row.nodeId ?? row.node_id}::${Number(row.iteration ?? 0)}`);
            }
            const rows = await adapter.internalStorage.queryAll(
              `SELECT output_table, node_id, iteration, seq FROM _smithers_output_provenance WHERE run_id = ?`,
              [parentRunId],
            );
            for (const row of rows) {
              const tableName = row.outputTable ?? row.output_table;
              if (!present.has(`${tableName}::${row.nodeId ?? row.node_id}::${Number(row.iteration ?? 0)}`)) continue;
              await adapter.internalStorage.insertIgnore("_smithers_output_provenance", {
                runId: childRunId,
                outputTable: tableName,
                nodeId: row.nodeId ?? row.node_id,
                iteration: Number(row.iteration ?? 0),
                seq: Number(row.seq),
              });
            }
            const signalHorizon = Number(snapshotOutputs.__smithersSignalProvenanceHorizon ?? -1);
            if (signalHorizon >= 0) {
              const signals = await adapter.internalStorage.queryAll(
                `SELECT seq, signal_name, correlation_id, payload_json, received_at_ms, received_by FROM _smithers_signals WHERE run_id = ? AND seq <= ? ORDER BY seq`,
                [parentRunId, signalHorizon],
              );
              for (const signal of signals) {
                await adapter.internalStorage.insertIgnore("_smithers_signals", {
                  runId: childRunId,
                  seq: Number(signal.seq),
                  signalName: signal.signalName ?? signal.signal_name,
                  correlationId: signal.correlationId ?? signal.correlation_id,
                  payloadJson: signal.payloadJson ?? signal.payload_json,
                  receivedAtMs: Number(signal.receivedAtMs ?? signal.received_at_ms),
                  receivedBy: signal.receivedBy ?? signal.received_by,
                });
              }
            }
          },
          catch: (cause) =>
            toSmithersError(cause, "copy output provenance", {
              code: "DB_WRITE_FAILED",
              details: { parentRunId, childRunId },
            }),
        });
        if (childRun) {
          yield* adapter.insertRun(childRun);
        }
        yield* Effect.tryPromise({
          try: () =>
            isPostgres
              ? adapter.internalStorage.upsert("_smithers_branches", branch, ["runId"])
              : adapter.db.insert(smithersBranches).values(branch).onConflictDoUpdate({
                  target: smithersBranches.runId,
                  set: branch,
                }),
          catch: (cause) =>
            toSmithersError(cause, "insert branch", {
              code: "DB_WRITE_FAILED",
              details: { runId: childRunId },
            }),
        });
        // The parent can be reclaimed while child rows are inserted.
        // Recheck ownership in this transaction so the child rolls back
        // before a replacement parent owner and child can both execute.
        const reassessedParentRun = yield* adapter.getRun(parentRunId);
        const postPersistenceLiveParentError = liveParentForkError(reassessedParentRun, parentRunId, params);
        if (postPersistenceLiveParentError) {
          return yield* Effect.fail(postPersistenceLiveParentError);
        }
        // Re-assess at the same source horizon after every child row is
        // persisted but before commit. A parent effect that appeared after
        // the pre-check must either be reported and forced or abort this
        // transaction so no child survives the race.
        const reassessedRaw = yield* Effect.tryPromise({
          try: () =>
            assessEffectBoundary(adapter, {
              runId: parentRunId,
              cutoffMs: source.createdAtMs,
            }),
          catch: (cause) =>
            cause instanceof SmithersError
              ? cause
              : toSmithersError(cause, "reassess fork side effects", {
                  code: "DB_QUERY_FAILED",
                  details: { parentRunId, childRunId },
                }),
        });
        const reassessed = normalizeBranchReport(reassessedRaw, params.autoRun !== true);
        let newlyCrossed = newlyCrossedEffects(boundary.report, reassessed);
        if (params.autoRun === true && params.force === true && newlyCrossed.blocking.length > 0) {
          newlyCrossed = {
            ...newlyCrossed,
            blocking: newlyCrossed.blocking.map((effect) => ({
              ...effect,
              reason: effect.reason ? `Forced crossing: ${effect.reason}` : "Forced crossing without a revert handler.",
            })),
          };
        }
        const mergedReport = {
          blocking: [...boundary.report.blocking, ...newlyCrossed.blocking],
          revertible: [...boundary.report.revertible, ...newlyCrossed.revertible],
          warnings: [...boundary.report.warnings, ...newlyCrossed.warnings],
        };
        if (params.autoRun === true && params.force !== true && newlyCrossed.blocking.length > 0) {
          return yield* Effect.fail(
            new SmithersError(
              "TIME_TRAVEL_SIDE_EFFECT_BLOCKED",
              `Time travel is blocked by ${mergedReport.blocking.length} external side effect${mergedReport.blocking.length === 1 ? "" : "s"}.`,
              {
                runId: parentRunId,
                operation: params.operation ?? "fork",
                report: mergedReport,
              },
            ),
          );
        }
        if (params.autoRun === true && params.force === true && newlyCrossed.blocking.length > 0) {
          yield* Effect.tryPromise({
            try: () =>
              recordForcedEffectBoundary(adapter, {
                runId: parentRunId,
                operation: params.operation ?? "fork",
                opId: boundary.opId,
                report: newlyCrossed,
              }),
            catch: (cause) =>
              toSmithersError(cause, "record raced fork side effects", {
                code: "DB_WRITE_FAILED",
                details: { parentRunId, childRunId },
              }),
          });
        }
        boundary = {
          ...boundary,
          report: mergedReport,
          forced:
            boundary.forced || (params.autoRun === true && params.force === true && newlyCrossed.blocking.length > 0),
        };
      }),
    );
    yield* Metric.update(runForksCreated, 1);
    if (boundary.report.warnings.length > 0 && params.autoRun !== true) {
      const event = {
        type: "SideEffectBoundaryCrossed",
        runId: childRunId,
        parentRunId,
        opId: boundary.opId,
        operation: "fork",
        warningOnly: true,
        report: boundary.report,
        timestampMs: nowMs(),
      };
      yield* adapter.insertEventWithNextSeq({
        runId: childRunId,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson: JSON.stringify(event),
      });
    }
    yield* Effect.logInfo("Run forked").pipe(
      Effect.annotateLogs({
        parentRunId,
        parentFrameNo: String(frameNo),
        childRunId,
        branchLabel: branchLabel ?? "",
      }),
    );
    return { runId: childRunId, branch, snapshot: childSnapshot, effectBoundary: boundary.report };
  }).pipe(
    Effect.annotateLogs({
      parentRunId: params.parentRunId,
      parentFrameNo: String(params.frameNo),
    }),
    Effect.withLogSpan("time-travel:fork-run"),
  );
}
