/**
 * Pure row-folding helpers for the delegation-v2 interpreter.
 *
 * The interpreter never treats "latest logical id wins" as identity. Every
 * lookup uses the immutable physical Smithers node id that produced the row.
 * This is what lets superseded generations remain mounted without changing
 * the meaning of a continuation.
 */

/**
 * @param {import("@smithers-orchestrator/driver").SmithersCtx<any> | null | undefined} ctx
 * @param {unknown} target
 * @returns {Record<string, any>[]}
 */
export function readDelegationV2Rows(ctx, target) {
  if (!ctx || target == null) return [];
  try {
    const name = ctx.resolveTableName(target);
    const rows = ctx.outputs(name);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * @param {Record<string, any>[]} rows
 * @param {string} nodeId
 * @param {{ _currentScopes?: Set<string> } | null | undefined} [ctx]
 * @returns {Record<string, any>[]}
 */
export function delegationV2RowsForNode(rows, nodeId, ctx) {
  const exact = rows.filter((row) => row?.nodeId === nodeId);
  if (exact.length > 0 || nodeId.includes("@@") || !ctx?._currentScopes) return exact;
  const scopes = [...ctx._currentScopes].sort((left, right) => right.length - left.length);
  for (const scope of scopes) {
    const scoped = rows.filter((row) => row?.nodeId === nodeId + scope);
    if (scoped.length > 0) return scoped;
  }
  return [];
}

/**
 * Return the newest row for one immutable physical node. Iteration is the
 * primary ordering key and insertion order breaks ties, matching Smithers'
 * append-only output behavior.
 * @param {Record<string, any>[]} rows
 * @param {string} nodeId
 * @param {{ _currentScopes?: Set<string> } | null | undefined} [ctx]
 * @returns {Record<string, any> | undefined}
 */
export function delegationV2RowForNode(rows, nodeId, ctx) {
  let selected;
  let selectedIteration = -Infinity;
  for (const row of delegationV2RowsForNode(rows, nodeId, ctx)) {
    const iteration = Number.isFinite(Number(row?.iteration))
      ? Number(row.iteration)
      : 0;
    if (!selected || iteration >= selectedIteration) {
      selected = row;
      selectedIteration = iteration;
    }
  }
  return selected;
}

/**
 * @param {Record<string, any>[]} outcomeRows
 * @param {readonly string[]} nodeIds
 * @param {{ _currentScopes?: Set<string> } | null | undefined} [ctx]
 * @returns {{ settled: boolean; rows: Record<string, any>[]; missing: string[] }}
 */
export function collectDelegationV2Outcomes(outcomeRows, nodeIds, ctx) {
  const rows = [];
  const missing = [];
  for (const nodeId of nodeIds) {
    const row = delegationV2RowForNode(outcomeRows, nodeId, ctx);
    if (row) rows.push(row);
    else missing.push(nodeId);
  }
  return { settled: missing.length === 0, rows, missing };
}

/**
 * Render a compact, deterministic evidence packet for the next author turn.
 * It is deliberately JSON data with explicit provenance, not prompt text
 * spliced into the system contract.
 *
 * @param {Record<string, any>[]} rows
 * @param {number} [maxChars]
 */
export function buildDelegationV2EvidencePacket(rows, maxChars = 48_000) {
  const ordered = [...rows].sort((a, b) => {
    const left = String(a?.logicalId ?? a?.nodeId ?? "");
    const right = String(b?.logicalId ?? b?.nodeId ?? "");
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const packet = ordered.map((row) => ({
    sourceNodeId: typeof row?.nodeId === "string" ? row.nodeId : undefined,
    logicalId: typeof row?.logicalId === "string" ? row.logicalId : undefined,
    role: row?.role,
    work: row?.work,
	outputContract: row?.outputContract,
	assignmentDigest: row?.assignmentDigest,
	acceptanceCriterionIds: row?.acceptanceCriterionIds,
	programDigest: row?.programDigest,
    status: row?.status,
    product: row?.product,
    blockage: row?.blockage,
    runtimeFailure: row?.runtimeFailure,
  }));
  const json = JSON.stringify(packet);
  if (json.length <= maxChars) return packet;
  return {
    truncated: true,
    originalItems: packet.length,
    jsonPrefix: json.slice(0, Math.max(0, maxChars)),
  };
}
