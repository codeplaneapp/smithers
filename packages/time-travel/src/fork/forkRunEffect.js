import { Effect, Metric } from "effect";
import { createHash } from "node:crypto";
import { toSmithersError } from "@smthrs/errors/toSmithersError";
import { nowMs } from "@smthrs/scheduler/nowMs";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { smithersBranches } from "../schema.js";
import { persistSnapshotRow, snapshotContentHashFromJson } from "../snapshot/captureSnapshotEffect.js";
import { loadSnapshot } from "../snapshot/loadSnapshotEffect.js";
import { parseSnapshot } from "../snapshot/parseSnapshot.js";
import { agentCheckpointHorizonKey, parseAgentCheckpointHorizons } from "../snapshot/agentCheckpointHorizons.js";
import { parseAgentCheckpointProvenance } from "../snapshot/agentCheckpointProvenance.js";
import { parseSnapshotJson } from "../snapshot/parseSnapshotJson.js";
import { runForksCreated } from "../runForksCreated.js";
import { acquireRewindLock } from "../acquireRewindLock.js";
import { expandResetSet } from "./_helpers.js";
import { guardEffectBoundary } from "../guardEffectBoundary.js";
import { assessEffectBoundary } from "../assessEffectBoundary.js";
import { recordForcedEffectBoundary } from "../recordForcedEffectBoundary.js";
import { isRunLikelyLive } from "../isRunLikelyLive.js";
/** @typedef {import("../BranchInfo.ts").BranchInfo} BranchInfo */
/** @typedef {import("../ForkParams.ts").ForkParams} ForkParams */
/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("../snapshot/Snapshot.ts").Snapshot} Snapshot */

const DURABILITY_CONFIG_KEY = "__smithersDurability";
const DURABILITY_METADATA_VERSION = 2;
const CHECKPOINT_COPY_TUPLES_PER_QUERY = 150;

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
 * Copy the attempt history and checkpoint references visible to finished nodes
 * inherited unchanged from the selected snapshot. Reset nodes deliberately
 * have no child attempt history, preserving reset's attempt-1 contract.
 * Checkpoint content is immutable and
 * content-addressed, so the child reference deliberately shares it; that new
 * reference also keeps the content alive if the parent is later deleted.
 *
 * @param {SmithersDb} adapter
 * @param {string} parentRunId
 * @param {string} childRunId
 * @param {number} parentFrameNo
 * @param {string} sourceNodesJson
 * @param {string} childNodesJson
 * @param {string} sourceOutputsJson
 * @param {number} sourceCreatedAtMs
 */
