const CANCELLATION_SOURCE_KINDS = new Set(["signal", "rpc", "cli", "engine"]);
const CANCELLATION_ATTRIBUTION_MAX_LENGTH = 1024;

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function boundedString(value) {
  if (typeof value !== "string") return undefined;
  return value.slice(0, CANCELLATION_ATTRIBUTION_MAX_LENGTH);
}

/**
 * @param {unknown} value
 * @returns {import("@smthrs/observability").RunCancellationSource | undefined}
 */
function normalizeCancellationSource(value) {
  if (!value || typeof value !== "object") return undefined;
  const source = /** @type {Record<string, unknown>} */ (value);
  if (typeof source.kind !== "string" || !CANCELLATION_SOURCE_KINDS.has(source.kind)) return undefined;
  const detail = boundedString(source.detail);
  const signal = boundedString(source.signal);
  const requestId = boundedString(source.requestId);
  const clientIdentity = boundedString(source.clientIdentity);
  const clientPid =
    Number.isSafeInteger(source.clientPid) && Number(source.clientPid) > 0 ? Number(source.clientPid) : undefined;
  return {
    kind: /** @type {"signal" | "rpc" | "cli" | "engine"} */ (source.kind),
    ...(detail !== undefined ? { detail } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(clientPid !== undefined ? { clientPid } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(clientIdentity !== undefined ? { clientIdentity } : {}),
  };
}

/**
 * Attach a source without changing an error's class or serialized payload.
 * @param {unknown} reason
 * @param {import("@smthrs/observability").RunCancellationSource} source
 * @returns {unknown}
 */
export function withCancellationSource(reason, source) {
  const normalized = normalizeCancellationSource(source);
  if (!normalized) return reason;
  if (cancellationSourceFromReason(reason)) return reason;
  if (reason && (typeof reason === "object" || typeof reason === "function")) {
    try {
      Object.defineProperty(reason, "smithersCancellationSource", {
        configurable: true,
        enumerable: false,
        value: normalized,
      });
      return reason;
    } catch {
      // Fall through to an attributed AbortError for frozen foreign errors.
    }
  }
  return makeCancellationAbortReason(normalized, reason);
}

/**
 * @param {import("@smthrs/observability").RunCancellationSource} source
 * @param {unknown} [cause]
 * @returns {Error & { smithersCancellationSource?: import("@smthrs/observability").RunCancellationSource }}
 */
export function makeCancellationAbortReason(source, cause) {
  const normalized = normalizeCancellationSource(source);
  const reason = new Error(normalized?.detail ?? "Run cancelled", cause === undefined ? undefined : { cause });
  reason.name = "AbortError";
  if (normalized) {
    Object.defineProperty(reason, "smithersCancellationSource", {
      configurable: true,
      enumerable: false,
      value: normalized,
    });
  }
  return reason;
}

/**
 * @param {unknown} reason
 * @returns {import("@smthrs/observability").RunCancellationSource | undefined}
 */
function cancellationSourceFromReason(reason) {
  let current = reason;
  const seen = new Set();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = /** @type {Record<string, unknown>} */ (current);
    const source = normalizeCancellationSource(record.smithersCancellationSource);
    if (source) return source;
    current = record.cause;
  }
  return undefined;
}

/**
 * @param {AbortSignal | undefined} signal
 * @returns {import("@smthrs/observability").RunCancellationSource | undefined}
 */
export function cancellationAttributionFromAbortSignal(signal) {
  return signal?.aborted ? cancellationSourceFromReason(signal.reason) : undefined;
}
