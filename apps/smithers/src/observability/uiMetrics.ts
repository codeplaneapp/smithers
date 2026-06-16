/**
 * Named metrics for the Smithers UI app and its Cloudflare Worker proxy.
 *
 * Two separate registries make the worker/browser split explicit:
 *
 *   - `workerRegistry` → scraped by `GET /metrics`. Holds the proxy counters
 *     (`smithers_ui_worker_proxy_*`) and the logger drop counter.
 *   - `browserRegistry` → browser-local. Holds the gateway-client RPC, stream,
 *     and surface refresh metrics. NOT exposed by the Worker scrape — the
 *     Worker calls `renderPrometheus(workerRegistry)` only. These are
 *     available to an in-page debug surface and would graduate to a beacon
 *     shipper without API churn.
 *
 * See `.smithers/specs/smithers-ui-observability.md` for the full split.
 *
 * Labels are kept low-cardinality on purpose. Routes are mapped to a small
 * fixed set of `route_kind` values; the proxy counter intentionally omits
 * status (status is already encoded in `outcome` buckets — keeping both as
 * labels multiplies cardinality without adding information).
 */

import {
  DEFAULT_BYTE_BUCKETS,
  DEFAULT_MS_BUCKETS,
  browserRegistry,
  workerRegistry,
  type LabelSet,
} from "./metrics";

export type ProxyRouteKind =
  | "auth"
  | "platform"
  | "gateway_http"
  | "gateway_rpc"
  | "chat"
  | "metrics"
  | "static"
  | "unknown";

export type ProxyOutcome =
  | "ok"
  | "client_error"
  | "server_error"
  | "auth_failure"
  | "rate_limited"
  | "upstream_unreachable";

/* ───────────────────────── proxy (worker) metrics ─────────────────────── */

export const proxyRequestsTotal = workerRegistry.counter({
  name: "smithers_ui_worker_proxy_requests_total",
  help: "Total proxied requests through the Smithers Cloudflare Worker.",
  allowedLabels: ["route_kind", "method", "outcome"],
});

export const proxyDurationMs = workerRegistry.histogram({
  name: "smithers_ui_worker_proxy_duration_ms",
  help: "Duration of a single proxied request, in milliseconds.",
  allowedLabels: ["route_kind", "method"],
  buckets: DEFAULT_MS_BUCKETS,
});

export const proxyPayloadBytes = workerRegistry.histogram({
  name: "smithers_ui_worker_proxy_payload_bytes",
  help: "Inbound request body size for proxied calls, in bytes.",
  allowedLabels: ["route_kind"],
  buckets: DEFAULT_BYTE_BUCKETS,
});

export const proxyAuthFailuresTotal = workerRegistry.counter({
  name: "smithers_ui_worker_proxy_auth_failures_total",
  help: "Authentication and authorization failures observed at the proxy.",
  allowedLabels: ["route_kind", "reason"],
});

/* ─────────────────────────── gateway client metrics (browser-local) ───── */

export const gatewayRpcTotal = browserRegistry.counter({
  name: "smithers_ui_gateway_rpc_total",
  help: "Total gateway RPC calls fired from the Smithers UI (browser-local).",
  allowedLabels: ["method", "outcome"],
});

export const gatewayRpcDurationMs = browserRegistry.histogram({
  name: "smithers_ui_gateway_rpc_duration_ms",
  help: "Gateway RPC call latency, in milliseconds (browser-local).",
  allowedLabels: ["method"],
  buckets: DEFAULT_MS_BUCKETS,
});

export const gatewayRpcErrorsTotal = browserRegistry.counter({
  name: "smithers_ui_gateway_rpc_errors_total",
  help: "Gateway RPC errors, by canonical error code (browser-local).",
  allowedLabels: ["method", "code"],
});

export const gatewayStreamSubscriptionsTotal = browserRegistry.counter({
  name: "smithers_ui_gateway_stream_subscriptions_total",
  help: "Stream subscriptions opened against the gateway (browser-local).",
  allowedLabels: ["stream"],
});

export const gatewayStreamReconnectsTotal = browserRegistry.counter({
  name: "smithers_ui_gateway_stream_reconnects_total",
  help: "Stream reconnect attempts after a transient transport failure (browser-local).",
  allowedLabels: ["stream", "reason"],
});

export const gatewayStreamReconnectStormsTotal = browserRegistry.counter({
  name: "smithers_ui_gateway_stream_reconnect_storms_total",
  help:
    "Reconnect storms detected (≥ N reconnects within the storm window). Browser-local; use as a flapping-stream signal.",
  allowedLabels: ["stream"],
});

export const gatewayStreamBackoffMs = browserRegistry.histogram({
  name: "smithers_ui_gateway_stream_backoff_ms",
  help: "Backoff applied between gateway stream reconnect attempts (browser-local).",
  allowedLabels: ["stream"],
  buckets: DEFAULT_MS_BUCKETS,
});

