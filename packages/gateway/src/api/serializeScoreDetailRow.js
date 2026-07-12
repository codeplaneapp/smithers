import { normalizeApiRow } from "./normalizeApiRow.js";
import { serializeComparisonScoreRow } from "./serializeComparisonScoreRow.js";

/** @typedef {import("../rpc/gatewayRpcTypes.ts").GatewayScoreDetail} GatewayScoreDetail */

/**
 * Serialize an already-decoded score detail row. JSON parsing deliberately
 * stays in the server so malformed persistence can fail explicitly instead of
 * being hidden by a wire serializer.
 * @param {Record<string, unknown>} row
 * @returns {GatewayScoreDetail}
 */
export function serializeScoreDetailRow(row) {
  const normalized = normalizeApiRow(row);
  return /** @type {GatewayScoreDetail} */ (/** @type {unknown} */ ({
    ...serializeComparisonScoreRow(row),
    meta: normalized.meta ?? null,
    input: normalized.input ?? null,
    output: normalized.output ?? null,
    groundTruth: normalized.groundTruth ?? null,
    context: normalized.context ?? null,
  }));
}
