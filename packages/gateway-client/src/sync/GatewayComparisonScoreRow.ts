import type { GatewayComparisonScoreRow as ProtocolGatewayComparisonScoreRow } from "@smithers-orchestrator/protocol/gateway-rpc";

/**
 * One score row returned by the cross-run `listScoresForRuns` query.
 *
 * The stable score id is included so callers can fetch the larger detail row
 * on demand. Persisted JSON detail fields are deliberately excluded from this
 * list shape. The query takes explicit scorer-producing run ids; it does not
 * discover child case runs from an eval wrapper or align experiments/cases.
 */
export type GatewayComparisonScoreRow = ProtocolGatewayComparisonScoreRow;