export const gatewayStreamStaleUpdatesTotal = browserRegistry.counter({
  name: "smithers_ui_gateway_stream_stale_updates_total",
  help:
    "Updates received for a stream whose subscription has been closed or replaced (browser-local).",
  allowedLabels: ["stream", "reason"],
});

export const gatewayConnectionState = browserRegistry.gauge({
  name: "smithers_ui_gateway_connection_state",
  help:
    "Current Smithers Gateway connection state. 0=offline, 1=connecting, 2=online, 3=unauthorized (browser-local).",
  allowedLabels: [],
});

/* ─────────────────────── TanStack DB sync metrics (browser-local) ──────── */

export const syncFramesTotal = browserRegistry.counter({
  name: "smithers_ui_sync_frames_total",
  help: "Stream frames applied into a synced TanStack DB collection (browser-local).",
  allowedLabels: ["scope"],
});

export const syncErrorsTotal = browserRegistry.counter({
  name: "smithers_ui_sync_errors_total",
  help: "Errors raised while loading or streaming a synced collection (browser-local).",
  allowedLabels: ["scope"],
});

export const syncGapResyncTotal = browserRegistry.counter({
  name: "smithers_ui_sync_gap_resync_total",
  help: "Replay-gap (SeqOutOfRange) resyncs on a synced collection stream (browser-local).",
  allowedLabels: ["scope"],
});

export const syncInitialLoadTotal = browserRegistry.counter({
  name: "smithers_ui_sync_initial_load_total",
  help: "Initial RPC loads completed for a synced collection (browser-local).",
  allowedLabels: ["scope"],
});

export const syncFrameLagMs = browserRegistry.histogram({
  name: "smithers_ui_sync_frame_lag_ms",
  help: "Observed lag between a frame's source timestamp and its client apply, in ms (browser-local).",
  allowedLabels: ["scope"],
  buckets: DEFAULT_MS_BUCKETS,
});

export const syncBackpressureDropsTotal = browserRegistry.counter({
  name: "smithers_ui_sync_backpressure_drops_total",
  help: "Stream frames shed from the bounded apply queue under backpressure (browser-local).",
  allowedLabels: ["scope"],
});

/* ───────────────────────── per-surface refresh metrics (browser-local) ─ */

export const surfaceRefreshTotal = browserRegistry.counter({
  name: "smithers_ui_surface_refresh_total",
  help: "Per-surface data refreshes triggered in the Smithers UI (browser-local).",
  allowedLabels: ["surface", "trigger", "outcome"],
});

export const surfaceRefreshDurationMs = browserRegistry.histogram({
  name: "smithers_ui_surface_refresh_duration_ms",
  help: "Per-surface data refresh duration (browser-local).",
  allowedLabels: ["surface"],
  buckets: DEFAULT_MS_BUCKETS,
});

export const offlineModeActive = browserRegistry.gauge({
  name: "smithers_ui_offline_mode_active",
  help: "1 when the browser-detected offline mode is active, else 0 (browser-local).",
  allowedLabels: [],
});

/* ────────────────────────── label-classification helpers ──────────────── */

const PLATFORM_USER_ROUTE_PREFIXES = [
  "/api/user/repos",
  "/api/user/readable-repos",
  "/api/user/workspaces",
  "/api/user/orgs",
  "/api/user/starred",
  "/api/user/issues",
  "/api/user/landings",
  "/api/user/notifications",
  "/api/user/subscriptions",
  "/api/user/following",
  "/api/user/followers",
  "/api/user/searches",
];

