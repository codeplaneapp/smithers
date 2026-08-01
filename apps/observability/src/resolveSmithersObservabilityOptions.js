import { LogLevel } from "effect";
/** @typedef {import("./SmithersLogFormat.ts").SmithersLogFormat} SmithersLogFormat */

/** @typedef {import("./ResolvedSmithersObservabilityOptions.ts").ResolvedSmithersObservabilityOptions} ResolvedSmithersObservabilityOptions */
/** @typedef {import("./SmithersObservabilityOptions.ts").SmithersObservabilityOptions} SmithersObservabilityOptions */

// 4318 is the OTLP/HTTP receiver port of the local collector started by
// `smithers observability` (docker-compose.otel.yml).
const DEFAULT_OTLP_HTTP_ENDPOINT = "http://localhost:4318";

/**
 * @param {LogLevel.LogLevel | string | undefined} value
 * @returns {LogLevel.LogLevel}
 */
function resolveLogLevel(value) {
  if (typeof value !== "string") {
    return value ?? "Info";
  }
  switch (value.toLowerCase()) {
    case "none":
      return "None";
    case "trace":
      return "Trace";
    case "debug":
      return "Debug";
    case "warning":
    case "warn":
      return "Warn";
    case "error":
      return "Error";
    case "fatal":
      return "Fatal";
    case "all":
      return "All";
    case "info":
    default:
      return "Info";
  }
}
/**
 * @param {string | undefined} value
 * @returns {SmithersLogFormat}
 */
function resolveLogFormat(value) {
  switch ((value ?? "").toLowerCase()) {
    case "json":
      return "json";
    case "pretty":
      return "pretty";
    case "string":
      return "string";
    case "logfmt":
    default:
      return "logfmt";
  }
}
/**
 * @param {boolean | undefined} value
 * @returns {boolean}
 */
function resolveEnabled(value) {
  if (typeof value === "boolean") return value;
  const env = (process.env.SMITHERS_OTEL_ENABLED ?? "").toLowerCase();
  return env === "1" || env === "true";
}
/**
 * @param {string | undefined} value
 * @returns {Record<string, string> | undefined}
 */
export function parseOtlpHeaders(value) {
  if (!value) {
    return undefined;
  }
  /** @type {Record<string, string>} */
  const headers = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = entry.slice(0, separator).trim();
    if (!key) {
      continue;
    }
    try {
      headers[key] = decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      continue;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
/**
 * @param {SmithersObservabilityOptions} [options]
 * @returns {ResolvedSmithersObservabilityOptions}
 */
export function resolveSmithersObservabilityOptions(options = {}) {
  return {
    enabled: resolveEnabled(options.enabled),
    endpoint: options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_HTTP_ENDPOINT,
    headers: options.headers ?? parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "smithers",
    logFormat: options.logFormat
      ? resolveLogFormat(options.logFormat)
      : resolveLogFormat(process.env.SMITHERS_LOG_FORMAT),
    logLevel: resolveLogLevel(options.logLevel ?? process.env.SMITHERS_LOG_LEVEL),
    installLogger: options.installLogger !== false,
  };
}
