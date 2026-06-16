export type SyncTelemetryEvent = {
  type:
    | "sync.initial_load"
    | "sync.frame"
    | "sync.gap_resync"
    | "sync.error"
    | "sync.backpressure"
    | "sync.reconnect"
    | "sync.mutation.optimistic_apply"
    | "sync.mutation.handler_rpc"
    | "sync.mutation.confirm"
    | "sync.mutation.rollback"
    | "docs.materialize.write"
    | "docs.materialize.delete";
  collectionId: string;
  key: readonly unknown[];
  method?: string;
  mutationId?: string;
  scope?: string;
  seq?: number;
  lagMs?: number;
  durationMs?: number;
  count?: number;
  rollbackCount?: number;
  path?: string;
  kind?: string;
  hash?: string;
  /** Cumulative frames shed from the bounded apply queue (type "sync.backpressure"). */
  dropped?: number;
  error?: string;
};

type SyncTelemetrySink = {
  event?: (event: SyncTelemetryEvent) => void;
  span?: (span: { name: string; attributes: Record<string, unknown> }) => void;
};

function telemetrySink(): SyncTelemetrySink | undefined {
  return (globalThis as { __smithersSyncTelemetry?: SyncTelemetrySink }).__smithersSyncTelemetry;
}

function frameTimestamp(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const direct = record.timestampMs ?? record.timestamp_ms ?? record.createdAtMs ?? record.created_at_ms;
  if (typeof direct === "number") return direct;
  const nested = record.payload;
  if (typeof nested === "object" && nested !== null) {
    const nestedRecord = nested as Record<string, unknown>;
    const value = nestedRecord.timestampMs ?? nestedRecord.timestamp_ms ?? nestedRecord.createdAtMs ?? nestedRecord.created_at_ms;
    if (typeof value === "number") return value;
  }
  return undefined;
}

export function emitSyncTelemetry(event: SyncTelemetryEvent): void {
  const sink = telemetrySink();
  if (!sink) return;
  try {
    sink.event?.(event);
    sink.span?.({
      name: `smithers.${event.type}`,
      attributes: {
        "smithers.sync.collection_id": event.collectionId,
        "smithers.sync.scope": event.scope,
        "smithers.sync.method": event.method,
        "smithers.sync.mutation_id": event.mutationId,
        "smithers.sync.seq": event.seq,
        "smithers.sync.lag_ms": event.lagMs,
        "smithers.sync.duration_ms": event.durationMs,
        "smithers.sync.count": event.count,
        "smithers.sync.rollback_count": event.rollbackCount,
        "smithers.sync.path": event.path,
        "smithers.sync.kind": event.kind,
        "smithers.sync.hash": event.hash,
        "smithers.sync.dropped": event.dropped,
        "smithers.sync.error": event.error,
      },
    });
  } catch {
    // Telemetry must never break the sync path.
  }
}

export function syncLagMs(payload: unknown, now = Date.now()): number | undefined {
  const timestamp = frameTimestamp(payload);
  return typeof timestamp === "number" ? Math.max(0, now - timestamp) : undefined;
}
