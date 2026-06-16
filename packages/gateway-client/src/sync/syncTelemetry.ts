export type SyncTelemetryEvent = {
  type: "sync.initial_load" | "sync.frame" | "sync.gap_resync" | "sync.error";
  collectionId: string;
  key: readonly unknown[];
  scope?: string;
  seq?: number;
  lagMs?: number;
  count?: number;
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
        "smithers.sync.seq": event.seq,
        "smithers.sync.lag_ms": event.lagMs,
        "smithers.sync.count": event.count,
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
