import type { CollectionConfig } from "@tanstack/db";
import type { CollectionDef } from "./CollectionDef.ts";
import type { ConnectionObserver } from "./ConnectionObserver.ts";
import type { SyncKey } from "./SyncKey.ts";

/**
 * A write handed to a source's own commit path. `method` is the logical gateway
 * RPC (`launchRun`, `submitApproval`, …); `vars` are the already-normalized
 * params (e.g. with an injected `runId`). The gateway source forwards this to
 * its RPC transport; an Electric source would issue the Postgres write and
 * return a txid for optimistic matching.
 */
export type SyncSourceWriteRequest<TVars> = {
  method: string;
  vars: TVars;
};

export type SyncSource = {
  collection<TRow extends object, TKey extends string | number>(
    def: CollectionDef<TRow, TKey>,
  ): CollectionConfig<TRow, TKey>;
  status(): ConnectionObserver;
  /**
   * Persist a write through the source's own commit path. The unified
   * optimistic-write path calls this instead of hard-wiring `registry.rpc`, so
   * a second source (Electric) plugs its write transport in here without the
   * write path knowing which backend it talks to. Optional: existing sources
   * keep compiling and the registry falls back to the request's own commit
   * closure (gateway RPC) when it is absent.
   */
  commit?<TData>(request: SyncSourceWriteRequest<unknown>): Promise<TData>;
  /**
   * Await a fresh load of every collection whose key matches `prefix`, resolving
   * only once each has applied its post-write rows as a synced transaction. The
   * write path awaits this so an optimistic row stays continuously visible until
   * the source confirms it (the optimistic transaction never completes against
   * an empty synced state, so `$synced` flips false → true with no flicker).
   * Optional: the registry falls back to fire-and-forget invalidation when a
   * source does not implement it.
   */
  confirm?(prefix: SyncKey): Promise<void>;
  reset?(): void;
};
