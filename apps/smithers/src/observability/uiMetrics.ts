/**
 * Named metrics for the Smithers UI app and its Cloudflare Worker proxy.
 *
 * Two separate registries make the worker/browser split explicit:
 *
 *   - `workerRegistry` → scraped by `GET /metrics`. Holds the proxy counters
 *     (`smithers_ui_worker_proxy_*`) and the logger drop counter.
 *   - `browserRegistry` → browser-local. Holds the gateway-client RPC, stream,
 *     and surface refresh metrics. Mirror-flow metrics are also sent through
 *     `/api/ui-metrics`, which folds them into `workerRegistry` for scraping.
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
  | "github_auth"
  | "repo_list"
  | "mirror"
  | "workspace"
  | "poll"
  | "branch"
  | "land"
  | "platform"
  | "gateway_http"
  | "gateway_rpc"
  | "chat"
  | "metrics"
  | "pair_shape"
  | "app_shape"
  | "pair_api"
  | "pair_sync"
  | "static"
  | "unknown";

export type ProxyOutcome =
  | "ok"
  | "client_error"
  | "server_error"
  | "auth_failure"
  | "rate_limited"
  | "upstream_unreachable";

export type GatewayProxyFailureReason =
  | "missing_gateway_base"
  | "auth_failure"
  | "upstream_rpc_failure"
  | "route_miss";

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

export const workerGatewayProxyFailuresTotal = workerRegistry.counter({
  name: "smithers_ui_worker_gateway_proxy_failures_total",
  help:
    "Gateway Worker proxy failures split by root cause. Distinguishes missing config, auth, upstream failure, and route misses.",
  allowedLabels: ["route_kind", "reason"],
});

export const workerGatewayBridgeFailuresTotal = workerRegistry.counter({
  name: "smithers_ui_worker_gateway_bridge_failures_total",
  help:
    "Gateway UI bridge RPC failures mirrored from browser beacons, split by bridge, RPC method, error code, and whether a runId was present.",
  allowedLabels: ["bridge", "method", "code", "run_bound"],
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

export const gatewayBridgeFailuresTotal = browserRegistry.counter({
  name: "smithers_ui_gateway_bridge_failures_total",
  help:
    "Gateway UI bridge RPC failures split by bridge, RPC method, error code, and whether a runId was present (browser-local).",
  allowedLabels: ["bridge", "method", "code", "run_bound"],
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

export type MirrorPhase = "pick" | "mirror" | "poll" | "branch" | "sandbox" | "land" | "ready";
export type MirrorOutcome = "ok" | "client_error" | "server_error" | "timeout" | "aborted";

export const mirrorFlowTotal = browserRegistry.counter({
  name: "smithers_ui_mirror_flow_total",
  help: "Total GitHub mirror flow phase transitions in the Smithers UI (browser-local).",
  allowedLabels: ["phase", "outcome"],
});

export const mirrorFlowDurationMs = browserRegistry.histogram({
  name: "smithers_ui_mirror_flow_duration_ms",
  help: "GitHub mirror flow phase duration in milliseconds (browser-local).",
  allowedLabels: ["phase"],
  buckets: DEFAULT_MS_BUCKETS,
});

export const repoListTotal = browserRegistry.counter({
  name: "smithers_ui_repo_list_total",
  help: "Total GitHub repo listing calls in the Smithers UI (browser-local).",
  allowedLabels: ["outcome"],
});

export const repoListDurationMs = browserRegistry.histogram({
  name: "smithers_ui_repo_list_duration_ms",
  help: "GitHub repo listing latency in milliseconds (browser-local).",
  allowedLabels: [],
  buckets: DEFAULT_MS_BUCKETS,
});

export const mirrorPollTotal = browserRegistry.counter({
  name: "smithers_ui_mirror_poll_total",
  help: "Total mirror import status polls from the Smithers UI (browser-local).",
  allowedLabels: ["outcome"],
});

export const mirrorPollLatencyMs = browserRegistry.histogram({
  name: "smithers_ui_mirror_poll_latency_ms",
  help: "Mirror import status poll latency in milliseconds (browser-local).",
  allowedLabels: [],
  buckets: DEFAULT_MS_BUCKETS,
});

export const mirrorPollAttempts = browserRegistry.histogram({
  name: "smithers_ui_mirror_poll_attempts",
  help: "Mirror import status poll attempts until ready or failed (browser-local).",
  allowedLabels: [],
  buckets: [1, 2, 3, 5, 8, 13, 21, 34, 55],
});

export const workerMirrorFlowTotal = workerRegistry.counter({
  name: "smithers_ui_mirror_flow_total",
  help: "Total GitHub mirror flow phase transitions received from Smithers UI beacons.",
  allowedLabels: ["phase", "outcome"],
});

export const workerMirrorFlowDurationMs = workerRegistry.histogram({
  name: "smithers_ui_mirror_flow_duration_ms",
  help: "GitHub mirror flow phase duration in milliseconds received from Smithers UI beacons.",
  allowedLabels: ["phase"],
  buckets: DEFAULT_MS_BUCKETS,
});

export const workerRepoListTotal = workerRegistry.counter({
  name: "smithers_ui_repo_list_total",
  help: "Total GitHub repo listing calls received from Smithers UI beacons.",
  allowedLabels: ["outcome"],
});

export const workerRepoListDurationMs = workerRegistry.histogram({
  name: "smithers_ui_repo_list_duration_ms",
  help: "GitHub repo listing latency in milliseconds received from Smithers UI beacons.",
  allowedLabels: [],
  buckets: DEFAULT_MS_BUCKETS,
});

export const workerMirrorPollTotal = workerRegistry.counter({
  name: "smithers_ui_mirror_poll_total",
  help: "Total mirror import status polls received from Smithers UI beacons.",
  allowedLabels: ["outcome"],
});

export const workerMirrorPollLatencyMs = workerRegistry.histogram({
  name: "smithers_ui_mirror_poll_latency_ms",
  help: "Mirror import status poll latency in milliseconds received from Smithers UI beacons.",
  allowedLabels: [],
  buckets: DEFAULT_MS_BUCKETS,
});

export const workerMirrorPollAttempts = workerRegistry.histogram({
  name: "smithers_ui_mirror_poll_attempts",
  help: "Mirror import status poll attempts until ready or failed received from Smithers UI beacons.",
  allowedLabels: [],
  buckets: [1, 2, 3, 5, 8, 13, 21, 34, 55],
});

type UiMetricEvent =
  | { name: "mirror_flow_total"; phase: MirrorPhase; outcome: MirrorOutcome; value?: number }
  | { name: "mirror_flow_duration_ms"; phase: MirrorPhase | "end_to_end"; value: number }
  | { name: "repo_list_total"; outcome: MirrorOutcome; value?: number }
  | { name: "repo_list_duration_ms"; value: number }
  | { name: "mirror_poll_total"; outcome: MirrorOutcome; value?: number }
  | { name: "mirror_poll_latency_ms"; value: number }
  | { name: "mirror_poll_attempts"; value: number }
  | {
      name: "gateway_bridge_failure";
      bridge: GatewayBridgeName;
      method: GatewayBridgeMethod;
      code: string;
      runId?: string;
      value?: number;
    };

let uiMetricBeacon: ((event: UiMetricEvent) => void) | null = null;

export function setUiMetricBeaconForTesting(beacon: ((event: UiMetricEvent) => void) | null): void {
  uiMetricBeacon = beacon;
}

function sendUiMetricEvent(event: UiMetricEvent): void {
  if (uiMetricBeacon) {
    uiMetricBeacon(event);
    return;
  }
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;
  if (
    typeof location === "undefined" ||
    (location.protocol !== "http:" && location.protocol !== "https:")
  ) {
    return;
  }
  try {
    navigator.sendBeacon(
      "/api/ui-metrics",
      new Blob([JSON.stringify(event)], { type: "application/json" }),
    );
  } catch {
    // Metrics beacons must never affect product flow.
  }
}

export function recordMirrorFlow(phase: MirrorPhase, outcome: MirrorOutcome, by = 1): void {
  mirrorFlowTotal.inc({ phase, outcome }, by);
  sendUiMetricEvent({ name: "mirror_flow_total", phase, outcome, value: by });
}

export function recordMirrorFlowDuration(phase: MirrorPhase | "end_to_end", value: number): void {
  mirrorFlowDurationMs.observe(value, { phase });
  sendUiMetricEvent({ name: "mirror_flow_duration_ms", phase, value });
}

export function recordRepoList(outcome: MirrorOutcome, durationMs: number): void {
  repoListTotal.inc({ outcome });
  repoListDurationMs.observe(durationMs);
  sendUiMetricEvent({ name: "repo_list_total", outcome });
  sendUiMetricEvent({ name: "repo_list_duration_ms", value: durationMs });
}

export function recordMirrorPoll(outcome: MirrorOutcome, latencyMs: number): void {
  mirrorPollTotal.inc({ outcome });
  mirrorPollLatencyMs.observe(latencyMs);
  sendUiMetricEvent({ name: "mirror_poll_total", outcome });
  sendUiMetricEvent({ name: "mirror_poll_latency_ms", value: latencyMs });
}

export function recordMirrorPollAttempts(value: number): void {
  mirrorPollAttempts.observe(value);
  sendUiMetricEvent({ name: "mirror_poll_attempts", value });
}

export function recordGatewayProxyFailure(
  routeKind: ProxyRouteKind,
  reason: GatewayProxyFailureReason,
): void {
  workerGatewayProxyFailuresTotal.inc({ route_kind: routeKind, reason });
}

export type GatewayBridgeName =
  | "runs"
  | "approvals"
  | "prompts"
  | "tickets"
  | "memoryFacts"
  | "crons"
  | "scores"
  | "workflows"
  | "run"
  | "extension"
  | "unknown";

export type GatewayBridgeMethod =
  | "listRuns"
  | "listApprovals"
  | "listPrompts"
  | "listTickets"
  | "listMemoryFacts"
  | "cronList"
  | "listScores"
  | "listWorkflows"
  | "getRun"
  | "extension"
  | "unknown";

export type GatewayBridgeFailureContext = {
  params?: unknown;
  runId?: string;
};

const GATEWAY_METHOD_TO_BRIDGE: Readonly<Record<GatewayBridgeMethod, GatewayBridgeName>> = {
  listRuns: "runs",
  listApprovals: "approvals",
  listPrompts: "prompts",
  listTickets: "tickets",
  listMemoryFacts: "memoryFacts",
  cronList: "crons",
  listScores: "scores",
  listWorkflows: "workflows",
  getRun: "run",
  extension: "extension",
  unknown: "unknown",
};

export function recordGatewayBridgeFailure(
  method: string,
  error: unknown,
  context: GatewayBridgeFailureContext = {},
): void {
  const normalizedMethod = normalizeGatewayBridgeMethod(method);
  const bridge = GATEWAY_METHOD_TO_BRIDGE[normalizedMethod] ?? "unknown";
  const code = extractErrorCode(error);
  const runId = normalizeRunId(context.runId ?? runIdFromParams(context.params));
  const runBound = runId ? "yes" : "no";
  gatewayBridgeFailuresTotal.inc({
    bridge,
    method: normalizedMethod,
    code,
    run_bound: runBound,
  });
  sendUiMetricEvent({
    name: "gateway_bridge_failure",
    bridge,
    method: normalizedMethod,
    code,
    ...(runId ? { runId } : {}),
  });
}

export function recordUiMetricBeacon(event: unknown): boolean {
  if (event === null || typeof event !== "object") return false;
  const candidate = event as Partial<UiMetricEvent>;
  switch (candidate.name) {
    case "mirror_flow_total":
      if (!isMirrorPhase(candidate.phase) || !isMirrorOutcome(candidate.outcome)) return false;
      workerMirrorFlowTotal.inc({ phase: candidate.phase, outcome: candidate.outcome }, finitePositive(candidate.value, 1));
      return true;
    case "mirror_flow_duration_ms":
      if (!isMirrorPhaseOrEnd(candidate.phase) || !isFiniteNonNegative(candidate.value)) return false;
      workerMirrorFlowDurationMs.observe(candidate.value, { phase: candidate.phase });
      return true;
    case "repo_list_total":
      if (!isMirrorOutcome(candidate.outcome)) return false;
      workerRepoListTotal.inc({ outcome: candidate.outcome }, finitePositive(candidate.value, 1));
      return true;
    case "repo_list_duration_ms":
      if (!isFiniteNonNegative(candidate.value)) return false;
      workerRepoListDurationMs.observe(candidate.value);
      return true;
    case "mirror_poll_total":
      if (!isMirrorOutcome(candidate.outcome)) return false;
      workerMirrorPollTotal.inc({ outcome: candidate.outcome }, finitePositive(candidate.value, 1));
      return true;
    case "mirror_poll_latency_ms":
      if (!isFiniteNonNegative(candidate.value)) return false;
      workerMirrorPollLatencyMs.observe(candidate.value);
      return true;
    case "mirror_poll_attempts":
      if (!isFiniteNonNegative(candidate.value)) return false;
      workerMirrorPollAttempts.observe(candidate.value);
      return true;
    case "gateway_bridge_failure": {
      if (
        !isGatewayBridgeName(candidate.bridge) ||
        !isGatewayBridgeMethod(candidate.method) ||
        !isKnownGatewayErrorCode(candidate.code)
      ) {
        return false;
      }
      const runBound = normalizeRunId(candidate.runId) ? "yes" : "no";
      workerGatewayBridgeFailuresTotal.inc(
        {
          bridge: candidate.bridge,
          method: candidate.method,
          code: candidate.code,
          run_bound: runBound,
        },
        finitePositive(candidate.value, 1),
      );
      return true;
    }
    default:
      return false;
  }
}

function isMirrorPhase(value: unknown): value is MirrorPhase {
  return value === "pick" || value === "mirror" || value === "poll" || value === "branch" ||
    value === "sandbox" || value === "land" || value === "ready";
}

function isMirrorPhaseOrEnd(value: unknown): value is MirrorPhase | "end_to_end" {
  return isMirrorPhase(value) || value === "end_to_end";
}

function isMirrorOutcome(value: unknown): value is MirrorOutcome {
  return value === "ok" || value === "client_error" || value === "server_error" ||
    value === "timeout" || value === "aborted";
}

function isGatewayBridgeName(value: unknown): value is GatewayBridgeName {
  return value === "runs" ||
    value === "approvals" ||
    value === "prompts" ||
    value === "tickets" ||
    value === "memoryFacts" ||
    value === "crons" ||
    value === "scores" ||
    value === "workflows" ||
    value === "run" ||
    value === "extension" ||
    value === "unknown";
}

function isGatewayBridgeMethod(value: unknown): value is GatewayBridgeMethod {
  return value === "listRuns" ||
    value === "listApprovals" ||
    value === "listPrompts" ||
    value === "listTickets" ||
    value === "listMemoryFacts" ||
    value === "cronList" ||
    value === "listScores" ||
    value === "listWorkflows" ||
    value === "getRun" ||
    value === "extension" ||
    value === "unknown";
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeGatewayBridgeMethod(method: string): GatewayBridgeMethod {
  if (isGatewayBridgeMethod(method)) return method;
  if (method.startsWith("ext.")) return "extension";
  return "unknown";
}

function runIdFromParams(params: unknown): string | undefined {
  if (params === null || typeof params !== "object") return undefined;
  const record = params as Record<string, unknown>;
  if (typeof record.runId === "string") return record.runId;
  const filter = record.filter;
  if (filter !== null && typeof filter === "object") {
    const filtered = filter as Record<string, unknown>;
    if (typeof filtered.runId === "string") return filtered.runId;
  }
  return undefined;
}

function normalizeRunId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) return "present";
  return trimmed;
}

/* ────────────────────────── label-classification helpers ──────────────── */

