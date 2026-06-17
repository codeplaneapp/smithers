/**
 * Observability seam for the Electric proxy. Mirrors the gateway-client sync
 * telemetry convention (`__smithersSyncTelemetry`): a pluggable sink with
 * `event` (structured event) and `span` (OTLP-shaped span) callbacks that
 * defaults to a global the cloud deployment wires to its OTLP exporter, and
 * never throws on the hot path.
 *
 * The design (§5.3, §10) asks the Electric path to emit structured events +
 * OTLP spans for shape opens, forwarding, and write commits. Keeping it a seam
 * means the self-hosted proxy emits nothing by default (zero deps on an OTLP
 * runtime) while the cloud proxy registers a real exporter.
 */
export type SmithersElectricProxyEvent = {
  type:
    | "electric.shape.open"
    | "electric.shape.rejected"
    | "electric.shape.forwarded"
    | "electric.write.commit"
    | "electric.write.rejected";
  principalId: string;
  table?: string;
  shape?: string;
  reason?: string;
  requiredScope?: string;
  status?: number;
  durationMs?: number;
  forwardedBytes?: number;
  lagMs?: number;
  txid?: number | null;
  method?: string;
};

export type SmithersElectricProxySpan = {
  name: string;
  attributes: Record<string, unknown>;
};

export type SmithersElectricProxyObserver = {
  event?: (event: SmithersElectricProxyEvent) => void;
  span?: (span: SmithersElectricProxySpan) => void;
};

function globalObserver(): SmithersElectricProxyObserver | undefined {
  return (globalThis as { __smithersElectricTelemetry?: SmithersElectricProxyObserver }).__smithersElectricTelemetry;
}

/**
 * Emit a proxy event + its derived OTLP span to the supplied observer, then to
 * the global sink. Telemetry must never break a shape open or a write, so every
 * sink call is guarded.
 */
export function emitSmithersElectricEvent(
  observer: SmithersElectricProxyObserver | undefined,
  event: SmithersElectricProxyEvent,
): void {
  const sinks = [observer, globalObserver()];
  const span: SmithersElectricProxySpan = {
    name: `smithers.${event.type}`,
    attributes: {
      "smithers.electric.principal_id": event.principalId,
      "smithers.electric.table": event.table,
      "smithers.electric.shape": event.shape,
      "smithers.electric.reason": event.reason,
      "smithers.electric.required_scope": event.requiredScope,
      "smithers.electric.status": event.status,
      "smithers.electric.duration_ms": event.durationMs,
      "smithers.electric.forwarded_bytes": event.forwardedBytes,
      "smithers.electric.lag_ms": event.lagMs,
      "smithers.electric.txid": event.txid,
      "smithers.electric.method": event.method,
    },
  };
  for (const sink of sinks) {
    if (!sink) continue;
    // Guard event and span independently: a throwing event sink must not
    // suppress the span (and neither may break the Electric path).
    try {
      sink.event?.(event);
    } catch {
      // Observability must never break the Electric path.
    }
    try {
      sink.span?.(span);
    } catch {
      // Observability must never break the Electric path.
    }
  }
}
