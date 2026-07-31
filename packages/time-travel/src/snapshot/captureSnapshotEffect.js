import { Effect, Metric } from "effect";
import { toSmithersError } from "@smthrs/errors/toSmithersError";
import { createHash } from "node:crypto";
import { nowMs } from "@smthrs/scheduler/nowMs";
import { snapshotsCaptured } from "../snapshotsCaptured.js";
import { snapshotDuration } from "../snapshotDuration.js";
import { parseAgentCheckpointSnapshot } from "./agentCheckpointSnapshot.js";
/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smthrs/errors/SmithersError").SmithersError} SmithersError */
import { captureAgentCheckpointProvenance } from "./agentCheckpointProvenance.js";
/** @typedef {import("./Snapshot.ts").Snapshot} Snapshot */
/** @typedef {import("./SnapshotData.ts").SnapshotData} SnapshotData */

/**
 * @param {string} nodesJson
 * @param {string} outputsJson
 * @param {string} ralphJson
 * @param {string} inputJson
 * @returns {string}
 */
export function snapshotContentHashFromJson(nodesJson, outputsJson, ralphJson, inputJson) {
  return createHash("sha256")
    .update(`{"nodes":${nodesJson},"outputs":${outputsJson},"ralph":${ralphJson},"input":${inputJson}}`)
    .digest("hex");
}

/** @param {string} payloadB64 @returns {Promise<Buffer>} */
async function gunzipLegacyPayload(payloadB64) {
  // This compatibility branch is only reachable for the unreleased local
  // SQLite prototype. Keep zlib out of the normal/edge runtime path.
  const { gunzip } = await import("node:zlib");
  return new Promise((resolve, reject) => {
    gunzip(Buffer.from(payloadB64, "base64"), (error, result) => (error ? reject(error) : resolve(result)));
  });
}

function isPostgres(adapter) {
  return adapter.internalStorage?.dialect === "postgres";
}

/** @param {SmithersDb} adapter @param {Record<string, unknown>} row */
async function persistSnapshotRowUnsafe(adapter, row) {
  const content = {
    contentHash: row.contentHash,
    nodesJson: row.nodesJson,
    outputsJson: row.outputsJson,
    ralphJson: row.ralphJson,
    inputJson: row.inputJson,
    refCount: 0,
  };
  // The hash is only an address. Return and compare the exact stored bytes so
  // a collision or corrupt row cannot be referenced. PostgreSQL must resolve
  // the conflict and lock the content row in one statement. At READ COMMITTED,
  // INSERT DO NOTHING followed by SELECT FOR UPDATE leaves a statement gap
  // where last-reference cleanup can delete the row. The no-op update takes
  // the row lock, and RETURNING reads the locked version. SQLite serializes
  // the writer transaction, so its existing insert and read path is safe.
  const contentParams = [
    content.contentHash,
    content.nodesJson,
    content.outputsJson,
    content.ralphJson,
    content.inputJson,
    content.refCount,
  ];
  let existing;
  if (isPostgres(adapter)) {
    existing = await adapter.internalStorage.queryOne(
      `INSERT INTO _smithers_snapshot_contents
             (content_hash, nodes_json, outputs_json, ralph_json, input_json, ref_count)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (content_hash) DO UPDATE
             SET ref_count = _smithers_snapshot_contents.ref_count
             RETURNING nodes_json, outputs_json, ralph_json, input_json`,
      contentParams,
    );
  } else {
    await adapter.internalStorage.execute(
      `INSERT INTO _smithers_snapshot_contents
             (content_hash, nodes_json, outputs_json, ralph_json, input_json, ref_count)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (content_hash) DO NOTHING`,
      contentParams,
    );
    existing = await adapter.internalStorage.queryOne(
      `SELECT nodes_json, outputs_json, ralph_json, input_json
             FROM _smithers_snapshot_contents
             WHERE content_hash = ?
             LIMIT 1`,
      [row.contentHash],
    );
  }
  if (
    !existing ||
    existing.nodesJson !== content.nodesJson ||
    existing.outputsJson !== content.outputsJson ||
    existing.ralphJson !== content.ralphJson ||
    existing.inputJson !== content.inputJson
  ) {
    throw new Error(`Snapshot content hash collision or corruption: ${row.contentHash}`);
  }
  await adapter.internalStorage.upsert(
    "_smithers_snapshots",
    {
      ...row,
      nodesJson: "",
      outputsJson: "",
      ralphJson: "",
      inputJson: "",
    },
    ["runId", "frameNo"],
  );
  await adapter.internalStorage.upsert(
    "_smithers_snapshot_payload_refs",
    {
      runId: row.runId,
      frameNo: row.frameNo,
      contentHash: row.contentHash,
    },
    ["runId", "frameNo"],
  );
}

/**
 * Persist a fully materialized snapshot row. `inTransaction` is reserved for
 * engine/fork callers that already own the adapter transaction containing the
 * related frame/run writes.
 * @param {SmithersDb} adapter
 * @param {Record<string, unknown>} row
 * @param {{ inTransaction?: boolean }} [options]
 */
export async function persistSnapshotRow(adapter, row, options = {}) {
  const operation = Effect.promise(() => persistSnapshotRowUnsafe(adapter, row));
  return options.inTransaction === true
    ? Effect.runPromise(operation)
    : adapter.withTransaction("snapshot payload", operation);
}

