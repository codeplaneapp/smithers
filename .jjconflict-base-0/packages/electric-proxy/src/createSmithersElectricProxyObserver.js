/**
 * @returns {import("./SmithersElectricProxyObserver.ts").SmithersElectricProxyObserver | undefined}
 */
function globalObserver() {
  return /** @type {{ __smithersElectricTelemetry?: import("./SmithersElectricProxyObserver.ts").SmithersElectricProxyObserver }} */ (
    globalThis
  ).__smithersElectricTelemetry;
}

/**
 * Emit a proxy event + its derived OTLP span to the supplied observer, then to
 * the global sink. Telemetry must never break a shape open or a write, so every
 * sink call is guarded.
 *
 * See `SmithersElectricProxyObserver.ts` for the observability-seam contract
 * (structured events + OTLP-shaped spans, defaulting to the
 * `__smithersElectricTelemetry` global the cloud deployment wires to its OTLP
 * exporter).
 *
 * @param {import("./SmithersElectricProxyObserver.ts").SmithersElectricProxyObserver | undefined} observer
 * @param {import("./SmithersElectricProxyObserver.ts").SmithersElectricProxyEvent} event
 * @returns {void}
 */
export function emitSmithersElectricEvent(observer, event) {
  const sinks = [observer, globalObserver()];
  /** @type {import("./SmithersElectricProxyObserver.ts").SmithersElectricProxySpan} */
  const span = {
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
