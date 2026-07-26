/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./CrossedEffect.ts").CrossedEffect} CrossedEffect */
/** @typedef {import("./EffectBoundaryParams.ts").EffectBoundaryParams} EffectBoundaryParams */
/** @typedef {import("./EffectBoundaryReport.ts").EffectBoundaryReport} EffectBoundaryReport */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function asBoolean(value) {
  return value === true || value === 1 || value === "1";
}

/**
 * @param {Record<string, unknown>} row
 * @returns {"succeeded" | "unknown" | null}
 */
function effectStatus(row) {
  if (row.revertStatus === "revert-stale") {
    return row.status === "succeeded" ? "succeeded" : "unknown";
  }
  if (row.revertStatus === "reverted" || row.status === "reverted") return null;
  if (row.revertStatus === "reverting" || row.revertStatus === "revert-failed") {
    return "unknown";
  }
  if (row.status === "succeeded") return "succeeded";
  if (row.status === "unknown" || row.status === "intended" || row.status === "started" || row.status === "failed")
    return "unknown";
  return null;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
function isLegacy(row) {
  return (
    row.kind == null &&
    row.sideEffect == null &&
    row.idempotent == null &&
    row.acceptsIdempotencyKey == null &&
    row.hasRevert == null
  );
}

/**
 * @param {Record<string, unknown>} row
 * @param {EffectBoundaryParams["toolMetadata"]} metadata
 * @returns {{ kind: "tool" | "task"; sideEffect: boolean; idempotent: boolean; hasRevert: boolean } | null}
 */
function classify(row, metadata) {
  if (!isLegacy(row)) {
    return {
      kind: row.kind === "task" ? "task" : "tool",
      sideEffect: asBoolean(row.sideEffect),
      idempotent: asBoolean(row.idempotent),
      hasRevert: asBoolean(row.hasRevert),
    };
  }
  const defined = metadata?.get(String(row.toolName ?? ""));
  if (!defined) return null;
  return {
    kind: "tool",
    sideEffect: defined.sideEffect,
    idempotent: defined.idempotent,
    hasRevert: defined.hasRevert === true,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {"succeeded" | "unknown"} status
 * @param {{ kind: "tool" | "task"; idempotent: boolean; hasRevert: boolean }} classification
 * @param {string | undefined} reason
 * @returns {CrossedEffect}
 */
function crossedEffect(row, status, classification, reason) {
  return {
    kind: classification.kind,
    toolName: String(row.toolName ?? ""),
    nodeId: String(row.nodeId ?? ""),
    iteration: Number(row.iteration ?? 0),
    attempt: Number(row.attempt ?? 0),
    seq: Number(row.seq ?? 0),
    effectStatus: status,
    idempotent: classification.idempotent,
    hasRevert: classification.hasRevert,
    startedAtMs: Number(row.startedAtMs ?? 0),
    ...(reason ? { reason } : {}),
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {EffectBoundaryParams} params
 * @returns {boolean}
 */
function isCrossed(row, params) {
  if (params.attempts) {
    return params.attempts.some(
      (attempt) =>
        attempt.nodeId === row.nodeId &&
        attempt.iteration === Number(row.iteration ?? 0) &&
        attempt.attempt === Number(row.attempt ?? 0),
    );
  }
  return Number(row.startedAtMs ?? -1) >= Number(params.cutoffMs ?? 0);
}

/**
 * Assess the external effects crossed by a destructive or branching
 * time-travel boundary. This function only classifies; callers decide whether
 * to compensate, block, warn, or force the crossing.
 *
 * @param {SmithersDb} db
 * @param {EffectBoundaryParams} params
 * @returns {Promise<EffectBoundaryReport>}
 */
export async function assessEffectBoundary(db, params) {
  const [liveRows, archivedRows] = await Promise.all([
    db.internalStorage.queryAll(
      `SELECT * FROM _smithers_tool_calls WHERE run_id = ? ORDER BY started_at_ms DESC, seq DESC`,
      [params.runId],
      { booleanColumns: ["sideEffect", "idempotent", "acceptsIdempotencyKey", "hasRevert"] },
    ),
    db.internalStorage.queryAll(
      `SELECT * FROM _smithers_tool_call_archive WHERE run_id = ? ORDER BY started_at_ms DESC, seq DESC`,
      [params.runId],
      { booleanColumns: ["sideEffect", "idempotent", "acceptsIdempotencyKey", "hasRevert"] },
    ),
  ]);
  /** @type {EffectBoundaryReport} */
  const report = { blocking: [], revertible: [], warnings: [] };

  for (const row of [...liveRows, ...archivedRows]) {
    if (!isCrossed(row, params)) continue;
    const status = effectStatus(row);
    if (!status) continue;
    const legacy = isLegacy(row);
    const classification = classify(row, params.toolMetadata);
    const archived = "archivedByOp" in row || "archived_by_op" in row;
    if (legacy) {
      const registryDetail = classification
        ? ` Current registry classification: sideEffect=${classification.sideEffect}, hasRevert=${classification.hasRevert}.`
        : "";
      report.warnings.push(
        crossedEffect(
          row,
          status,
          {
            kind: classification?.kind ?? "tool",
            idempotent: classification?.idempotent ?? false,
            hasRevert: classification?.hasRevert ?? false,
          },
          `Legacy effect flags are warning-only.${registryDetail}`,
        ),
      );
      continue;
    }
    if (!classification) {
      report.warnings.push(
        crossedEffect(
          row,
          status,
          {
            kind: "tool",
            idempotent: false,
            hasRevert: false,
          },
          "Effect flags are unclassified.",
        ),
      );
      continue;
    }
    if (!classification.sideEffect) continue;
    const effect = crossedEffect(
      row,
      status,
      classification,
      archived ? "Previously forced effect is archived and will not block again." : undefined,
    );
    if (archived) {
      report.warnings.push(effect);
    } else if (classification.hasRevert) {
      report.revertible.push(effect);
    } else {
      report.blocking.push(effect);
    }
  }

  return report;
}
