import type { GatewayScoreDetail as ProtocolGatewayScoreDetail } from "@smithers-orchestrator/protocol/gateway-rpc";

/**
 * A single persisted score with its JSON payloads decoded by the gateway.
 *
 * Each detail value is always present. SQL NULL and stored JSON null are both
 * represented as JavaScript `null` at the wire boundary.
 */
export type GatewayScoreDetail = ProtocolGatewayScoreDetail;
