import type { SyncTelemetryEvent } from "@smithers-orchestrator/gateway-client";
import { info, warn } from "./logger";
import {
  syncErrorsTotal,
  syncFrameLagMs,
  syncFramesTotal,
  syncGapResyncTotal,
  syncInitialLoadTotal,
} from "./uiMetrics";

type SyncTelemetrySink = {
  event?: (event: SyncTelemetryEvent) => void;
  span?: (span: { name: string; attributes: Record<string, unknown> }) => void;
};

function prune(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/**
 * Bind the gateway-client sync telemetry seam to the app's structured logger
 * (which streams to the Cloudflare log drain / Loki) and the browser metric
 * registry. The sync layer only emits to `globalThis.__smithersSyncTelemetry`;
 * without this binding the events and OTLP-shaped spans go nowhere. Wiring it at
 * boot turns the seam into an end-to-end pipeline:
 *
 *   - per-frame counters + a frame-lag histogram and gap/error/initial-load
 *     counters into `browserRegistry` (scrape/beacon path);
 *   - structured JSON log lines for the meaningful spans (initial load, gap
 *     resync, error) tagged `otelSpan: true`, so a collector with the OTLP
 *     logs→spans bridge ingests them. High-frequency `sync.frame` spans are
 *     dropped from the log path (they are already a metric) to avoid noise; a
 *     native OTLP exporter can replace this sink without touching the sync layer.
 */
export function bindSyncTelemetry(): void {
  const sink: SyncTelemetrySink = {
    event(event) {
      const scope = event.scope ?? "unknown";
      switch (event.type) {
        case "sync.frame":
          syncFramesTotal.inc({ scope });
          if (typeof event.lagMs === "number") syncFrameLagMs.observe(event.lagMs, { scope });
          break;
        case "sync.initial_load":
          syncInitialLoadTotal.inc({ scope });
          break;
        case "sync.gap_resync":
          syncGapResyncTotal.inc({ scope });
          warn("sync.gap_resync", { scope, collectionId: event.collectionId, error: event.error }, "ui.sync");
          break;
        case "sync.error":
          syncErrorsTotal.inc({ scope });
          warn("sync.error", { scope, collectionId: event.collectionId, error: event.error }, "ui.sync");
          break;
      }
    },
    span(span) {
      // Frames are a metric, not a per-span log line — skip them to keep the
      // span path low-volume. The meaningful spans are load/resync/error.
      if (span.name === "smithers.sync.frame") return;
      info(span.name, { otelSpan: true, ...prune(span.attributes) }, "ui.sync.span");
    },
  };
  (globalThis as { __smithersSyncTelemetry?: SyncTelemetrySink }).__smithersSyncTelemetry = sink;
}
