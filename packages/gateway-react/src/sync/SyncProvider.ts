import { createElement, type ReactElement, type ReactNode } from "react";
import { SyncContext } from "./SyncContext.ts";
import type { GatewayCollections } from "./GatewayCollections.ts";

/**
 * Wraps a React subtree with a `GatewayCollections` registry so descendants can
 * call `useSyncQuery` / `useSyncMutation` / `useSyncSubscription` (and the typed
 * gateway hooks) against the same TanStack DB collections. apps/smithers mounts
 * a single provider at the root; embedded custom UIs can mount their own
 * per-workflow registry when they want isolation.
 *
 * The `client` prop name is preserved from the previous `SyncClient`-backed
 * provider; only its type changed to the collections registry.
 */
export function SyncProvider(props: { client: GatewayCollections; children?: ReactNode }): ReactElement {
  return createElement(SyncContext.Provider, { value: props.client }, props.children);
}
