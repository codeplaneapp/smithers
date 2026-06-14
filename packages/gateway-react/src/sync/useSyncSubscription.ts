import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { syncKeyFingerprint, type SyncKey, type SyncStreamFrame } from "@smithers-orchestrator/gateway-client";
import { useSyncClient } from "./useSyncClient.ts";
import type { GatewayStreamRow } from "./GatewayCollections.ts";

/**
 * Subscribe to a streaming source (run events, devtools, …) through a bounded
 * stream collection in the registry. Returns the rolling buffer of frames +
 * stats. Heavy bursts are bounded by `maxFrames`; older frames drop off the
 * front so render time stays predictable on a hot run.
 *
 * N components subscribing to the same key share ONE collection (and one
 * upstream socket) — multiplexing falls out of the per-key collection id.
 * Disabling (`enabled: false`) drops the subscription; the collection's
 * `gcTime: 0` aborts the upstream when this was the last observer.
 */

export type UseSyncSubscriptionOptions = {
  enabled?: boolean;
  /** Bounded buffer of recent frames the consumer can render. Default 200. */
  maxFrames?: number;
};

export type UseSyncSubscriptionResult = {
  frames: ReadonlyArray<SyncStreamFrame>;
  last: SyncStreamFrame | undefined;
  /** Frames dropped off the front of the bounded buffer. */
  dropped: number;
};

export function useSyncSubscription(
  key: SyncKey,
  scope: string,
  params: unknown,
  options: UseSyncSubscriptionOptions = {},
): UseSyncSubscriptionResult {
  const registry = useSyncClient();
  const enabled = options.enabled ?? true;
  const maxFrames = options.maxFrames ?? 200;
  const paramsFingerprint = syncKeyFingerprint(["params", params]);
  const fingerprint = useMemo(
    () => `${syncKeyFingerprint(key)}|${scope}|${paramsFingerprint}|${maxFrames}`,
    [key, scope, paramsFingerprint, maxFrames],
  );
  const handle = enabled ? registry.stream(key, scope, params, maxFrames) : undefined;

  const live = useLiveQuery(
    (q) => (handle ? q.from({ row: handle.collection }) : undefined),
    [fingerprint, enabled],
  );

  const rows = (live.data ?? []) as GatewayStreamRow[];
  const frames = useMemo(
    () => [...rows].sort((left, right) => left.id - right.id).map((row) => row.frame),
    [rows],
  );
  const dropped = handle ? Math.max(0, handle.stats.totalSeen - frames.length) : 0;
  return { frames, last: frames[frames.length - 1], dropped };
}
