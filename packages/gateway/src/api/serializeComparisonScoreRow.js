import { normalizeApiRow } from "./normalizeApiRow.js";
import { serializeScoreRow } from "./serializeScoreRow.js";

/** @typedef {import("../rpc/gatewayRpcTypes.ts").GatewayComparisonScoreRow} GatewayComparisonScoreRow */

/**
 * @param {Record<string, unknown>} row
 * @returns {GatewayComparisonScoreRow}
 */
export function serializeComparisonScoreRow(row) {
  const normalized = normalizeApiRow(row);
  return /** @type {GatewayComparisonScoreRow} */ (
    /** @type {unknown} */ ({
      scoreId: normalized.scoreId ?? normalized.id,
      ...serializeScoreRow(row),
    })
  );
}
