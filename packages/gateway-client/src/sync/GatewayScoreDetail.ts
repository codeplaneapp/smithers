import type { GatewayComparisonScoreRow } from "./GatewayComparisonScoreRow.ts";

/**
 * A single persisted score with its JSON payloads decoded by the gateway.
 *
 * Each detail value is always present. SQL NULL and stored JSON null are both
 * represented as JavaScript `null` at the wire boundary.
 */
export type GatewayScoreDetail = GatewayComparisonScoreRow & {
  meta: unknown;
  input: unknown;
  output: unknown;
  groundTruth: unknown;
  context: unknown;
};