function isPlatformUserRoute(pathname: string): boolean {
  if (!pathname.startsWith("/api/user/")) return false;
  for (const prefix of PLATFORM_USER_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** Map a worker URL to one of a small fixed set of route kinds. */
export function proxyRouteKindFor(pathname: string): ProxyRouteKind {
  if (pathname.startsWith("/api/auth/")) return "auth";
  if (pathname === "/api/user") return "auth";
  if (isPlatformUserRoute(pathname)) return "platform";
  if (pathname.startsWith("/api/user/")) return "auth";
  if (
    pathname === "/api/repos" ||
    pathname.startsWith("/api/repos/") ||
    pathname === "/api/orgs" ||
    pathname.startsWith("/api/orgs/") ||
    pathname === "/api/search" ||
    pathname.startsWith("/api/search/") ||
    pathname === "/api/notifications" ||
    pathname.startsWith("/api/notifications/") ||
    pathname.startsWith("/api/integrations/") ||
    pathname.startsWith("/api/oauth2/") ||
    pathname.startsWith("/resolve/")
  ) {
    return "platform";
  }
  if (pathname.startsWith("/v1/rpc")) return "gateway_rpc";
  if (pathname === "/health" || pathname.startsWith("/workflows")) return "gateway_http";
  if (pathname === "/api/chat") return "chat";
  if (pathname === "/metrics") return "metrics";
  if (pathname === "/" || pathname.startsWith("/assets/")) return "static";
  return "unknown";
}

/** Bucket an HTTP status into Prometheus-friendly families. */
export function proxyOutcomeFor(status: number): ProxyOutcome {
  if (status === 401 || status === 403) return "auth_failure";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status < 600) return "server_error";
  if (status >= 400 && status < 500) return "client_error";
  if (status === 0 || status === 599) return "upstream_unreachable";
  return "ok";
}

/* ────────────────────────── small wrapper helpers ─────────────────────── */

/**
 * Wrap a promise-returning RPC call so its latency, outcome and error code are
 * recorded automatically. Returns whatever `fn` returns; never swallows errors.
 *
 * `clock` is a seam for tests so we do not have to mock `performance.now`.
 */
export async function recordRpc<T>(
  method: string,
  fn: () => Promise<T>,
  clock: () => number = nowMs,
): Promise<T> {
  const labels: LabelSet = { method };
  const start = clock();
  try {
    const result = await fn();
    gatewayRpcTotal.inc({ method, outcome: "ok" });
    gatewayRpcDurationMs.observe(clock() - start, labels);
    return result;
  } catch (err) {
    const code = extractErrorCode(err);
    gatewayRpcTotal.inc({ method, outcome: "error" });
    gatewayRpcErrorsTotal.inc({ method, code });
    gatewayRpcDurationMs.observe(clock() - start, labels);
    throw err;
  }
}

const STORM_WINDOW_MS = 60_000;
const STORM_THRESHOLD = 5;

type StreamReconnectHistory = { stream: string; tsMs: number[] };
const reconnectHistory = new Map<string, StreamReconnectHistory>();

/**
 * Record a stream reconnect, and emit a "storm" counter whenever the *sliding
 * window* of the last `STORM_WINDOW_MS` contains at least `STORM_THRESHOLD`
 * reconnects. Unlike the original implementation, we do not zero the window
 * after raising — sustained outages keep ticking the storm counter on every
 * subsequent reconnect, so PagerDuty sees a continuous rate signal instead of
 * one storm-every-five-reconnects.
 */
export function recordStreamReconnect(
  stream: string,
  reason: string,
  backoffMs?: number,
  now: () => number = nowMs,
): void {
  gatewayStreamReconnectsTotal.inc({ stream, reason });
  if (backoffMs !== undefined) {
    gatewayStreamBackoffMs.observe(backoffMs, { stream });
  }
  const tsNow = now();
  const history = reconnectHistory.get(stream) ?? { stream, tsMs: [] };
  history.tsMs.push(tsNow);
  // Trim anything outside the window so the storm check is a true sliding count.
  while (history.tsMs.length > 0 && history.tsMs[0] < tsNow - STORM_WINDOW_MS) {
    history.tsMs.shift();
  }
  // Memory bound: never keep more than 4× threshold even if the window holds
  // them — a storm has already been raised by then.
  if (history.tsMs.length > STORM_THRESHOLD * 4) {
    history.tsMs.splice(0, history.tsMs.length - STORM_THRESHOLD * 4);
  }
  reconnectHistory.set(stream, history);
  if (history.tsMs.length >= STORM_THRESHOLD) {
    gatewayStreamReconnectStormsTotal.inc({ stream });
  }
}

/** Test helper: forget all stream history. */
export function resetReconnectHistory(): void {
  reconnectHistory.clear();
}

export function connectionStateValue(
  status: "idle" | "connecting" | "online" | "offline" | "unauthorized",
): number {
  switch (status) {
    case "offline":
      return 0;
    case "connecting":
      return 1;
    case "online":
      return 2;
    case "unauthorized":
      return 3;
    default:
      return -1;
  }
}

function extractErrorCode(err: unknown): string {
  const objectCode = typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code ?? "")
    : "";
  const normalizedObjectCode = normalizeRpcErrorCode(objectCode);
  if (normalizedObjectCode) return normalizedObjectCode;

  const message = err instanceof Error ? err.message : String(err ?? "");
  const http = message.match(/Gateway HTTP (\d+)/);
  if (http) return httpStatusBucket(Number(http[1]));
  // Some legacy paths surface errors as `CODE: message`. Keep only a closed
  // allow-list so a free-form uppercase prefix cannot become a high-cardinality
  // Prometheus label.
  const upper = message.match(/^([A-Z_][A-Z0-9_]+)\b/);
  if (upper) return normalizeRpcErrorCode(upper[1]) ?? "UNKNOWN";
  return "UNKNOWN";
}

const KNOWN_RPC_ERROR_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "HTTP_ERROR",
  "INVALID_GATEWAY_RESPONSE",
  "METHOD_NOT_FOUND",
  "PAYLOAD_TOO_LARGE",
  "BACKPRESSURE_DISCONNECT",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK",
]);

function normalizeRpcErrorCode(code: string): string | undefined {
  const normalized = code.trim().toUpperCase();
  return KNOWN_RPC_ERROR_CODES.has(normalized) ? normalized : undefined;
}

function httpStatusBucket(status: number): string {
  if (status >= 400 && status < 500) return "HTTP_4XX";
  if (status >= 500 && status < 600) return "HTTP_5XX";
  return "HTTP_OTHER";
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}