const PLATFORM_USER_ROUTE_PREFIXES = [
  "/api/user/github-repos",
  "/api/user/github/repos",
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
  if (pathname === "/api/auth/github" || pathname === "/api/auth/github/callback") return "github_auth";
  if (pathname.startsWith("/api/auth/")) return "auth";
  if (pathname === "/api/user") return "auth";
  if (pathname === "/api/ui-metrics") return "metrics";
  if (pathname === "/api/user/github-repos" || pathname === "/api/user/github/repos") return "repo_list";
  if (pathname === "/api/github/import" || pathname.startsWith("/api/github/import/")) {
    return pathname === "/api/github/import" ? "mirror" : "poll";
  }
  if (/^\/api\/repos\/[^/]+\/[^/]+\/bookmarks(?:\/.*)?$/.test(pathname)) return "branch";
  if (/^\/api\/repos\/[^/]+\/[^/]+\/workspaces(?:\/.*)?$/.test(pathname)) {
    return pathname.split("/").length > 6 ? "poll" : "workspace";
  }
  if (/^\/api\/repos\/[^/]+\/[^/]+\/landings(?:\/.*)?$/.test(pathname)) return "land";
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
  // Realtime Pair / Electric data plane (highest-volume proxy paths). Matched
  // before the generic static/unknown fallthrough, mirroring the dispatch order
  // in worker.ts routeRequest, so this traffic gets a meaningful route_kind
  // instead of collapsing into the catch-all "unknown" bucket.
  if (pathname === "/v1/shape") return "pair_shape";
  if (pathname === "/v1/app-shape") return "app_shape";
  if (pathname === "/api/pair" || pathname.startsWith("/api/pair/")) return "pair_api";
  if (pathname === "/sync" || pathname.startsWith("/sync/")) return "pair_sync";
  if (pathname === "/" || pathname.startsWith("/assets/")) return "static";
  return "unknown";
}

/** Bucket an HTTP status into Prometheus-friendly families. */
export function proxyOutcomeFor(status: number): ProxyOutcome {
  if (status === 401 || status === 403) return "auth_failure";
  if (status === 429) return "rate_limited";
  // Classify upstream-unreachable BEFORE the generic 5xx bucket: Cloudflare uses
  // 599 for upstream/connection-timeout failures, so it must not be shadowed by
  // the `status >= 500 && < 600` branch (which previously made this dead code).
  if (status === 0 || status === 599) return "upstream_unreachable";
  if (status >= 500 && status < 600) return "server_error";
  if (status >= 400 && status < 500) return "client_error";
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
  context: GatewayBridgeFailureContext = {},
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
    recordGatewayBridgeFailure(method, err, context);
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
  "GATEWAY_NOT_CONFIGURED",
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

function isKnownGatewayErrorCode(code: unknown): code is string {
  if (typeof code !== "string") return false;
  if (normalizeRpcErrorCode(code)) return true;
  return code === "HTTP_4XX" || code === "HTTP_5XX" || code === "HTTP_OTHER" || code === "UNKNOWN";
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
