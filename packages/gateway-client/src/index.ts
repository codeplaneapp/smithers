export { gatewayBackoffDelay, type GatewayBackoffOptions } from "./gatewayBackoffDelay.ts";
export { GatewayRpcError } from "./GatewayRpcError.ts";
export { SmithersGatewayClient } from "./SmithersGatewayClient.ts";
export type { GatewayStreamReconnectEvent } from "./SmithersGatewayClient.ts";
export { SmithersGatewayConnection } from "./SmithersGatewayConnection.ts";
export type { GatewayEventFrame } from "./GatewayEventFrame.ts";
export type { GatewayResponseFrame } from "./GatewayResponseFrame.ts";
export type { GatewayRpcParams, GatewayRpcPayload, GatewayRpcRequestMap, GatewayRpcResponseMap } from "./GatewayRpcTypeMap.ts";
export type { GatewayUiBootConfig } from "./GatewayUiBootConfig.ts";
export type { SmithersGatewayClientOptions } from "./SmithersGatewayClientOptions.ts";

export {
  GATEWAY_EXTENSION_METHOD_PREFIX,
  GATEWAY_EXTENSION_STREAM_METHOD_PREFIX,
  GATEWAY_EXTENSION_STREAM_EVENT,
  GATEWAY_EXTENSION_STREAM_ERROR,
  GATEWAY_EXTENSION_METHOD_NOT_FOUND_CODE,
  GATEWAY_EXTENSION_BACKPRESSURE_DISCONNECT_CODE,
  GATEWAY_EXTENSION_PAYLOAD_TOO_LARGE_CODE,
  extensionMethodName,
  extensionStreamMethodName,
} from "./GatewayExtensionEnvelope.ts";
export type {
  GatewayExtensionStreamErrorFrame,
  GatewayExtensionStreamFrame,
  GatewayExtensionSubscribeResponse,
} from "./GatewayExtensionEnvelope.ts";

// Declarative sync SDK: TanStack DB collection options backed by the gateway
// RPC + WebSocket transport. React bindings live in
// `@smithers-orchestrator/gateway-react` so the core stays framework-free.
export { createGatewayCollection, type GatewayCollectionConfig } from "./sync/createGatewayCollection.ts";
// Cloud-Electric source: the sibling of `createGatewayCollection` that feeds the
// same `CollectionConfig` from an ElectricSQL shape instead of the gateway RPC +
// WS transport. Selected by the registry when the `electric` sync source is set.
export {
  createElectricCollection,
  type ElectricCollectionConfig,
  type ElectricCollectionDef,
  type ElectricRawRow,
} from "./sync/createElectricCollection.ts";
export { electricCollectionDefs, mapMemoryFactRow } from "./sync/electricCollectionDefs.ts";
export { flattenGatewayRunNode } from "./sync/flattenGatewayRunNode.ts";
export { snapshotToGatewayRunNode } from "./sync/snapshotToGatewayRunNode.ts";
export type { DevToolsSnapshot, DevToolsSnapshotNode } from "./sync/snapshotToGatewayRunNode.ts";
export { gatewayCollectionDefs } from "./sync/gatewayCollectionDefs.ts";
export { reconcileSnapshotNodes } from "./sync/reconcileSnapshotNodes.ts";
export type { GatewayApprovalRow } from "./sync/GatewayApprovalRow.ts";
export type { GatewayCronRow } from "./sync/GatewayCronRow.ts";
export type { GatewayMemoryFactRow } from "./sync/GatewayMemoryFactRow.ts";
export type { GatewayPromptRow } from "./sync/GatewayPromptRow.ts";
export type { GatewayScoreRow } from "./sync/GatewayScoreRow.ts";
export type { GatewayDocKind, GatewayTicketRow } from "./sync/GatewayTicketRow.ts";
export type { GatewayRunEventRow } from "./sync/GatewayRunEventRow.ts";
export type { GatewayRunNode } from "./sync/GatewayRunNode.ts";
export { runNodeKey } from "./sync/GatewayRunNode.ts";
export type { GatewayRunRow } from "./sync/GatewayRunRow.ts";
export type { GatewayRunSummaryRow } from "./sync/GatewayRunSummaryRow.ts";
export type { GatewayWorkflowRow } from "./sync/GatewayWorkflowRow.ts";
export { syncBackoffDelay } from "./sync/SyncBackoff.ts";
export type { SyncBackoffOptions } from "./sync/SyncBackoff.ts";
export { syncKeyFingerprint, syncKeyMatches } from "./sync/SyncKey.ts";
export type { SyncKey } from "./sync/SyncKey.ts";
export type {
  SyncRpcOptions,
  SyncStreamFrame,
  SyncStreamOptions,
  SyncTransport,
} from "./sync/SyncTransport.ts";
export { gatewayKeys } from "./sync/gatewayKeys.ts";
export {
  createSmithersGatewayTransport,
  type CreateSmithersGatewayTransportOptions,
  type SmithersGatewayStreamScope,
} from "./sync/createSmithersGatewayTransport.ts";
