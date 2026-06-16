import { createContext } from "react";
import type { GatewayCollections } from "./GatewayCollections.ts";

/**
 * The React context that hands the `GatewayCollections` registry to every sync
 * hook. The default is `null` so consumers must wrap their tree in a
 * `SyncProvider` — surfacing the missing-provider error eagerly beats a silent
 * no-op.
 */
export const SyncContext = createContext<GatewayCollections | null>(null);