/**
 * Hydrate a row returned by the snapshot/content LEFT JOIN. The `payloadHash`
 * branch only reads the unreleased gzip prototype used by existing dogfood
 * stores; new writes never compress or populate that column/table.
 * @param {SmithersDb} adapter
 * @param {Snapshot & Record<string, unknown>} row
 * @returns {Promise<Snapshot>}
 */
export async function hydrateSnapshot(adapter, row) {
  const {
    payloadHash,
    referencedContentHash,
    payloadNodesJson,
    payloadOutputsJson,
    payloadRalphJson,
    payloadInputJson,
    ...snapshot
  } = row;
  const compact =
    snapshot.nodesJson === "" && snapshot.outputsJson === "" && snapshot.ralphJson === "" && snapshot.inputJson === "";
  if (referencedContentHash != null) {
    if (!compact || referencedContentHash !== snapshot.contentHash) {
      throw new Error(`Snapshot content reference mismatch ${String(referencedContentHash)}`);
    }
    if (
      [payloadNodesJson, payloadOutputsJson, payloadRalphJson, payloadInputJson].some(
        (value) => typeof value !== "string",
      )
    ) {
      throw new Error(`Missing snapshot content ${String(referencedContentHash)}`);
    }
    return {
      ...snapshot,
      nodesJson: payloadNodesJson,
      outputsJson: payloadOutputsJson,
      ralphJson: payloadRalphJson,
      inputJson: payloadInputJson,
    };
  }
  if (!compact) {
    return snapshot;
  }
  // Store migration intentionally drops the prototype-only payload_hash
  // column when the destination has the final unchanged snapshot schema.
  // content_hash is the same address, so it remains a lossless fallback.
  const legacyHash = typeof payloadHash === "string" && payloadHash.length > 0 ? payloadHash : snapshot.contentHash;
  let legacy;
  try {
    legacy = await adapter.internalStorage.queryOne(
      "SELECT payload_b64 FROM _smithers_snapshot_payloads WHERE content_hash = ? LIMIT 1",
      [legacyHash],
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/no such table|does not exist/i.test(message)) {
      throw new Error(`Compact snapshot ${snapshot.runId}:${snapshot.frameNo} has no content reference`);
    }
    throw cause;
  }
  if (!legacy || typeof legacy.payloadB64 !== "string") {
    throw new Error(`Missing legacy snapshot payload ${legacyHash}`);
  }
  const raw = (await gunzipLegacyPayload(legacy.payloadB64)).toString("utf8");
  const actualHash = createHash("sha256").update(raw).digest("hex");
  if (legacyHash !== snapshot.contentHash || actualHash !== legacyHash) {
    throw new Error(`Legacy snapshot payload hash mismatch ${legacyHash}`);
  }
  const decoded = JSON.parse(raw);
  return {
    ...snapshot,
    nodesJson: JSON.stringify(decoded.nodes),
    outputsJson: JSON.stringify(decoded.outputs),
    ralphJson: JSON.stringify(decoded.ralph),
    inputJson: JSON.stringify(decoded.input),
  };
}

export function captureSnapshot(adapter, runId, frameNo, data, options = {}) {
  const operation = Effect.gen(function* () {
    const start = performance.now();
    const nodesJson = JSON.stringify(data.nodes);
    const signalHorizon = yield* Effect.tryPromise({
      try: async () =>
        Number(
          (
            await adapter.internalStorage.queryOne(
              "SELECT COALESCE(MAX(seq), -1) AS seq FROM _smithers_signals WHERE run_id = ?",
              [runId],
            )
          )?.seq ?? -1,
        ),
      catch: (cause) => cause,
    });
    const agentCheckpointCapture = yield* Effect.tryPromise({
      try: () => captureAgentCheckpointProvenance(adapter, runId, data.nodes),
      catch: (cause) => cause,
    });
    const snapshotOutputs = {
      ...data.outputs,
      __smithersSignalProvenanceHorizon: signalHorizon,
      __smithersAgentCheckpointHorizons: agentCheckpointCapture.horizons,
      __smithersAgentCheckpointProvenance: agentCheckpointCapture.provenance,
    };
    parseAgentCheckpointSnapshot(snapshotOutputs, data.nodes);
    const outputsJson = JSON.stringify(snapshotOutputs);
    const ralphJson = JSON.stringify(data.ralph);
    const inputJson = JSON.stringify(data.input);
    const contentHash = snapshotContentHashFromJson(nodesJson, outputsJson, ralphJson, inputJson);
    const row = {
      runId,
      frameNo,
      nodesJson,
      outputsJson,
      ralphJson,
      inputJson,
      vcsPointer: data.vcsPointer ?? null,
      workflowHash: data.workflowHash ?? null,
      contentHash,
      createdAtMs: nowMs(),
    };
    yield* Effect.tryPromise({
      try: () => persistSnapshotRow(adapter, row, { inTransaction: true }),
      catch: (cause) =>
        toSmithersError(cause, "insert snapshot", { code: "DB_WRITE_FAILED", details: { frameNo, runId } }),
    });
    yield* Metric.update(snapshotsCaptured, 1);
    yield* Metric.update(snapshotDuration, performance.now() - start);
    return row;
  }).pipe(Effect.annotateLogs({ runId, frameNo: String(frameNo) }), Effect.withLogSpan("time-travel:capture-snapshot"));
  return options.inTransaction === true
    ? operation
    : adapter.withTransactionEffect(`capture snapshot ${runId}:${frameNo}`, operation);
}
