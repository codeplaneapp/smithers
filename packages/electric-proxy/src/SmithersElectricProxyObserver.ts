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
    | "electric.upstream.error"
    | "electric.write.commit"
    | "electric.write.rejected";
  principalId: string;
  table?: string;
  shape?: string;
  reason?: string;
  requiredScope?: string;
  status?: number;
  durationMs?: number;
  /** Bytes forwarded by this single closing shape stream, not a process-wide total. */
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
