export { createGatewayReactRoot } from "./createGatewayReactRoot.ts";
export { SmithersGatewayContext } from "./SmithersGatewayContext.ts";
export { SmithersGatewayProvider } from "./SmithersGatewayProvider.ts";
export { useGatewayActions } from "./useGatewayActions.ts";
export { useGatewayApprovals } from "./useGatewayApprovals.ts";
export { useGatewayCrons } from "./useGatewayCrons.ts";
export { useGatewayMemoryFacts } from "./useGatewayMemoryFacts.ts";
export { useGatewayPrompts } from "./useGatewayPrompts.ts";
export { useGatewayScores } from "./useGatewayScores.ts";
export { useGatewayTickets } from "./useGatewayTickets.ts";
export { useGatewayNodeOutput } from "./useGatewayNodeOutput.ts";
export { useGatewayRpc } from "./useGatewayRpc.ts";
export { useGatewayRun } from "./useGatewayRun.ts";
export { useGatewayRunEvents } from "./useGatewayRunEvents.ts";
export { useGatewayRuns } from "./useGatewayRuns.ts";
export { useGatewayWorkflows } from "./useGatewayWorkflows.ts";
export { useSmithersGateway } from "./useSmithersGateway.ts";
export { useGatewayExtensionResource } from "./useGatewayExtensionResource.ts";
export { useGatewayExtensionAction } from "./useGatewayExtensionAction.ts";
export { useGatewayExtensionStream, type GatewayExtensionStreamState } from "./useGatewayExtensionStream.ts";
export type { GatewayAsyncState } from "./GatewayAsyncState.ts";

// Declarative sync SDK React surface. The TanStack DB collection options live in
// `@smithers-orchestrator/gateway-client`; this layer adds the React context,
// the `GatewayCollections` registry, and the hooks (`useSyncQuery` /
// `useSyncMutation` / `useSyncSubscription` + typed gateway shortcuts) backed by
// `@tanstack/react-db`'s `useLiveQuery`.
export { SyncContext } from "./sync/SyncContext.ts";
export { SyncProvider } from "./sync/SyncProvider.ts";
export { useSyncClient } from "./sync/useSyncClient.ts";
export { createGatewayCollections, type CreateGatewayCollectionsOptions } from "./sync/createGatewayCollections.ts";
// Client-side persistence (SQLite-WASM / OPFS) so the live collections survive a
// reload with no re-seed / fetch flash. Opt-in via `createGatewayCollections`'
// `persistence` option; the app builds the store with `createGatewayPersistence`
// over a SQLite-WASM module it initializes (`@sqlite.org/sqlite-wasm`).
export {
  createGatewayPersistence,
  type CreateGatewayPersistenceOptions,
  type GatewayPersistence,
} from "./sync/persistence/createGatewayPersistence.ts";
export {
  PersistentCollectionStore,
  type GatewayCollectionStore,
  type PersistedRow,
} from "./sync/persistence/PersistentCollectionStore.ts";
export {
  openDbBackend,
  openOpfsSahPoolBackend,
  type SqliteWasmModule,
} from "./sync/persistence/createSqliteWasmBackend.ts";
export type { PersistenceBackend } from "./sync/persistence/PersistenceBackend.ts";
export type {
  GatewayCollections,
  GatewayQueryHandle,
  GatewayQueryRow,
  GatewayStreamHandle,
  GatewayStreamRow,
} from "./sync/GatewayCollections.ts";
export type { GatewayConnectionState, GatewayConnectionStatus } from "./sync/GatewayConnectionState.ts";
export { useSyncQuery } from "./sync/useSyncQuery.ts";
export type { UseSyncQueryOptions, UseSyncQueryResult } from "./sync/useSyncQuery.ts";
export { useSyncMutation } from "./sync/useSyncMutation.ts";
export type {
  SyncMutationOptions,
  UseSyncMutationResult,
  UseSyncMutationStatus,
} from "./sync/useSyncMutation.ts";
export { useSyncSubscription } from "./sync/useSyncSubscription.ts";
export type {
  UseSyncSubscriptionOptions,
  UseSyncSubscriptionResult,
} from "./sync/useSyncSubscription.ts";
export { useGatewayQuery } from "./sync/useGatewayQuery.ts";
export { useGatewayMutation } from "./sync/useGatewayMutation.ts";
export { useGatewayRunStream } from "./sync/useGatewayRunStream.ts";
export { useGatewayRunTree, type NodeStatus, type UseGatewayRunTreeResult } from "./sync/useGatewayRunTree.ts";
export {
  useGatewayConnectionStatus,
  type UseGatewayConnectionStatusResult,
} from "./sync/useGatewayConnectionStatus.ts";
