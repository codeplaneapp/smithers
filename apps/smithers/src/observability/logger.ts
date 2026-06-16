/**
 * Structured JSON event logger for the Smithers UI surfaces.
 *
 * Single line of JSON per event so downstream collectors (jjhub, Plue, the
 * Prometheus stack's Loki sidecar) can parse it without a regex. Sensitive
 * headers and query parameters are redacted before serialization; the redacted
 * key names are exported so tests can pin the contract.
 *
 * No `console.log` — every log goes through `emit()`, which is overridable for
 * tests. Production defaults to `console.info` so the Cloudflare Worker logs
 * stream into the platform's log drain unchanged. Drops (a non-serializable
 * field, a throwing sink) bump `loggerDropsTotal` so silent loss is observable
 * on the `/metrics` scrape.
 */

import { workerRegistry } from "./metrics";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEvent = {
  level: LogLevel;
  message: string;
  /** Free-form structured fields. Strings are passed through; everything else
   *  is `JSON.stringify`-ed by the emitter. */
  fields?: Record<string, unknown>;
  /** Component the event came from, e.g. `worker.proxy.gateway`. */
  component?: string;
};

export const REDACTED_HEADERS: ReadonlyArray<string> = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-smithers-key",
  "x-user-id",
  "x-user-scopes",
  "x-user-role",
  "x-smithers-token-id",
  "proxy-authorization",
];

const REDACTED_QUERY_KEYS: ReadonlyArray<string> = [
  "access_token",
  "refresh_token",
  "code",
  "state",
  "id_token",
  "token",
  "api_key",
];

const REDACTION_TOKEN = "[redacted]";

/**
 * Counter for logger-side serialization or sink failures. A non-zero value
 * means at least one log event was silently dropped — investigate the caller
 * for non-serializable fields or a misconfigured sink.
 */
export const loggerDropsTotal = workerRegistry.counter({
  name: "smithers_ui_logger_drops_total",
  help: "Log events dropped by the structured emitter (serialization or sink failure).",
  allowedLabels: ["reason"],
});

export function redactHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries =
    headers instanceof Headers
      ? Array.from(headers.entries())
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers as Record<string, string>);
  const sensitive = new Set(REDACTED_HEADERS.map((header) => header.toLowerCase()));
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.toLowerCase();
    out[key] = sensitive.has(key) ? REDACTION_TOKEN : String(rawValue);
  }
  return out;
}

export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const key of REDACTED_QUERY_KEYS) {
    if (parsed.searchParams.has(key)) parsed.searchParams.set(key, REDACTION_TOKEN);
  }
  if (parsed.username) parsed.username = REDACTION_TOKEN;
  if (parsed.password) parsed.password = REDACTION_TOKEN;
  return parsed.toString();
}

export type Emitter = (line: string) => void;

let activeEmitter: Emitter = (line) => {
  if (typeof console !== "undefined" && typeof console.info === "function") {
    console.info(line);
  }
};
let activeCorrelationContext: Record<string, unknown> = {};

/** Swap the emitter — used by tests to capture lines, and by deployments to
 *  forward to a custom sink (loki, jjhub). */
export function setEmitter(emitter: Emitter): void {
  activeEmitter = emitter;
}

export function emit(event: LogEvent): void {
  const payload: Record<string, unknown> = {
    level: event.level,
    message: event.message,
    ...activeCorrelationContext,
  };
  if (event.component) payload.component = event.component;
  if (event.fields) {
    for (const key of Object.keys(event.fields)) {
      payload[key] = event.fields[key];
    }
  }
  let line: string;
  try {
    line = JSON.stringify(payload);
  } catch {
    loggerDropsTotal.inc({ reason: "serialize" });
    return;
  }
  try {
    activeEmitter(line);
  } catch {
    loggerDropsTotal.inc({ reason: "sink" });
  }
}

export function withCorrelationContext<T>(context: Record<string, unknown>, fn: () => T): T {
  const previous = activeCorrelationContext;
  activeCorrelationContext = { ...previous, ...context };
  try {
    return fn();
  } finally {
    activeCorrelationContext = previous;
  }
}

export function info(message: string, fields?: Record<string, unknown>, component?: string): void {
  emit({ level: "info", message, fields, component });
}

export function warn(message: string, fields?: Record<string, unknown>, component?: string): void {
  emit({ level: "warn", message, fields, component });
}

export function error(message: string, fields?: Record<string, unknown>, component?: string): void {
  emit({ level: "error", message, fields, component });
}