async function copyInheritedAgentCheckpoints(
  adapter,
  parentRunId,
  childRunId,
  parentFrameNo,
  sourceNodesJson,
  childNodesJson,
  sourceOutputsJson,
  sourceCreatedAtMs,
) {
  const nodes = JSON.parse(sourceNodesJson);
  const childNodes = JSON.parse(childNodesJson);
  if (!Array.isArray(nodes) || !Array.isArray(childNodes)) return;
  const inherited = new Set(
    childNodes
      .filter(
        (node) =>
          node &&
          typeof node === "object" &&
          typeof node.nodeId === "string" &&
          Number.isInteger(node.iteration) &&
          Number.isInteger(node.lastAttempt),
      )
      .map((node) => `${node.nodeId}::${node.iteration}::${node.lastAttempt}`),
  );
  const horizons = new Map();
  for (const node of nodes) {
    // Fork inherits only finished nodes that survived reset expansion.
    if (
      node &&
      typeof node === "object" &&
      typeof node.nodeId === "string" &&
      node.state === "finished" &&
      Number.isInteger(node.iteration) &&
      Number.isInteger(node.lastAttempt) &&
      node.lastAttempt >= 0 &&
      inherited.has(`${node.nodeId}::${node.iteration}::${node.lastAttempt}`)
    ) {
      horizons.set(`${node.nodeId}::${node.iteration}`, node.lastAttempt);
    }
  }
  if (horizons.size === 0) return;

  const sourceOutputs = JSON.parse(sourceOutputsJson);
  const exactHorizons = parseAgentCheckpointHorizons(sourceOutputs);
  const snapshotProvenance = parseAgentCheckpointProvenance(sourceOutputs);
  const refs = [];
  let attempts;
  if (snapshotProvenance) {
    for (const tuple of snapshotProvenance.checkpoints) {
      refs.push({
        nodeId: tuple[0],
        iteration: tuple[1],
        attempt: tuple[2],
        sequence: tuple[3],
        contentHash: tuple[4],
        codec: tuple[5],
        version: tuple[6],
        agentId: tuple[7],
        purpose: tuple[8],
        createdAtMs: tuple[9],
        checkpointJson: tuple[10],
        sizeBytes: tuple[11],
        contentCreatedAtMs: tuple[12],
      });
    }
    attempts = snapshotProvenance.attempts.map((tuple) => ({
      nodeId: tuple[0],
      iteration: tuple[1],
      attempt: tuple[2],
      state: tuple[3],
      startedAtMs: tuple[4],
      finishedAtMs: tuple[5],
      heartbeatAtMs: tuple[6],
      heartbeatDataJson: tuple[7],
      errorJson: tuple[8],
      jjPointer: tuple[9],
      cached: tuple[10],
      metaJson: tuple[11],
      responseText: tuple[12],
      jjCwd: tuple[13],
    }));
  } else if (exactHorizons) {
    const targets = nodes
      .filter((node) => horizons.get(`${node.nodeId}::${Number(node.iteration)}`) === node.lastAttempt)
      .map((node) => [
        node.nodeId,
        Number(node.iteration),
        Number(node.lastAttempt),
        exactHorizons.get(agentCheckpointHorizonKey(node.nodeId, Number(node.iteration), Number(node.lastAttempt))) ??
          -1,
      ]);
    for (let offset = 0; offset < targets.length; offset += CHECKPOINT_COPY_TUPLES_PER_QUERY) {
      const chunk = targets.slice(offset, offset + CHECKPOINT_COPY_TUPLES_PER_QUERY);
      const valuesSql = chunk.map(() => "(?, CAST(? AS BIGINT), CAST(? AS BIGINT), CAST(? AS BIGINT))").join(", ");
      refs.push(
        ...(await adapter.internalStorage.queryAll(
          `WITH inherited(node_id, iteration, last_attempt, sequence) AS (VALUES ${valuesSql})
           SELECT checkpoint.*
             FROM _smithers_agent_checkpoints checkpoint
             JOIN inherited
               ON inherited.node_id = checkpoint.node_id
              AND inherited.iteration = checkpoint.iteration
            WHERE checkpoint.run_id = ?
              AND (checkpoint.attempt < inherited.last_attempt OR
                   (checkpoint.attempt = inherited.last_attempt AND checkpoint.sequence <= inherited.sequence))
            ORDER BY checkpoint.node_id, checkpoint.iteration, checkpoint.attempt, checkpoint.sequence`,
          [...chunk.flat(), parentRunId],
        )),
      );
    }
  } else {
    refs.push(
      ...(await adapter.internalStorage.queryAll(
        `SELECT * FROM _smithers_agent_checkpoints
          WHERE run_id = ? AND created_at_ms <= ?
          ORDER BY node_id, iteration, attempt, sequence`,
        [parentRunId, sourceCreatedAtMs],
      )),
    );
  }
  const inheritedRefs = refs.filter((ref) => {
    const nodeId = ref.nodeId ?? ref.node_id;
    const iteration = Number(ref.iteration);
    const attemptNo = Number(ref.attempt);
    const horizon = horizons.get(`${nodeId}::${iteration}`);
    if (horizon === undefined || attemptNo > horizon) return false;
    if (!exactHorizons || attemptNo < horizon) return true;
    const sequenceHorizon = exactHorizons.get(agentCheckpointHorizonKey(nodeId, iteration, attemptNo));
    return sequenceHorizon !== undefined && Number(ref.sequence) <= sequenceHorizon;
  });
  attempts ??= await adapter.internalStorage.queryAll(
    `SELECT * FROM _smithers_attempts WHERE run_id = ? ORDER BY node_id, iteration, attempt`,
    [parentRunId],
    { booleanColumns: ["cached"] },
  );
  const copiedAttempts = new Set();
  for (const attempt of attempts) {
    const nodeId = attempt.nodeId ?? attempt.node_id;
    const iteration = Number(attempt.iteration);
    const attemptNo = Number(attempt.attempt);
    const horizon = horizons.get(`${nodeId}::${iteration}`);
    const attemptKey = `${nodeId}::${iteration}::${attemptNo}`;
    // Preserve the complete visible lineage. A successful retry may consume a
    // checkpoint owned by an earlier failed attempt without emitting a new
    // checkpoint of its own; its conversation is still the downstream fork
    // source.
    if (horizon === undefined || attemptNo > horizon) continue;
    let parentMeta = {};
    if (typeof (attempt.metaJson ?? attempt.meta_json) === "string") {
      try {
        const parsed = JSON.parse(attempt.metaJson ?? attempt.meta_json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) parentMeta = parsed;
      } catch {
        parentMeta = { inheritedParentMetaJson: attempt.metaJson ?? attempt.meta_json };
      }
    }
    await adapter.internalStorage.insertIgnore("_smithers_attempts", {
      runId: childRunId,
      nodeId,
      iteration,
      attempt: attemptNo,
      state: attempt.state,
      startedAtMs: Number(attempt.startedAtMs ?? attempt.started_at_ms),
      finishedAtMs: attempt.finishedAtMs ?? attempt.finished_at_ms ?? null,
      heartbeatAtMs: attempt.heartbeatAtMs ?? attempt.heartbeat_at_ms ?? null,
      heartbeatDataJson: attempt.heartbeatDataJson ?? attempt.heartbeat_data_json ?? null,
      errorJson: attempt.errorJson ?? attempt.error_json ?? null,
      jjPointer: attempt.jjPointer ?? attempt.jj_pointer ?? null,
      cached: Boolean(attempt.cached),
      metaJson: JSON.stringify({
        ...parentMeta,
        inheritedCheckpointFrom: {
          runId: parentRunId,
          frameNo: parentFrameNo,
          nodeId,
          iteration,
          attempt: attemptNo,
        },
      }),
      responseText: attempt.responseText ?? attempt.response_text ?? null,
      jjCwd: attempt.jjCwd ?? attempt.jj_cwd ?? null,
    });
    copiedAttempts.add(attemptKey);
  }

  for (const ref of inheritedRefs) {
    const nodeId = ref.nodeId ?? ref.node_id;
    const iteration = Number(ref.iteration);
    const attemptNo = Number(ref.attempt);
    if (!copiedAttempts.has(`${nodeId}::${iteration}::${attemptNo}`)) continue;
    const checkpointJson = ref.checkpointJson ?? ref.checkpoint_json;
    if (typeof checkpointJson === "string") {
      const contentHash = ref.contentHash ?? ref.content_hash;
      const sizeBytes = Number(ref.sizeBytes ?? ref.size_bytes);
      if (
        Buffer.byteLength(checkpointJson, "utf8") !== sizeBytes ||
        createHash("sha256").update(checkpointJson).digest("hex") !== contentHash
      ) {
        throw new Error(`Checkpoint content hash mismatch in snapshot: ${contentHash}`);
      }
      await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoint_contents", {
        contentHash,
        checkpointJson,
        sizeBytes,
        createdAtMs: Number(ref.contentCreatedAtMs ?? ref.content_created_at_ms),
      });
      const storedContent = await adapter.internalStorage.queryOne(
        `SELECT checkpoint_json, size_bytes
           FROM _smithers_agent_checkpoint_contents
          WHERE content_hash = ? LIMIT 1`,
        [contentHash],
      );
      if (
        !storedContent ||
        (storedContent.checkpointJson ?? storedContent.checkpoint_json) !== checkpointJson ||
        Number(storedContent.sizeBytes ?? storedContent.size_bytes) !== sizeBytes
      ) {
        throw new Error(`Checkpoint content hash collision or corruption: ${contentHash}`);
      }
    }
    await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoints", {
      runId: childRunId,
      nodeId,
      iteration,
      attempt: attemptNo,
      sequence: Number(ref.sequence),
      contentHash: ref.contentHash ?? ref.content_hash,
      codec: ref.codec,
      version: Number(ref.version),
      agentId: ref.agentId ?? ref.agent_id ?? null,
      purpose: ref.purpose,
      createdAtMs: Number(ref.createdAtMs ?? ref.created_at_ms),
    });
  }
}

/**
 * @param {SmithersDb} adapter
 * @param {ForkParams} params
 * @returns {Effect.Effect<{ runId: string; branch: BranchInfo; snapshot: Snapshot; effectBoundary: import("../EffectBoundaryReport.ts").EffectBoundaryReport }, SmithersError>}
 */
function forkRunWhileLocked(adapter, params, rewindLock) {
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
        // Fence the source read and child commit with the durable rewind lease.
        // PostgreSQL holds this lease-row update through transaction commit;
        // SQLite's writer transaction provides the equivalent serialization.
        const leaseHeld = yield* Effect.tryPromise({
          try: () => rewindLock.checkStillHeld(),
          catch: (cause) =>
            toSmithersError(cause, "verify fork rewind lease", {
              code: "DB_QUERY_FAILED",
              details: { parentRunId, frameNo },
            }),
        });
        if (!leaseHeld) {
          return yield* Effect.fail(
            new SmithersError("DB_QUERY_FAILED", `Fork lease ownership was lost for ${parentRunId}.`, {
              parentRunId,
              frameNo,
            }),
          );
        }
        const lockedSource = yield* loadSnapshot(adapter, parentRunId, frameNo);
        if (
          !lockedSource ||
          lockedSource.contentHash !== source.contentHash ||
          lockedSource.createdAtMs !== source.createdAtMs ||
          lockedSource.nodesJson !== source.nodesJson ||
          lockedSource.outputsJson !== source.outputsJson
        ) {
          return yield* Effect.fail(
            new SmithersError("DB_QUERY_FAILED", `Source snapshot ${parentRunId}:${frameNo} changed during fork.`, {
              parentRunId,
              frameNo,
            }),
          );
        }
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
            copyInheritedAgentCheckpoints(
              adapter,
              parentRunId,
              childRunId,
              frameNo,
              lockedSource.nodesJson,
              nodesJson,
              lockedSource.outputsJson,
              lockedSource.createdAtMs,
            ),
          catch: (cause) =>
            toSmithersError(cause, "copy inherited agent checkpoints", {
              code: "DB_WRITE_FAILED",
              details: { parentRunId, childRunId, frameNo },
            }),
        });
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

export function forkRun(adapter, params) {
  return Effect.gen(function* () {
    const rewindLock = yield* Effect.tryPromise({
      try: () => acquireRewindLock(adapter, params.parentRunId),
      catch: (cause) =>
        toSmithersError(cause, "acquire fork rewind lease", {
          code: "DB_QUERY_FAILED",
          details: { parentRunId: params.parentRunId, frameNo: params.frameNo },
        }),
    });
    if (!rewindLock) {
      return yield* Effect.fail(
        new SmithersError("DB_QUERY_FAILED", `Another rewind or fork is already running for ${params.parentRunId}.`, {
          parentRunId: params.parentRunId,
          frameNo: params.frameNo,
        }),
      );
    }
    return yield* forkRunWhileLocked(adapter, params, rewindLock).pipe(
      Effect.ensuring(
        Effect.promise(() =>
          rewindLock
            .release()
            .then(() => undefined)
            .catch(() => undefined),
        ),
      ),
    );
  });
}
