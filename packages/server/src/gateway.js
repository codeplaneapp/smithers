// @smithers-type-exports-begin
/** @typedef {import("./EventFrame.js").EventFrame} EventFrame */
/** @typedef {import("./GatewayDefaults.js").GatewayDefaults} GatewayDefaults */
/** @typedef {import("./GatewayRegisterOptions.js").GatewayRegisterOptions} GatewayRegisterOptions */
/** @typedef {import("./GatewayTokenGrant.js").GatewayTokenGrant} GatewayTokenGrant */
/** @typedef {import("./GatewayUiConfig.js").GatewayUiConfig} GatewayUiConfig */
/** @typedef {import("./HelloResponse.js").HelloResponse} HelloResponse */
// @smithers-type-exports-end

import { createServer } from "node:http";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { Effect, Metric } from "effect";
import { WebSocketServer } from "ws";
import { DB_RUN_ID_MAX_LENGTH, SmithersDb } from "@smithers-orchestrator/db/adapter";
import {
  captureTxid,
  createTxidCapture,
  isRealPostgresAdapter,
  runWithTxidCapture,
} from "@smithers-orchestrator/db/captureTxid";
import { getSmithersSchemaSignature } from "@smithers-orchestrator/db/getSmithersSchemaSignature";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { loadInput } from "@smithers-orchestrator/db/snapshot";
import { sha256Hex } from "@smithers-orchestrator/db/sha256Hex";
import { watchDocsDirectory } from "@smithers-orchestrator/db/docWatcher";
import {
  devtoolsActiveSubscribers,
  devtoolsBackpressureDisconnectTotal,
  devtoolsDeltaBuildMs,
  devtoolsEventBytes,
  devtoolsEventTotal,
  devtoolsSnapshotBuildMs,
  devtoolsSubscribeTotal,
  gatewayApprovalDecisionsTotal,
  gatewayAuthEventsTotal,
  gatewayConnectionsActive,
  gatewayConnectionsClosedTotal,
  gatewayConnectionsTotal,
  gatewayCronTriggersTotal,
  gatewayErrorsTotal,
  gatewayHeartbeatTicksTotal,
  gatewayMessagesReceivedTotal,
  gatewayMessagesSentTotal,
  gatewayRpcCallsTotal,
  gatewayRpcDuration,
  gatewayRunEventBackpressureDisconnectTotal,
  gatewayRunsCompletedTotal,
  gatewayRunsStartedTotal,
  gatewaySignalsTotal,
  gatewayWebhooksReceivedTotal,
  gatewayWebhooksRejectedTotal,
  gatewayWebhooksVerifiedTotal,
} from "@smithers-orchestrator/observability/metrics";
import { runFork, runPromise } from "./smithersRuntime.js";
import { prometheusContentType, renderPrometheusMetrics } from "@smithers-orchestrator/observability";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { errorToJson } from "@smithers-orchestrator/errors/errorToJson";
import { isSmithersError } from "@smithers-orchestrator/errors/isSmithersError";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import {
  assertJsonPayloadWithinBounds,
  assertOptionalStringMaxLength,
  assertPositiveFiniteInteger,
} from "@smithers-orchestrator/db/input-bounds";
import { loadLatestSnapshot } from "@smithers-orchestrator/time-travel/snapshot";
import { diffRawSnapshots } from "@smithers-orchestrator/time-travel/diff";
import { getNodeOutputRoute } from "./gatewayRoutes/getNodeOutput.js";
import { NodeOutputRouteError } from "./gatewayRoutes/NodeOutputRouteError.js";
import { getNodeDiffRoute } from "./gatewayRoutes/getNodeDiff.js";
import { getRunDiffRoute } from "./gatewayRoutes/getRunDiff.js";
import { WhatHappenedRouteError, whatHappenedRoute } from "./gatewayRoutes/whatHappened.js";
import {
  DevToolsRouteError,
  getDevToolsSnapshotRoute,
  validateFrameNoInput,
  validateFromSeqInput,
  validateRunId,
} from "./gatewayRoutes/getDevToolsSnapshot.js";
import { streamDevToolsRoute } from "./gatewayRoutes/streamDevTools.js";
import { jumpToFrameRoute, JumpToFrameError } from "./gatewayRoutes/jumpToFrame.js";
import { retryTask as retryTaskReset } from "@smithers-orchestrator/time-travel/retry-task";
import { writeRewindAuditRow } from "@smithers-orchestrator/time-travel/writeRewindAuditRow";
import { recoverInProgressRewindAudits } from "@smithers-orchestrator/time-travel/recoverInProgressRewindAudits";
import {
  GATEWAY_EVENT_WINDOW_DEFAULT,
  GATEWAY_RPC_ERRORS,
  SMITHERS_API_VERSION,
  getRequiredScopeForGatewayMethod,
} from "@smithers-orchestrator/gateway/rpc";
import { hasGatewayScope, isGatewayScope } from "@smithers-orchestrator/gateway/auth/scopes";
import {
  apiCollectionNames,
  serializeAccountRow,
  serializeApprovalRow,
  serializeComparisonScoreRow,
  serializeCronRow,
  serializeDocRow,
  serializeMemoryFactRow,
  serializePromptRow,
  serializeRunEventRow,
  serializeRunRow,
  serializeScoreDetailRow,
  serializeScoreRow,
  serializeTicketRow,
  serializeWorkflowRow,
} from "@smithers-orchestrator/gateway/api";
import { listAccounts } from "@smithers-orchestrator/accounts/listAccounts";
import { getUsageForAccounts } from "@smithers-orchestrator/usage";
import {
  EXTENSION_BACKPRESSURE_DISCONNECT_CODE,
  EXTENSION_METHOD_NOT_FOUND_CODE,
  EXTENSION_PAYLOAD_MAX_BYTES,
  EXTENSION_STREAM_OUTBOUND_QUEUE_LIMIT,
  EXTENSION_WS_BUFFERED_HIGH_WATER_BYTES,
  GatewayExtensions,
  isExtensionMethod,
} from "./GatewayExtensions.js";
import { workflowUiThemeCss } from "@smithers-orchestrator/ui-styleguide";
import { hijackCandidatesFromAttempts } from "./hijackCandidates.js";
import { createGatewayUiApp } from "./gatewayUi/createGatewayUiApp.js";
import { renderDefaultConsoleClient } from "./gatewayUi/defaultConsole.js";
import { authorizeGatewayUiRequest } from "./gatewayUi/auth.js";
import { bundleGatewayUiEntry } from "./gatewayUi/bundle.js";
import { DEFAULT_OPERATOR_UI_ENTRY } from "./gatewayUi/defaultOperatorUi.js";
import { clampRunStartedByPrompt, normalizeRunStartedBy, SmithersCtx } from "@smithers-orchestrator/driver";
import { SMITHERS_WORKFLOW_VIEW_KIND } from "@smithers-orchestrator/components";
import { createBrowserSessionRegistry } from "./browser.js";
import { validateBrowserRequest } from "./gatewayRoutes/browser.js";
import { renderBrowserViewer } from "./gatewayUi/browserViewer.js";
/** @typedef {import("./GatewayWebhookRunConfig.js").GatewayWebhookRunConfig} GatewayWebhookRunConfig */
/** @typedef {import("./GatewayWebhookSignalConfig.js").GatewayWebhookSignalConfig} GatewayWebhookSignalConfig */
/** @typedef {import("./ConnectRequest.js").ConnectRequest} ConnectRequest */
/** @typedef {{ streamId: string, runId: string, userKey: string, outboundQueue: Record<string, unknown>[], flushPending: boolean, backpressureDisconnected: boolean, replayPending: boolean }} RunEventStreamState */
/** @typedef {{ queue: Array<{ data: string, bytes: number, event: string }>, queuedBytes: number, flushPending: boolean, disconnected: boolean }} ConnectionEventWriterState */
/** @typedef {import("./GatewayAuthConfig.js").GatewayAuthConfig} GatewayAuthConfig */
/** @typedef {import("./GatewayOperatorUiConfig.js").GatewayOperatorUiConfig} GatewayOperatorUiConfig */
/** @typedef {import("./GatewayOptions.js").GatewayOptions} GatewayOptions */
/** @typedef {import("./GatewayWebhookConfig.js").GatewayWebhookConfig} GatewayWebhookConfig */
/** @typedef {import("node:http").IncomingMessage} IncomingMessage */
/** @typedef {import("./RequestFrame.js").RequestFrame} RequestFrame */
/** @typedef {import("./ResponseFrame.js").ResponseFrame} ResponseFrame */
/** @typedef {import("node:http").ServerResponse} ServerResponse */
/** @typedef {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<unknown>} SmithersWorkflow */
/** @typedef {import("@smithers-orchestrator/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("@smithers-orchestrator/usage").UsageReport} UsageReport */
/** @typedef {Record<string, string | number | null | undefined>} GatewayMetricLabels */
/** @typedef {"ws" | "http"} GatewayTransport */
/**
 * @typedef {{
 *   connectionId?: string;
 *   role?: string;
 *   scopes?: string[];
 *   userId?: string | null;
 *   tokenId?: string | null;
 *   origin?: string;
 *   transport?: GatewayTransport;
 * }} GatewayRequestContext
 */
/**
 * @typedef {{
 *   id: string;
 *   ws?: unknown;
 *   role: string;
 *   scopes: string[];
 *   userId: string | null;
 *   subscribedRuns?: Set<string>;
 *   heartbeat?: unknown;
 *   runEventHeartbeatTimer?: ReturnType<typeof setInterval> | null;
 *   lastActivity?: number;
 *   closed?: boolean;
 *   eventWriter?: ConnectionEventWriterState | null;
 * } & Record<string, unknown>} ConnectionState
 */
/**
 * @typedef {{
 *   role: string;
 *   scopes: string[];
 *   userId?: string | null;
 *   tokenId?: string | null;
 *   connectionId?: string;
 * }} RunStartAuthContext
 */
/**
 * @typedef {{
 *   workflow: SmithersWorkflow;
 *   key: string;
 *   schedule?: string;
 *   webhook?: GatewayWebhookConfig;
 *   ui?: ResolvedGatewayUiConfig | null;
 *   tui?: ResolvedWorkflowTuiConfig | null;
 *   system?: boolean;
 *   entryFile?: string;
 * }} RegisteredWorkflow
 */
/**
 * @typedef {{
 *   runId: string;
 *   workflowKey: string;
 *   workflow: SmithersWorkflow;
 *   adapter: SmithersDb;
 * }} ResolvedRun
 */
/**
 * @typedef {{
 *   entry: string;
 *   path: string;
 *   title?: string;
 *   props?: Record<string, unknown>;
 *   builtin?: "operator";
 *   inline?: { kind: "literal"; tree: unknown } | { kind: "component"; source: string; exportName?: string };
 * }} ResolvedGatewayUiConfig
 */
/**
 * @typedef {{
 *   kind: "tui";
 *   title?: string;
 *   props?: Record<string, unknown>;
 *   entry?: string;
 *   source?: string;
 *   exportName?: string;
 *   inline?: { kind: "literal"; tree: unknown } | { kind: "component"; source: string; exportName?: string };
 * }} ResolvedWorkflowTuiConfig
 */
/**
 * @typedef {{
 *   kind: "gateway" | "workflow" | "operator";
 *   workflowKey: string | null;
 *   config: ResolvedGatewayUiConfig;
 * }} GatewayUiMount
 */

const DEFAULT_PROTOCOL = 1;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_CONNECTIONS = 1_000;
// Pre-authenticated websockets (upgraded but not yet past a successful
// `connect`) are accounted separately from authenticated connections (#1008):
// a pool of idle unauthenticated sockets can exhaust at most this many slots
// and never starves `maxConnections` authenticated capacity.
const DEFAULT_MAX_PRE_AUTH_CONNECTIONS = 64;
const DEFAULT_HEADERS_TIMEOUT = 30_000;
const DEFAULT_REQUEST_TIMEOUT = 60_000;
// WS sockets hold a `maxConnections` slot from the moment of upgrade but only
// authenticate via the `connect` RPC — a silent socket must not pin its slot
// forever, so unauthenticated connections are terminated after this deadline.
const DEFAULT_AUTH_DEADLINE_MS = 10_000;
const DEFAULT_OUT_OF_PROCESS_EVENT_BRIDGE_POLL_MS = 1_000;
const USAGE_REPORT_CACHE_TTL_MS = 60_000;
const OUT_OF_PROCESS_EVENT_BRIDGE_PAGE_LIMIT = 500;
const RUN_EVENT_HEARTBEAT_MS = 1_000;
// Per-subscriber outbound backpressure for streamRunEvents. Each run event
// stream owns a bounded queue drained against the WS socket's bufferedAmount.
// A consumer that lets the socket stay congested past the high-water mark and
// overflows the queue is disconnected (run.error: BackpressureDisconnect) so a
// single slow WebSocket cannot wedge the server with unbounded buffering.
const RUN_EVENT_STREAM_OUTBOUND_QUEUE_LIMIT = 1_000;
const RUN_EVENT_STREAM_WS_BUFFERED_HIGH_WATER_BYTES = 8 * 1024 * 1024;
const RUN_EVENT_STREAM_DRAIN_RETRY_MS = 10;
// streamRunEvents subscriber caps. The SDK normally opens one socket per run,
// while low-level clients can multiplex several runs, so a connection gets 8
// slots. A user gets 32 for several tabs and one run gets 64 concurrent
// viewers. The gateway-wide 256 cap bounds all per-stream queues and heartbeat
// work. The per-run cap separately limits hot-run fanout and replay-window
// retention, which the global cap alone does not isolate.
const RUN_EVENT_STREAM_MAX_SUBSCRIBERS = 256;
const RUN_EVENT_STREAM_MAX_SUBSCRIBERS_PER_USER = 32;
const RUN_EVENT_STREAM_MAX_SUBSCRIBERS_PER_CONNECTION = 8;
const RUN_EVENT_STREAM_MAX_SUBSCRIBERS_PER_RUN = 64;
// One byte-bounded writer per connection for EVERY gateway output frame.
// Responses and events share one serialized-byte-bounded queue that drains
// against the socket's observable bufferedAmount. Overflowing the
// per-connection byte budget closes the connection; the per-stream
// frame-count overflow (run.error: BackpressureDisconnect) still tears down
// individual slow streams first.
const CONNECTION_EVENT_WS_BUFFERED_HIGH_WATER_BYTES = 8 * 1024 * 1024;
const CONNECTION_EVENT_QUEUE_MAX_BYTES = 32 * 1024 * 1024;
const CONNECTION_EVENT_DRAIN_RETRY_MS = 10;
const CONNECTION_RESPONSE_OK = "\0response:ok";
const CONNECTION_RESPONSE_ERROR = "\0response:error";
// RFC 6455 1013 "Try Again Later": the peer may reconnect once it can keep up.
const CONNECTION_EVENT_BACKPRESSURE_CLOSE_CODE = 1013;
// Same slow-consumer guard for streamDevTools subscriptions; mirrors the
// run-event-stream limits above and the extension-stream limits in
// GatewayExtensions.js (EXTENSION_STREAM_OUTBOUND_QUEUE_LIMIT /
// EXTENSION_WS_BUFFERED_HIGH_WATER_BYTES).
const DEVTOOLS_STREAM_OUTBOUND_QUEUE_LIMIT = 1_000;
const DEVTOOLS_STREAM_WS_BUFFERED_HIGH_WATER_BYTES = 8 * 1024 * 1024;
const RUN_EVENT_WINDOW_RETAINED_RUN_LIMIT = 1_000;
const RUN_EVENT_TERMINAL_WINDOW_GRACE_MS = 1_000;
/**
 * Websocket path for the PTY hijack channel (`/v1/pty/hijack?runId=…&nodeId=…`).
 * Binary frames carry raw PTY bytes both ways; text frames are JSON control
 * messages (`{"type":"resize","cols":…,"rows":…}` client → server,
 * `{"type":"exit","code":…}` / `{"type":"error","message":…}` server → client).
 */
const PTY_HIJACK_PATH = "/v1/pty/hijack";
const PTY_MIN_DIMENSION = 2;
const PTY_MAX_DIMENSION = 1_000;
/**
 * @param {string | null} value
 * @param {number} fallback
 * @returns {number}
 */
function clampPtyDimension(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(PTY_MAX_DIMENSION, Math.max(PTY_MIN_DIMENSION, Math.floor(parsed)));
}
/**
 * Refuse a websocket upgrade with a flushed HTTP error response. `end()` (not
 * `write()`+`destroy()`) so the status reaches the peer before the socket
 * closes — a bare destroy can RST away the unsent bytes.
 *
 * @param {import("node:stream").Duplex} socket
 * @param {number} status
 * @param {string} statusText
 * @param {string} body
 */
function endUpgradeWithHttpError(socket, status, statusText, body) {
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `X-Smithers-API-Version: ${SMITHERS_API_VERSION}\r\n` +
      `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
      "\r\n" +
      body,
  );
}
const API_STREAM_COALESCE_MS = 50;
const API_STREAM_HEARTBEAT_MS = 15_000;
const API_STREAM_REPLAY_LIMIT = 256;
const API_STREAM_REPLAY_BYTES = 64 * 1024;
const API_STREAM_OUTBOUND_QUEUE_LIMIT = 256;
const API_STREAM_OUTBOUND_BYTES = 64 * 1024;
// SSE subscriber caps: one hostile or misconfigured client must not be able to
// grow the subscriber set (and its queues) without bound. Global bounds the
// whole process; per-user bounds one identity (userId ?? tokenId ?? role);
// per-connection bounds one declared `x-request-id` identity — 2 tolerates a
// reconnect that overlaps the server noticing the old socket closed.
const API_STREAM_MAX_SUBSCRIBERS = 256;
const API_STREAM_MAX_SUBSCRIBERS_PER_USER = 32;
const API_STREAM_MAX_SUBSCRIBERS_PER_CONNECTION = 2;
const API_COLLECTION_NAME_SET = new Set(apiCollectionNames);
const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "continued"]);
export const GATEWAY_RPC_MAX_PAYLOAD_BYTES = DEFAULT_MAX_BODY_BYTES;
export const GATEWAY_RPC_MAX_DEPTH = 32;
export const GATEWAY_RPC_MAX_ARRAY_LENGTH = 256;
export const GATEWAY_RPC_MAX_STRING_LENGTH = 16 * 1024;
export const GATEWAY_METHOD_NAME_MAX_LENGTH = 64;
export const GATEWAY_FRAME_ID_MAX_LENGTH = 128;
export const GATEWAY_RPC_INPUT_MAX_BYTES = GATEWAY_RPC_MAX_PAYLOAD_BYTES;
export const GATEWAY_RPC_INPUT_MAX_DEPTH = GATEWAY_RPC_MAX_DEPTH;
const GATEWAY_METHOD_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/;
const GATEWAY_UI_ASSET_PREFIX = "__smithers_ui";

let engineRuntimePromise = null;
let engineApprovalsPromise = null;
let engineSignalsPromise = null;

function loadEngineRuntime() {
  engineRuntimePromise ??= import("@smithers-orchestrator/engine");
  return engineRuntimePromise;
}

function loadEngineApprovals() {
  engineApprovalsPromise ??= import("@smithers-orchestrator/engine/approvals");
  return engineApprovalsPromise;
}

function loadEngineSignals() {
  engineSignalsPromise ??= import("@smithers-orchestrator/engine/signals");
  return engineSignalsPromise;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeJsonScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * Pre-paint theme override for gateway-served UI pages. An embedding host (an
 * iframe or a deep link) forces a theme with `?theme=dark` / `?theme=light`;
 * the script stamps it as `data-theme` on `<html>` before first paint, which
 * the injected style-guide tokens (and `color-scheme`) honor. Without the
 * param the page follows the OS via `prefers-color-scheme`.
 */
const GATEWAY_UI_THEME_BOOTSTRAP_SCRIPT =
  '(function(){var t=new URLSearchParams(location.search).get("theme");if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t;}})();';

/**
 * @param {string | undefined} rawPath
 * @param {string} fallbackPath
 * @returns {string}
 */
function normalizeUiMountPath(rawPath, fallbackPath) {
  const candidate = (rawPath && rawPath.trim()) || fallbackPath;
  const withSlash = candidate.startsWith("/") ? candidate : `/${candidate}`;
  const withoutTrailing = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  if (!/^\/[A-Za-z0-9/_:.-]*$/.test(withoutTrailing)) {
    throw new SmithersError("INVALID_INPUT", `Gateway UI path is invalid: ${candidate}`);
  }
  return withoutTrailing;
}

/**
 * @param {string} mountPath
 * @param {string} suffix
 * @returns {string}
 */
function joinUiPath(mountPath, suffix) {
  if (mountPath === "/") {
    return `/${suffix.replace(/^\/+/, "")}`;
  }
  return `${mountPath}/${suffix.replace(/^\/+/, "")}`;
}

/**
 * @param {GatewayUiConfig | undefined} ui
 * @param {string} fallbackPath
 * @returns {ResolvedGatewayUiConfig | null}
 */
function resolveGatewayUiConfig(ui, fallbackPath) {
  if (!ui) {
    return null;
  }
  if (ui === true) {
    return {
      entry: DEFAULT_OPERATOR_UI_ENTRY,
      path: normalizeUiMountPath(fallbackPath === "/" ? "/console" : fallbackPath, fallbackPath),
      title: "Smithers Operator Console",
      builtin: "operator",
      props: {},
    };
  }
  if (typeof ui.entry !== "string" || !ui.entry.trim()) {
    throw new SmithersError("INVALID_INPUT", "Gateway UI config requires a non-empty entry path.");
  }
  return {
    entry: resolve(process.cwd(), ui.entry),
    path: normalizeUiMountPath(ui.path, fallbackPath),
    ...(typeof ui.title === "string" ? { title: ui.title } : {}),
    ...(ui.props && typeof ui.props === "object" && !Array.isArray(ui.props) ? { props: ui.props } : {}),
  };
}
/**
 * @param {GatewayOperatorUiConfig | false | undefined} ui
 * @returns {ResolvedGatewayUiConfig | null}
 */
function resolveDefaultOperatorUiConfig(ui) {
  if (ui === false) {
    return null;
  }
  const config = ui && typeof ui === "object" && !Array.isArray(ui) ? ui : {};
  return {
    entry: DEFAULT_OPERATOR_UI_ENTRY,
    path: normalizeUiMountPath(config.path, "/console"),
    title: typeof config.title === "string" ? config.title : "Smithers Operator Console",
    props: config.props && typeof config.props === "object" && !Array.isArray(config.props) ? config.props : {},
    builtin: "operator",
  };
}

/**
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @returns {Headers}
 */
function nodeHeadersToFetchHeaders(headers) {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        out.append(key, entry);
      }
      continue;
    }
    out.set(key, value);
  }
  return out;
}

/**
 * @param {ServerResponse} res
 * @param {Response} response
 * @param {boolean} headOnly
 */
async function writeFetchResponse(res, response, headOnly = false) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (headOnly) {
    res.end();
    return;
  }
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}
/**
 * @template T
 * @param {string | null | undefined} value
 * @returns {T | null}
 */
function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
/**
 * @param {Record<string, unknown> | undefined} row
 * @returns {Record<string, unknown>}
 */
function normalizeRerunInput(row) {
  if (!row || typeof row !== "object") {
    return {};
  }
  if ("payload" in row) {
    const { runId: _runId, payload, ...rest } = row;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return { ...payload, ...rest };
    }
    return rest;
  }
  const { runId: _runId, ...rest } = row;
  return rest;
}
/**
 * @param {unknown} run
 * @returns {string | null}
 */
function resolveRunOwnerId(run) {
  const config = parseJson(typeof run?.configJson === "string" ? run.configJson : null);
  const auth = asObject(config?.auth);
  const owner = asString(auth?.triggeredBy);
  return owner ? owner : null;
}
/**
 * Lift the persisted launch provenance out of a run row's configJson so run
 * payloads expose a top-level `startedBy`, the shape the v1 contract and the
 * gateway-ui provenance surfaces consume.
 *
 * @param {{ configJson?: string | null }} row
 * @returns {import("@smithers-orchestrator/driver/RunStartedBy").RunStartedBy | undefined}
 */
function runStartedByFromRow(row) {
  const config = parseJson(typeof row?.configJson === "string" ? row.configJson : null);
  try {
    return normalizeRunStartedBy(asObject(config?.startedBy) ?? undefined);
  } catch {
    return undefined;
  }
}

/**
 * Read the immutable visibility stamp. Missing/malformed historical config is
 * internal by default so an unknown row can never leak into an ordinary list.
 * @param {{ configJson?: string | null } | null | undefined} row
 * @returns {boolean}
 */
function runSystemFromRow(row) {
  const config = parseJson(typeof row?.configJson === "string" ? row.configJson : null);
  return typeof config?.gatewaySystem === "boolean" ? config.gatewaySystem : true;
}
/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Smithers-API-Version", SMITHERS_API_VERSION);
  res.end(JSON.stringify(payload));
}
/**
 * @param {ServerResponse} res
 * @param {string} location
 */
function sendRedirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Smithers-API-Version", SMITHERS_API_VERSION);
  res.end();
}
/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} payload
 */
function sendText(res, status, payload, contentType = "text/plain; charset=utf-8") {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Smithers-API-Version", SMITHERS_API_VERSION);
  res.end(payload);
}
/**
 * The session-handoff landing page: navigates to `next` with
 * `location.replace` so the token-carrying handoff URL is replaced in the
 * address bar AND dropped from browser history. A noscript meta refresh
 * covers JS-off browsers (it still replaces the address bar, just not
 * history). `next` is already constrained to a same-origin absolute path.
 *
 * @param {string} next
 * @returns {string}
 */
function renderSessionHandoffPage(next) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0; url=${escapeHtml(next)}">
    <title>Opening Smithers…</title>
    <script>location.replace(${safeJsonScript(next)});</script>
  </head>
  <body>
    <p>Opening <a href="${escapeHtml(next)}">Smithers</a>…</p>
  </body>
</html>`;
}
/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

/**
 * Public RPC/REST requests reject unknown attribution keys before the shared
 * normalizer applies code-point limits and prompt clipping.
 * @param {unknown} value
 */
function parseGatewayStartedBy(value) {
  const startedBy = asObject(value);
  if (!startedBy) {
    throw new SmithersError("INVALID_REQUEST", "options.startedBy must be an object");
  }
  const allowed = new Set(["harness", "sessionId", "prompt", "detected"]);
  for (const key of Object.keys(startedBy)) {
    if (!allowed.has(key)) {
      throw new SmithersError("INVALID_REQUEST", `options.startedBy.${key} is not allowed`);
    }
  }
  for (const key of ["harness", "sessionId", "prompt"]) {
    if (startedBy[key] !== undefined && typeof startedBy[key] !== "string") {
      throw new SmithersError("INVALID_REQUEST", `options.startedBy.${key} must be a string`);
    }
  }
  if (startedBy.detected !== undefined && startedBy.detected !== true) {
    throw new SmithersError("INVALID_REQUEST", "options.startedBy.detected must be true when present");
  }
  try {
    return normalizeRunStartedBy(startedBy);
  } catch (error) {
    throw new SmithersError("INVALID_REQUEST", error?.message ?? String(error));
  }
}
/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function asString(value) {
  return typeof value === "string" ? value : undefined;
}
/**
 * Whether an HTTP `Host` header names a loopback interface. Used for the
 * DNS-rebinding defense (spec decision 16a): a page at evil.com rebound to
 * 127.0.0.1 sends `Host: evil.com`, so requiring a loopback Host rejects it
 * even when the Origin check is permissive. Handles an optional :port and
 * IPv6 brackets, and treats `*.localhost` and the whole 127/8 block as loopback.
 * @param {string} hostHeader
 * @returns {boolean}
 */
function isLoopbackHost(hostHeader) {
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    // Bracketed IPv6, e.g. "[::1]:7331" or "[::1]".
    const end = host.indexOf("]");
    host = end >= 0 ? host.slice(1, end) : host.slice(1);
  } else {
    // Strip a trailing :port, but only from a single-colon host ("host:port"):
    // an unbracketed IPv6 literal like "::1" has multiple colons, so leaving it
    // intact lets the `host === "::1"` check below match it (a lone-colon slice
    // would otherwise mangle "::1" to ":" and wrongly reject loopback).
    const colon = host.lastIndexOf(":");
    if (colon >= 0 && colon === host.indexOf(":") && /^\d+$/.test(host.slice(colon + 1))) {
      host = host.slice(0, colon);
    }
  }
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1" ||
    host.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}
/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
/**
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
function asBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}
/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function asWebhookString(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return undefined;
}
/**
 * @template M
 * @param {M} metric
 * @param {GatewayMetricLabels} [labels]
 * @returns {M}
 */
function taggedMetric(metric, labels = {}) {
  let tagged = metric;
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined || value === null) {
      continue;
    }
    tagged = Metric.withAttributes(tagged, { [key]: String(String(value)) });
  }
  return tagged;
}
/**
 * @template M
 * @param {M} metric
 * @param {GatewayMetricLabels} [labels]
 */
function incrementMetric(metric, labels = {}) {
  return Metric.update(taggedMetric(metric, labels), 1);
}
/**
 * @template M
 * @param {M} metric
 * @param {number} value
 * @param {GatewayMetricLabels} [labels]
 */
function updateMetric(metric, value, labels = {}) {
  return Metric.update(taggedMetric(metric, labels), value);
}
/**
 * @param {Effect.Effect<void, never, never>} effect
 */
function emitGatewayEffect(effect) {
  void runFork(effect);
}
/**
 * @param {"debug" | "info" | "warning" | "error"} level
 * @param {string} message
 * @param {Record<string, unknown>} [annotations]
 * @param {string} [span]
 */
function emitGatewayLog(level, message, annotations, span) {
  let effect =
    level === "debug"
      ? Effect.logDebug(message)
      : level === "info"
        ? Effect.logInfo(message)
        : level === "warning"
          ? Effect.logWarning(message)
          : Effect.logError(message);
  if (annotations && Object.keys(annotations).length > 0) {
    effect = effect.pipe(Effect.annotateLogs(annotations));
  }
  if (span) {
    effect = effect.pipe(Effect.withLogSpan(span));
  }
  emitGatewayEffect(effect);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isProtocolSpecifier(value) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isAbsoluteFilePath(value) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isRelativeFilePath(value) {
  return value.startsWith("./") || value.startsWith("../") || value.startsWith(".\\") || value.startsWith("..\\");
}

/**
 * @param {string} value
 * @param {string | undefined} entryFile
 * @returns {string}
 */
function resolveWorkflowEntryRef(value, entryFile) {
  if (isProtocolSpecifier(value) || isAbsoluteFilePath(value)) {
    return value;
  }
  const base = entryFile ? dirname(entryFile) : process.cwd();
  return resolve(base, value);
}

/**
 * @param {string} value
 * @param {string | undefined} entryFile
 * @returns {string}
 */
function resolveWorkflowSourceRef(value, entryFile) {
  if (isProtocolSpecifier(value) || isAbsoluteFilePath(value)) {
    return value;
  }
  if (isRelativeFilePath(value)) {
    return resolve(entryFile ? dirname(entryFile) : process.cwd(), value);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function plainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function serializeLiteralPropValue(value, depth = 0) {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth > 16) {
    throw new SmithersError("INVALID_INPUT", "Inline <UI> props are nested too deeply.");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => serializeLiteralPropValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      const serialized = serializeLiteralPropValue(entry, depth + 1);
      if (serialized !== undefined) {
        out[key] = serialized;
      }
    }
    return out;
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} props
 * @returns {Record<string, unknown>}
 */
function serializeLiteralElementProps(props) {
  const out = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "ref" || key === "key" || key === "dangerouslySetInnerHTML") {
      continue;
    }
    const serialized = serializeLiteralPropValue(value);
    if (serialized !== undefined) {
      out[key] = serialized;
    }
  }
  return out;
}

/**
 * @param {unknown} node
 * @param {number} depth
 * @returns {unknown}
 */
function serializeLiteralReactNode(node, depth = 0) {
  if (node == null || typeof node === "boolean") {
    return null;
  }
  if (typeof node === "string" || typeof node === "number") {
    return node;
  }
  if (depth > 64) {
    throw new SmithersError("INVALID_INPUT", "Inline <UI> children are nested too deeply.");
  }
  if (Array.isArray(node)) {
    return node.map((entry) => serializeLiteralReactNode(entry, depth + 1)).filter((entry) => entry !== null);
  }
  if (typeof node !== "object") {
    return null;
  }
  const element = /** @type {{ type?: unknown; props?: Record<string, unknown> }} */ (node);
  if (!("type" in element) || !("props" in element)) {
    return null;
  }
  if (typeof element.type === "symbol") {
    return serializeLiteralReactNode(element.props?.children, depth + 1);
  }
  if (typeof element.type !== "string") {
    throw new SmithersError(
      "INVALID_INPUT",
      "Inline <UI> children can only contain intrinsic DOM elements. Use <UI entry=...> for component-based apps.",
    );
  }
  const children = serializeLiteralReactNode(element.props?.children, depth + 1);
  const childArray = Array.isArray(children) ? children : children == null ? [] : [children];
  return {
    type: element.type,
    props: serializeLiteralElementProps(element.props ?? {}),
    children: childArray,
  };
}

/**
 * @param {unknown} value
 * @returns {"ui" | "tui" | undefined}
 */
function workflowViewKind(value) {
  if (!value || (typeof value !== "function" && typeof value !== "object")) {
    return undefined;
  }
  const kind = /** @type {Record<PropertyKey, unknown>} */ (value)[SMITHERS_WORKFLOW_VIEW_KIND];
  return kind === "ui" || kind === "tui" ? kind : undefined;
}

/**
 * @param {unknown} node
 * @param {(kind: "ui" | "tui", props: Record<string, unknown>) => void} visit
 */
function visitWorkflowViewElements(node, visit) {
  if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      visitWorkflowViewElements(child, visit);
    }
    return;
  }
  if (typeof node !== "object") {
    return;
  }
  const element = /** @type {{ type?: unknown; props?: Record<string, unknown> }} */ (node);
  const props = element.props ?? {};
  const kind = workflowViewKind(element.type);
  if (kind) {
    visit(kind, props);
  }
  if ("children" in props) {
    visitWorkflowViewElements(props.children, visit);
  }
}

/**
 * @param {"ui" | "tui"} kind
 * @param {Record<string, unknown>} props
 * @param {string} workflowKey
 * @param {string | undefined} entryFile
 * @returns {import("@smithers-orchestrator/driver/WorkflowView").WorkflowViewDefinition | null}
 */
function normalizeWorkflowViewDeclaration(kind, props, workflowKey, entryFile) {
  const title = asString(props.title);
  const bootProps = plainRecord(props.props);
  if (typeof props.entry === "string" && props.entry.trim()) {
    return {
      kind,
      entry: resolveWorkflowEntryRef(props.entry.trim(), entryFile),
      ...(kind === "ui" && typeof props.path === "string" ? { path: props.path } : {}),
      ...(title ? { title } : {}),
      props: bootProps,
    };
  }
  if (typeof props.source === "string" && props.source.trim()) {
    const source = resolveWorkflowSourceRef(props.source.trim(), entryFile);
    const exportName =
      typeof props.exportName === "string" && props.exportName.trim() ? props.exportName.trim() : "default";
    return {
      kind,
      source,
      exportName,
      ...(kind === "ui" && typeof props.path === "string" ? { path: props.path } : {}),
      ...(title ? { title } : {}),
      props: bootProps,
    };
  }
  if ("children" in props && props.children != null) {
    return {
      kind,
      literal: serializeLiteralReactNode(props.children),
      ...(kind === "ui" && typeof props.path === "string" ? { path: props.path } : {}),
      ...(title ? { title } : {}),
      props: bootProps,
    };
  }
  throw new SmithersError(
    "INVALID_INPUT",
    `<${kind === "ui" ? "UI" : "TUI"}> in workflow ${workflowKey} requires entry, source, or literal children.`,
  );
}

/**
 * @param {import("@smithers-orchestrator/driver/WorkflowView").WorkflowViewDefinition} view
 * @param {string} workflowKey
 * @param {string} fallbackPath
 * @returns {ResolvedGatewayUiConfig}
 */
function workflowViewToGatewayUiConfig(view, workflowKey, fallbackPath) {
  const path = normalizeUiMountPath(view.path, fallbackPath);
  const title = view.title ?? workflowKey;
  if (view.entry) {
    return { entry: view.entry, path, title, props: view.props ?? {} };
  }
  if (view.source) {
    return {
      entry: `smithers-inline-component:${workflowKey}`,
      path,
      title,
      props: view.props ?? {},
      inline: { kind: "component", source: view.source, exportName: view.exportName ?? "default" },
    };
  }
  return {
    entry: `smithers-inline-literal:${workflowKey}`,
    path,
    title,
    props: view.props ?? {},
    inline: { kind: "literal", tree: view.literal ?? null },
  };
}

/**
 * @param {import("@smithers-orchestrator/driver/WorkflowView").WorkflowViewDefinition} view
 * @returns {ResolvedWorkflowTuiConfig}
 */
function workflowViewToTuiConfig(view) {
  return {
    kind: "tui",
    ...(view.title ? { title: view.title } : {}),
    props: view.props ?? {},
    ...(view.entry ? { entry: view.entry } : {}),
    ...(view.source ? { source: view.source, exportName: view.exportName ?? "default" } : {}),
    ...(view.literal !== undefined ? { inline: { kind: "literal", tree: view.literal } } : {}),
  };
}

/**
 * @param {string} workflowKey
 * @param {SmithersWorkflow} workflow
 * @param {string | undefined} entryFile
 * @returns {{ ui?: import("@smithers-orchestrator/driver/WorkflowView").WorkflowViewDefinition; tui?: import("@smithers-orchestrator/driver/WorkflowView").WorkflowViewDefinition }}
 */
function discoverWorkflowViews(workflowKey, workflow, entryFile) {
  const views = {};
  let root;
  try {
    const ctx = new SmithersCtx({
      runId: `__smithers_ui_discovery__:${workflowKey}`,
      iteration: 0,
      iterations: {},
      input: {},
      auth: null,
      outputs: {},
      zodToKeyName: workflow.zodToKeyName,
      runtimeConfig: {
        ...(entryFile ? { workflowPath: entryFile, baseRootDir: dirname(entryFile) } : {}),
      },
    });
    root = workflow.build(ctx);
  } catch (error) {
    emitGatewayLog(
      "warning",
      "workflow UI discovery render failed",
      {
        workflow: workflowKey,
        ...gatewayErrorAnnotations(error),
      },
      "gateway:workflow-ui-discovery",
    );
    return views;
  }
  visitWorkflowViewElements(root, (kind, props) => {
    if (views[kind]) {
      throw new SmithersError(
        "INVALID_INPUT",
        `Workflow ${workflowKey} declares more than one <${kind === "ui" ? "UI" : "TUI"}>.`,
      );
    }
    views[kind] = normalizeWorkflowViewDeclaration(kind, props, workflowKey, entryFile);
  });
  return views;
}
/**
 * @param {GatewayRequestContext} context
 * @returns {Record<string, unknown>}
 */
function gatewayContextAnnotations(context) {
  return {
    connectionId: context.connectionId,
    transport: context.transport,
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.role ? { role: context.role } : {}),
    ...(context.tokenId ? { tokenId: context.tokenId } : {}),
  };
}
/**
 * @param {Record<string, unknown>} [params]
 * @param {unknown} [payload]
 * @returns {Record<string, unknown>}
 */
function gatewayRunAnnotations(params, payload) {
  const annotations = {};
  const responsePayload = asObject(payload);
  const runId = asString(params?.runId) ?? asString(responsePayload?.runId);
  const leftRunId = asString(params?.leftRunId);
  const rightRunId = asString(params?.rightRunId);
  if (runId) {
    annotations.runId = runId;
  }
  if (leftRunId) {
    annotations.leftRunId = leftRunId;
  }
  if (rightRunId) {
    annotations.rightRunId = rightRunId;
  }
  return annotations;
}
/**
 * @param {string} runId
 * @returns {string}
 */
function devtoolsRunMetricTag(runId) {
  return createHash("sha1").update(runId).digest("hex").slice(0, 12);
}
/**
 * @param {GatewayRequestContext} context
 * @param {Pick<RequestFrame, "id" | "method" | "params">} frame
 * @param {unknown} [payload]
 * @returns {Record<string, unknown>}
 */
function gatewayRpcAnnotations(context, frame, payload) {
  return {
    ...gatewayContextAnnotations(context),
    frameId: frame.id,
    method: frame.method,
    ...gatewayRunAnnotations(asObject(frame.params) ?? {}, payload),
  };
}
/**
 * @param {unknown} error
 * @returns {string}
 */
function gatewayErrorCode(error) {
  if (error && typeof error === "object") {
    const code = asString(error.code);
    if (code) {
      return code;
    }
  }
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return "UNKNOWN";
}
/**
 * @param {unknown} error
 * @returns {Record<string, unknown>}
 */
function gatewayErrorAnnotations(error) {
  const serialized = asObject(errorToJson(error)) ?? { message: String(error) };
  const summary = asString(serialized.summary);
  const message = asString(serialized.message);
  return {
    errorCode: gatewayErrorCode(error),
    ...(summary ? { errorSummary: summary } : {}),
    ...(message ? { errorMessage: message } : {}),
    error: serialized,
  };
}
/**
 * @param {GatewayAuthConfig | undefined} auth
 * @returns {string}
 */
function gatewayAuthMode(auth) {
  return auth?.mode ?? "none";
}
/**
 * @param {string} triggeredBy
 * @returns {string}
 */
function gatewayTriggerSource(triggeredBy) {
  if (triggeredBy.startsWith("cron:")) {
    return "cron";
  }
  if (triggeredBy.startsWith("webhook:")) {
    return "webhook";
  }
  if (triggeredBy === "gateway") {
    return "gateway";
  }
  return "user";
}
/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number | undefined}
 */
function asOptionalPositiveInt(value, field) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return Math.floor(assertPositiveFiniteInteger(field, Number(value)));
}
/**
 * @param {IncomingMessage} req
 * @param {string} name
 * @returns {string | null}
 */
function headerValue(req, name) {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === "string" ? value : null;
}
/**
 * Browser session cookie carrying the gateway bearer token. Browsers cannot
 * send an Authorization header on top-level navigations (or WebSocket
 * upgrades), so `GET /v1/auth/session` exchanges a bearer for this HttpOnly
 * cookie and every authenticated path accepts it as an alternative. SameSite=Lax
 * keeps it off cross-site subrequests (CSRF), matching the Origin allow-list
 * model.
 */
export const GATEWAY_SESSION_COOKIE = "smithers_session";

/**
 * Whether the request reached us over TLS (directly or through a terminating
 * proxy that set `X-Forwarded-Proto`). Only then may the session cookie carry
 * `Secure` — setting it on plain HTTP would make the browser drop it.
 *
 * @param {IncomingMessage} req
 * @returns {boolean}
 */
function isSecureRequest(req) {
  if (/** @type {{ encrypted?: boolean }} */ (req.socket).encrypted === true) {
    return true;
  }
  const forwarded = headerValue(req, "x-forwarded-proto");
  return forwarded !== null && forwarded.split(",")[0].trim().toLowerCase() === "https";
}

/**
 * @param {IncomingMessage} req
 * @returns {string | null}
 */
function sessionTokenFromCookies(req) {
  const header = headerValue(req, "cookie");
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() !== GATEWAY_SESSION_COOKIE) {
      continue;
    }
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw) || null;
    } catch {
      return raw || null;
    }
  }
  return null;
}

/**
 * Whether the request's ONLY credential is the ambient session cookie: no
 * explicit `x-smithers-key` and no `Authorization` header, but a session
 * cookie is present. Such requests are CSRF-shaped (the browser attaches the
 * cookie automatically) and get the stricter cookie-origin gate.
 * @param {IncomingMessage} req
 * @returns {boolean}
 */
function requestUsesAmbientCookieAuth(req) {
  if (headerValue(req, "x-smithers-key")) {
    return false;
  }
  if (headerValue(req, "authorization")) {
    return false;
  }
  return sessionTokenFromCookies(req) !== null;
}
/**
 * @param {IncomingMessage} req
 * @returns {string | null}
 */
function bearerTokenFromHeaders(req) {
  const smithersKey = headerValue(req, "x-smithers-key");
  if (smithersKey) {
    return smithersKey;
  }
  const authHeader = headerValue(req, "authorization");
  if (authHeader) {
    return authHeader.slice(0, 7).toLowerCase() === "bearer " ? authHeader.slice(7) : authHeader;
  }
  return sessionTokenFromCookies(req);
}
/**
 * @param {string} id
 * @param {unknown} [payload]
 * @returns {ResponseFrame}
 */
function responseOk(id, payload) {
  return { type: "res", id, ok: true, apiVersion: SMITHERS_API_VERSION, payload };
}
/**
 * @param {string} id
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {ResponseFrame}
 */
function responseError(id, code, message, details = {}) {
  return {
    type: "res",
    id,
    ok: false,
    apiVersion: SMITHERS_API_VERSION,
    error: {
      version: SMITHERS_API_VERSION,
      code,
      message,
      ...details,
    },
  };
}
/**
 * @param {string} id
 * @param {string} method
 * @param {{ requiredScopeForMethod?: (method: string) => import("@smithers-orchestrator/gateway/auth/scopes").GatewayScope | undefined }} [registry]
 * @returns {ResponseFrame}
 */
function responseForbidden(id, method, registry) {
  const requiredScope = requiredScopeForMethod(method, registry);
  return responseError(id, "FORBIDDEN", `Missing required scope ${requiredScope} for ${method}`, {
    requiredScope,
  });
}
/**
 * @param {unknown} raw
 * @returns {string}
 */
function rawDataToUtf8(raw) {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(entry)))).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}
/**
 * @param {unknown} method
 * @returns {string}
 */
/**
 * Clamp a frame's `options.startedBy.prompt` to its persisted budget BEFORE
 * the generic frame string bound runs: an over-long launch prompt truncates
 * (the documented startedBy behavior) instead of rejecting the whole frame.
 * Mutates the params object in place; every other field still faces the
 * generic bounds untouched.
 *
 * @param {unknown} params
 */
export function clampFrameStartedByPrompt(params) {
  if (typeof params !== "object" || params === null) return;
  const options = /** @type {Record<string, unknown>} */ (params).options;
  if (typeof options !== "object" || options === null) return;
  const startedBy = /** @type {Record<string, unknown>} */ (options).startedBy;
  if (typeof startedBy !== "object" || startedBy === null) return;
  const prompt = /** @type {Record<string, unknown>} */ (startedBy).prompt;
  if (typeof prompt !== "string") return;
  /** @type {Record<string, unknown>} */ (startedBy).prompt = clampRunStartedByPrompt(prompt);
}

export function validateGatewayMethodName(method) {
  if (typeof method !== "string") {
    throw new SmithersError("INVALID_INPUT", "Gateway method name must be a string.", { methodType: typeof method });
  }
  assertOptionalStringMaxLength("method", method, GATEWAY_METHOD_NAME_MAX_LENGTH);
  if (!GATEWAY_METHOD_NAME_PATTERN.test(method)) {
    throw new SmithersError("INVALID_INPUT", "Gateway method name is invalid.", { method });
  }
  return method;
}
/**
 * @param {unknown} raw
 * @returns {RequestFrame}
 */
export function parseGatewayRequestFrame(raw, maxPayloadBytes = GATEWAY_RPC_MAX_PAYLOAD_BYTES) {
  const body = rawDataToUtf8(raw);
  if (Buffer.byteLength(body, "utf8") > maxPayloadBytes) {
    throw new SmithersError("INVALID_INPUT", `Gateway RPC payload exceeds ${maxPayloadBytes} bytes.`, {
      maxBytes: maxPayloadBytes,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new SmithersError("INVALID_INPUT", "Gateway RPC payload must be valid JSON.", undefined, { cause: error });
  }
  clampFrameStartedByPrompt(parsed?.params);
  assertJsonPayloadWithinBounds("gateway frame", parsed, {
    maxArrayLength: GATEWAY_RPC_MAX_ARRAY_LENGTH,
    maxDepth: GATEWAY_RPC_MAX_DEPTH,
    maxStringLength: GATEWAY_RPC_MAX_STRING_LENGTH,
  });
  const frame = asObject(parsed);
  if (!frame || frame.type !== "req") {
    throw new SmithersError("INVALID_INPUT", "Gateway frame must be a request object.");
  }
  if (typeof frame.id !== "string") {
    throw new SmithersError("INVALID_INPUT", "Gateway frame id must be a string.");
  }
  assertOptionalStringMaxLength("id", frame.id, GATEWAY_FRAME_ID_MAX_LENGTH);
  return {
    type: "req",
    id: frame.id,
    method: validateGatewayMethodName(frame.method),
    params: frame.params,
  };
}
/**
 * @param {unknown} value
 * @param {number} depth
 * @param {Set<unknown>} seen
 * @returns {number}
 */
function gatewayInputDepthAt(value, depth, seen) {
  if (!value || typeof value !== "object") {
    return depth;
  }
  if (seen.has(value)) {
    throw new SmithersError("INVALID_INPUT", "Gateway RPC input must not contain circular references.");
  }
  seen.add(value);
  let maxDepth = depth;
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    const entryDepth = entry && typeof entry === "object" ? gatewayInputDepthAt(entry, depth + 1, seen) : depth;
    if (entryDepth > maxDepth) {
      maxDepth = entryDepth;
    }
  }
  seen.delete(value);
  return maxDepth;
}
/**
 * @param {unknown} value
 * @returns {number}
 */
export function getGatewayInputDepth(value) {
  if (!value || typeof value !== "object") {
    return 0;
  }
  return gatewayInputDepthAt(value, 1, new Set());
}
/**
 * @param {unknown} value
 * @returns {number}
 */
export function assertGatewayInputDepthWithinBounds(value, maxDepth = GATEWAY_RPC_INPUT_MAX_DEPTH) {
  const depth = getGatewayInputDepth(value);
  if (depth > maxDepth) {
    throw new SmithersError("INVALID_INPUT", `Gateway RPC input exceeds the maximum nesting depth of ${maxDepth}.`, {
      actualDepth: depth,
      maxDepth,
    });
  }
  return depth;
}
/**
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
function validateGatewayRpcInput(input) {
  const normalizedInput = asObject(input) ?? {};
  const inputJson = JSON.stringify(normalizedInput);
  if (inputJson === undefined) {
    throw new SmithersError("INVALID_INPUT", "Gateway RPC input must be JSON-serializable.");
  }
  const inputBytes = Buffer.byteLength(inputJson, "utf8");
  if (inputBytes > GATEWAY_RPC_INPUT_MAX_BYTES) {
    throw new SmithersError("INVALID_INPUT", `Gateway RPC input exceeds ${GATEWAY_RPC_INPUT_MAX_BYTES} bytes.`, {
      actualBytes: inputBytes,
      maxBytes: GATEWAY_RPC_INPUT_MAX_BYTES,
    });
  }
  assertGatewayInputDepthWithinBounds(normalizedInput);
  return normalizedInput;
}
/**
 * @param {string | undefined} code
 */
export function statusForRpcError(code) {
  switch (code) {
    case "UNAUTHORIZED":
    case "Unauthorized":
      return 401;
    case "FORBIDDEN":
    case "Forbidden":
      return 403;
    case "NOT_FOUND":
    case "METHOD_NOT_FOUND":
      return 404;
    case "INVALID_REQUEST":
    case "InvalidRequest":
    case "INVALID_FRAME":
    case "INVALID_INPUT":
    case "InvalidInput":
    case "PROTOCOL_UNSUPPORTED":
    case "InvalidRunId":
    case "InvalidNodeId":
    case "InvalidIteration":
    case "InvalidDelta":
    case "InvalidFrameNo":
    case "ConfirmationRequired":
    case "FrameOutOfRange":
    case "SeqOutOfRange":
      return 400;
    case "RunNotFound":
    case "ScoreNotFound":
    case "NodeNotFound":
    case "AttemptNotFound":
    case "IterationNotFound":
    case "NodeHasNoOutput":
      return 404;
    case "AttemptNotFinished":
    case "Busy":
    case "AlreadyDecided":
    case "RUN_NOT_ACTIVE":
    case "RUN_ACTIVE":
    case "CONFLICT":
      return 409;
    case "REVISION_CONFLICT":
      return 409;
    case "SSRF_BLOCKED":
      return 400;
    case "QUOTA_EXCEEDED":
      return 429;
    case "DiffTooLarge":
    case "PayloadTooLarge":
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "RateLimited":
    case "BackpressureDisconnect":
      return 429;
    case "UnsupportedSandbox":
      return 501;
    case "VcsError":
    case "RewindFailed":
      return 500;
    default:
      return 500;
  }
}
/**
 * @param {unknown} payload
 * @returns {string | null}
 */
function eventRunId(payload) {
  const record = asObject(payload);
  const runId = record ? asString(record.runId) : undefined;
  return runId ?? null;
}
function eventBrowserSessionId(event, payload) {
  if (event !== "browser.frame" && event !== "browser.activity") return null;
  return asString(asObject(payload)?.sessionId) ?? null;
}
/**
 * @param {string} method
 * @param {{ requiredScopeForMethod?: (method: string) => import("@smithers-orchestrator/gateway/auth/scopes").GatewayScope | undefined }} [registry]
 * @returns {import("@smithers-orchestrator/gateway/auth/scopes").GatewayScope}
 */
function requiredScopeForMethod(method, registry) {
  if (
    method === "run:read" ||
    method === "run:write" ||
    method === "run:admin" ||
    method === "approval:submit" ||
    method === "signal:submit" ||
    method === "cron:read" ||
    method === "cron:write" ||
    method === "observability:read"
  ) {
    return method;
  }
  if (method.startsWith("config.")) {
    return "run:admin";
  }
  if (method.startsWith("oneshotMonitor")) {
    return "run:write";
  }
  if (registry && isExtensionMethod(method)) {
    const extScope = registry.requiredScopeForMethod(method);
    if (extScope) {
      return extScope;
    }
  }
  return getRequiredScopeForGatewayMethod(method) ?? "run:read";
}
/**
 * @param {string[]} scopes
 * @param {string} method
 * @param {{ requiredScopeForMethod?: (method: string) => import("@smithers-orchestrator/gateway/auth/scopes").GatewayScope | undefined }} [registry]
 * @returns {boolean}
 */
function hasScope(scopes, method, registry) {
  return hasGatewayScope(
    scopes.map((scope) => scope.trim()),
    requiredScopeForMethod(method, registry),
    method,
  );
}
/**
 * @param {string[]} scopes
 * @param {string} allowedScope
 * @returns {boolean}
 */
function hasApprovalScope(scopes, allowedScope) {
  const required = allowedScope.trim();
  if (!required) {
    return false;
  }
  const granted = scopes.map((scope) => scope.trim()).filter(Boolean);
  if (!isGatewayScope(required)) {
    return granted.includes("*") || granted.includes(required);
  }
  return hasGatewayScope(granted, required);
}
/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => typeof entry === "string");
}
/**
 * @param {string} value
 * @returns {Record<string, unknown> | null}
 */
function decodeBase64UrlJson(value) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return asObject(JSON.parse(decoded));
  } catch {
    return null;
  }
}
/**
 * @param {string} token
 * @param {Extract<GatewayAuthConfig, { mode: "jwt" }>} config
 * @returns {{ ok: true; payload: Record<string, unknown> } | { ok: false; message: string }}
 */
function verifyJwtToken(token, config) {
  const segments = token.split(".");
  if (segments.length !== 3) {
    return { ok: false, message: "JWT must have three segments" };
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return { ok: false, message: "JWT must have three segments" };
  }
  const header = decodeBase64UrlJson(encodedHeader);
  const payload = decodeBase64UrlJson(encodedPayload);
  if (!header || !payload) {
    return { ok: false, message: "JWT header or payload was not valid JSON" };
  }
  if (header.alg !== "HS256") {
    return { ok: false, message: "Unsupported JWT algorithm" };
  }
  const expectedSignature = createHmac("sha256", config.secret).update(`${encodedHeader}.${encodedPayload}`).digest();
  // Reject a non-base64url signature segment before decoding: a constant-time
  // compare over raw bytes below leaks nothing, but a malformed segment must
  // fail cleanly rather than decode to surprising bytes.
  if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
    return { ok: false, message: "JWT signature verification failed" };
  }
  const actualSignature = Buffer.from(encodedSignature, "base64url");
  if (actualSignature.toString("base64url") !== encodedSignature) {
    return { ok: false, message: "JWT signature verification failed" };
  }
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
    return { ok: false, message: "JWT signature verification failed" };
  }
  const now = Math.floor(Date.now() / 1_000);
  const skew = Math.max(0, config.clockSkewSeconds ?? 60);
  const exp = asNumber(payload.exp);
  const nbf = asNumber(payload.nbf);
  const iss = asString(payload.iss);
  const aud = payload.aud;
  if (iss !== config.issuer) {
    return { ok: false, message: "JWT issuer did not match" };
  }
  const audiences = Array.isArray(config.audience) ? config.audience : [config.audience];
  const tokenAudiences = typeof aud === "string" ? [aud] : parseStringArray(aud);
  if (!audiences.some((audience) => tokenAudiences.includes(audience))) {
    return { ok: false, message: "JWT audience did not match" };
  }
  if (typeof exp !== "number") return { ok: false, message: "JWT is missing a valid exp claim" };
  if (now - skew >= exp) return { ok: false, message: "JWT has expired" };
  if (typeof nbf === "number" && now + skew < nbf) {
    return { ok: false, message: "JWT is not active yet" };
  }
  return { ok: true, payload };
}
/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseJwtScopes(value) {
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return parseStringArray(value);
}
/**
 * Normalized approval request stored in an approval row's requestJson.
 * @typedef {{
 *   mode: "gate" | "select" | "rank" | "decision";
 *   title: string | null;
 *   summary: string | null;
 *   options: Array<{ key: string; label: string; summary?: string }>;
 *   allowedScopes: string[];
 *   allowedUsers: string[];
 *   restrictionError: string | null;
 *   autoApprove: Record<string, unknown> | null;
 * }} ApprovalRequestRecord
 */
/**
 * @param {unknown} value
 * @param {"allowedScopes" | "allowedUsers"} field
 * @returns {{ values: string[]; error: string | null }}
 */
function parseApprovalRestriction(value, field) {
  if (value === undefined) {
    return { values: [], error: null };
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    return {
      values: [],
      error: `${field} must be an array of non-empty strings`,
    };
  }
  return { values: value, error: null };
}
/**
 * @param {unknown} value
 * @param {string | null} fallbackTitle
 * @returns {ApprovalRequestRecord}
 */
function parseApprovalRequest(value, fallbackTitle) {
  const record = asObject(value);
  const allowedScopes = parseApprovalRestriction(record?.allowedScopes, "allowedScopes");
  const allowedUsers = parseApprovalRestriction(record?.allowedUsers, "allowedUsers");
  const options = Array.isArray(record?.options)
    ? record.options
        .filter((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
        .map((entry) => ({
          key: asString(entry.key) ?? "",
          label: asString(entry.label) ?? "",
          ...(asString(entry.summary) ? { summary: asString(entry.summary) } : {}),
        }))
        .filter((entry) => entry.key.length > 0 && entry.label.length > 0)
    : [];
  const autoApprove =
    record?.autoApprove && typeof record.autoApprove === "object" && !Array.isArray(record.autoApprove)
      ? record.autoApprove
      : null;
  return {
    mode: record?.mode === "select" || record?.mode === "rank" || record?.mode === "decision" ? record.mode : "gate",
    title: asString(record?.title) ?? fallbackTitle,
    summary: asString(record?.summary) ?? null,
    options,
    allowedScopes: allowedScopes.values,
    allowedUsers: allowedUsers.values,
    restrictionError: allowedScopes.error ?? allowedUsers.error,
    autoApprove,
  };
}
/**
 * @param {ApprovalRequestRecord} request
 * @param {unknown} decision
 */
function validateApprovalDecision(request, decision) {
  if (request.mode === "select") {
    const payload = asObject(decision);
    const selected = asString(payload?.selected);
    if (!selected) {
      return { ok: false, code: "INVALID_REQUEST", message: "select approvals require decision.selected" };
    }
    if (request.options.length > 0 && !request.options.some((option) => option.key === selected)) {
      return { ok: false, code: "INVALID_REQUEST", message: `Unknown selection: ${selected}` };
    }
  }
  if (request.mode === "rank") {
    const payload = asObject(decision);
    const ranked = parseStringArray(payload?.ranked);
    if (ranked.length === 0) {
      return { ok: false, code: "INVALID_REQUEST", message: "rank approvals require decision.ranked" };
    }
    const allowed = new Set(request.options.map((option) => option.key));
    if (allowed.size > 0 && ranked.some((value) => !allowed.has(value))) {
      return { ok: false, code: "INVALID_REQUEST", message: "rank approval included unknown options" };
    }
  }
  return { ok: true };
}
/**
 * @param {string} pattern
 */
function nextCronRunAtMs(pattern) {
  const interval = CronExpressionParser.parse(pattern);
  return interval.next().getTime();
}
/**
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function normalizeCorrelationId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}
/**
 * @param {string | null} [metaJson]
 */
function parseWebhookWaitForEventSnapshot(metaJson) {
  if (!metaJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(metaJson);
    const waitForEvent = asObject(asObject(parsed)?.waitForEvent);
    const signalName = asString(waitForEvent?.signalName)?.trim();
    if (!signalName) {
      return null;
    }
    return {
      signalName,
      correlationId: normalizeCorrelationId(asString(waitForEvent?.correlationId) ?? null),
    };
  } catch {
    return null;
  }
}
/**
 * Absolute fire time (ms since epoch) recorded on a still-waiting timer attempt,
 * or null when the metadata carries no usable timer snapshot. Mirrors the
 * `{ timer: { firesAtMs } }` shape written by the engine's timer bridge.
 * @param {string | null | undefined} metaJson
 * @returns {number | null}
 */
function parseTimerFiresAtMs(metaJson) {
  if (!metaJson) {
    return null;
  }
  try {
    const timer = asObject(asObject(JSON.parse(metaJson))?.timer);
    const firesAtMs = Number(timer?.firesAtMs);
    return Number.isFinite(firesAtMs) ? firesAtMs : null;
  } catch {
    return null;
  }
}
/**
 * Reset time (ms since epoch) a quota-blocked run should auto-resume at, read
 * from the run's `errorJson` (the engine stores `{ resetAtMs }` there when it
 * parks a run as `waiting-quota`). Returns null when the limit carries no known
 * reset time — e.g. credit exhaustion, which needs manual intervention and must
 * NOT be woken on a timer, or it would loop against the same wall.
 * @param {string | null | undefined} errorJson
 * @returns {number | null}
 */
function parseQuotaResetAtMs(errorJson) {
  if (!errorJson) {
    return null;
  }
  try {
    const resetAtMs = Number(asObject(JSON.parse(errorJson))?.resetAtMs);
    return Number.isFinite(resetAtMs) ? resetAtMs : null;
  } catch {
    return null;
  }
}
/**
 * @param {unknown} source
 * @param {string | undefined} path
 * @returns {unknown}
 */
function readPathValue(source, path) {
  if (!path) {
    return source;
  }
  const trimmed = path.trim();
  if (!trimmed) {
    return source;
  }
  let current = source;
  for (const segment of trimmed.split(".").filter((entry) => entry.length > 0)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    const record = asObject(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}
/**
 * @param {Buffer} body
 * @param {string} description
 */
function parseJsonBuffer(body, description) {
  if (body.length === 0) {
    return {};
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new SmithersError("INVALID_INPUT", `${description} must be valid JSON.`, undefined, { cause: error });
  }
}
/**
 * @param {string | null} lengthHeader
 * @param {number} maxBytes
 */
function assertContentLengthWithinBounds(lengthHeader, maxBytes) {
  if (lengthHeader === null) {
    return;
  }
  const normalized = lengthHeader.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new SmithersError("INVALID_INPUT", "Gateway request Content-Length must be a non-negative integer.", {
      contentLength: lengthHeader,
    });
  }
  if (BigInt(normalized) > BigInt(maxBytes)) {
    throw new SmithersError("PayloadTooLarge", `Gateway request payload exceeds ${maxBytes} bytes.`, { maxBytes });
  }
}
/**
 * @param {IncomingMessage} req
 * @param {number} maxBytes
 */
async function readRawBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  const lengthHeader = headerValue(req, "content-length");
  assertContentLengthWithinBounds(lengthHeader, maxBytes);
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new SmithersError("PayloadTooLarge", `Gateway request payload exceeds ${maxBytes} bytes.`, { maxBytes });
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return Buffer.alloc(0);
  }
  return Buffer.concat(chunks);
}
/**
 * @param {IncomingMessage} req
 * @param {number} maxBytes
 */
async function readBody(req, maxBytes) {
  return parseJsonBuffer(await readRawBody(req, maxBytes), "Gateway RPC payload");
}
/**
 * @param {Buffer} rawBody
 * @param {string} secret
 * @param {string} prefix
 */
function computeWebhookSignature(rawBody, secret, prefix) {
  return `${prefix}${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
/**
 * @param {string} expected
 * @param {string | null} provided
 */
function isValidWebhookSignature(expected, provided) {
  if (!provided) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}
/**
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
function normalizeWebhookRunInput(input) {
  const normalized = asObject(input) ?? { payload: input ?? null };
  return validateGatewayRpcInput(normalized);
}
/**
 * @param {string} workflowKey
 */
function webhookTriggerUserId(workflowKey) {
  return `webhook:${workflowKey}`;
}
/**
 * @param {string} workflowKey
 */
function cronWorkflowPath(workflowKey) {
  return `gateway:${workflowKey}`;
}
/**
 * @param {string | null | undefined} workflowPath
 */
function workflowKeyFromCronPath(workflowPath) {
  if (!workflowPath || !workflowPath.startsWith("gateway:")) {
    return null;
  }
  return workflowPath.slice("gateway:".length);
}

/**
 * Derive a discovered-workflow key from a stored run's `workflowPath`: the
 * entry-file basename minus its extension, mirroring how `smithers gateway`
 * keys the workflows it discovers under .smithers/workflows.
 * @param {string | undefined} workflowPath
 * @returns {string | null}
 */
function workflowKeyFromRunPath(workflowPath) {
  if (!workflowPath) {
    return null;
  }
  const base = workflowPath.replaceAll("\\", "/").split("/").pop() ?? "";
  const key = base.replace(/\.(tsx|jsx|mdx|ts|js)$/i, "");
  return key || null;
}
/**
 * Read the workflow key from a conventional workflow UI route. Asset requests
 * use the same first segment, so a direct request for a late-authored bundle
 * can refresh the registry too.
 * @param {string} pathname
 * @returns {string | null}
 */
function workflowKeyFromUiPath(pathname) {
  const match = pathname.match(/^\/workflows\/([^/]+)(?:\/|$)/);
  if (!match) {
    return null;
  }
  try {
    const key = decodeURIComponent(match[1]);
    return key && !key.includes("/") && !key.includes("\\") ? key : null;
  } catch {
    return null;
  }
}
/**
 * @param {ConnectionState} connection
 * @param {string | null} runId
 */
function shouldDeliverEvent(connection, runId) {
  if (!runId) return true;
  if (!connection.subscribedRuns || connection.subscribedRuns.size === 0) {
    return true;
  }
  return connection.subscribedRuns.has(runId);
}
/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number | undefined}
 */
function asOptionalNonNegativeInt(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new SmithersError("INVALID_INPUT", `${field} must be a non-negative integer.`, { field, value });
  }
  return number;
}
const SCORE_COMPARE_MAX_RUNS = 30;
const SCORE_ID_MAX_LENGTH = 256;
const SCORE_COMPARE_MAX_WINDOW = 10_000;
const SCORE_COMPARE_MAX_OFFSET = SCORE_COMPARE_MAX_WINDOW - 1;
const SCORE_COMPARE_DEFAULT_LIMIT = 500;
const SCORE_COMPARE_MAX_LIMIT = 500;
/**
 * Normalize the cross-run score identities once, before any persistence read.
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeScoreRunIds(value) {
  if (!Array.isArray(value)) {
    throw new SmithersError("INVALID_REQUEST", "runIds must be an array of strings");
  }
  if (value.length > SCORE_COMPARE_MAX_RUNS) {
    throw new SmithersError("INVALID_REQUEST", `runIds may contain at most ${SCORE_COMPARE_MAX_RUNS} entries`);
  }
  const seen = new Set();
  const runIds = [];
  for (const valueRunId of value) {
    if (typeof valueRunId !== "string") {
      throw new SmithersError("INVALID_REQUEST", "runIds must contain only strings");
    }
    const runId = valueRunId.trim();
    if (!runId) {
      throw new SmithersError("INVALID_REQUEST", "runIds must not contain blank ids");
    }
    if (runId.length > DB_RUN_ID_MAX_LENGTH) {
      throw new SmithersError(
        "INVALID_REQUEST",
        `runIds must be at most ${DB_RUN_ID_MAX_LENGTH} characters after trimming`,
      );
    }
    if (!seen.has(runId)) {
      seen.add(runId);
      runIds.push(runId);
    }
  }
  return runIds;
}
/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string | undefined}
 */
function optionalScoreFilter(value, field) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new SmithersError("INVALID_REQUEST", `${field} must be a string`);
  }
  return value;
}
/** @param {unknown} value @returns {"live" | "batch" | undefined} */
function optionalScoreSource(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "live" && value !== "batch") {
    throw new SmithersError("INVALID_REQUEST", "source must be live or batch");
  }
  return value;
}
/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} fallback
 * @param {number} minimum
 * @param {number} maximum
 */
function boundedScorePageInteger(value, field, fallback, minimum, maximum) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SmithersError("INVALID_REQUEST", `${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
/**
 * @param {unknown} value
 * @returns {"scoredAtAsc" | "scoredAtDesc"}
 */
function scoreResultOrder(value) {
  if (value === undefined) {
    return "scoredAtAsc";
  }
  if (value !== "scoredAtAsc" && value !== "scoredAtDesc") {
    throw new SmithersError("INVALID_REQUEST", "order must be scoredAtAsc or scoredAtDesc");
  }
  return value;
}
/** @param {unknown} left @param {unknown} right */
function compareAscending(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
/**
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @param {"scoredAtAsc" | "scoredAtDesc"} order
 */
function compareScoreRows(left, right, order) {
  const leftScoredAt = Number(left.scoredAtMs ?? 0);
  const rightScoredAt = Number(right.scoredAtMs ?? 0);
  if (leftScoredAt !== rightScoredAt) {
    return order === "scoredAtAsc" ? leftScoredAt - rightScoredAt : rightScoredAt - leftScoredAt;
  }
  for (const key of ["runId", "nodeId"]) {
    const compared = compareAscending(String(left[key] ?? ""), String(right[key] ?? ""));
    if (compared !== 0) return compared;
  }
  for (const key of ["iteration", "attempt"]) {
    const compared = Number(left[key] ?? 0) - Number(right[key] ?? 0);
    if (compared !== 0) return compared;
  }
  for (const key of ["scorerId", "scoreId"]) {
    const compared = compareAscending(String(left[key] ?? ""), String(right[key] ?? ""));
    if (compared !== 0) return compared;
  }
  return 0;
}
/**
 * Decode one persisted JSON detail column. SQL NULL is an honest JSON null;
 * malformed or non-text persistence is an explicit internal failure.
 * @param {unknown} value
 * @param {string} scoreId
 * @param {string} field
 */
function decodeScoreDetailJson(value, scoreId, field) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SmithersError("Internal", `Persisted score ${scoreId} has non-text ${field} JSON`);
  }
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new SmithersError("Internal", `Persisted score ${scoreId} has malformed ${field} JSON`, undefined, { cause });
  }
}
/**
 * @param {URLSearchParams} searchParams
 * @param {string} name
 * @returns {string | undefined}
 */
function queryString(searchParams, name) {
  const value = searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}
/**
 * @param {URLSearchParams} searchParams
 * @param {string} name
 * @returns {number | undefined}
 */
function queryPositiveInt(searchParams, name) {
  const value = searchParams.get(name);
  return value === null || value === "" ? undefined : asOptionalPositiveInt(value, name);
}
/**
 * @param {URLSearchParams} searchParams
 * @param {string} name
 * @returns {number | undefined}
 */
function queryNonNegativeInt(searchParams, name) {
  const value = searchParams.get(name);
  return asOptionalNonNegativeInt(value, name);
}
/**
 * @param {unknown} value
 * @param {(row: Record<string, unknown>) => Record<string, unknown>} serializer
 */
function serializeRowOrRows(value, serializer) {
  if (Array.isArray(value)) {
    return value.map((row) => serializer(asObject(row) ?? {}));
  }
  if (value && typeof value === "object") {
    return serializer(/** @type {Record<string, unknown>} */ (value));
  }
  return value;
}
/**
 * @param {string} method
 * @param {unknown} payload
 * @returns {unknown}
 */
function serializeGatewayApiPayload(method, payload) {
  switch (method) {
    case "getRun":
    case "listRuns":
    case "launchRun":
    case "resumeRun":
    case "cancelRun":
    case "rewindRun":
      return serializeRowOrRows(payload, serializeRunRow);
    case "streamRunEvents":
      return serializeRowOrRows(payload, serializeRunEventRow);
    case "listWorkflows":
      return serializeRowOrRows(payload, serializeWorkflowRow);
    case "listApprovals":
    case "submitApproval":
      return serializeRowOrRows(payload, serializeApprovalRow);
    case "listDocs":
      return serializeRowOrRows(payload, serializeDocRow);
    case "listPrompts":
      return serializeRowOrRows(payload, serializePromptRow);
    case "listMemoryFacts":
      return serializeRowOrRows(payload, serializeMemoryFactRow);
    case "listScores":
      return serializeRowOrRows(payload, serializeScoreRow);
    case "listScoresForRuns": {
      const response = asObject(payload) ?? {};
      const rows = Array.isArray(response.rows)
        ? response.rows.map((row) => serializeComparisonScoreRow(asObject(row) ?? {}))
        : [];
      return { rows, total: response.total ?? 0 };
    }
    case "getScoreDetail":
      return serializeRowOrRows(payload, serializeScoreDetailRow);
    case "listTickets":
    case "createTicket":
    case "updateTicket":
      return serializeRowOrRows(payload, serializeTicketRow);
    case "cronList":
    case "cronCreate":
      return serializeRowOrRows(payload, serializeCronRow);
    case "listAccounts":
      return serializeRowOrRows(payload, serializeAccountRow);
    case "listUsageReports":
      return payload;
    default:
      return payload;
  }
}
/**
 * Normalize one persisted TokenUsageReported row onto the stable Gateway wire
 * shape. Persisted event payloads are authoritative; the row timestamp only
 * fills the timestampMs field for older payloads that predate it.
 * @param {Record<string, unknown>} row
 * @returns {Record<string, string | number> | null}
 */
function parseRunTokenUsageRow(row) {
  const payloadJson = asString(row.payloadJson);
  if (!payloadJson) {
    return null;
  }
  let payload;
  try {
    payload = asObject(JSON.parse(payloadJson));
  } catch {
    return null;
  }
  if (!payload) {
    return null;
  }
  return {
    nodeId: asString(payload.nodeId) ?? "unknown",
    iteration: asNumber(payload.iteration) ?? 0,
    attempt: asNumber(payload.attempt) ?? 0,
    model: asString(payload.model) ?? "unknown",
    agent: asString(payload.agent) ?? "unknown",
    inputTokens: asNumber(payload.inputTokens) ?? 0,
    outputTokens: asNumber(payload.outputTokens) ?? 0,
    cacheReadTokens: asNumber(payload.cacheReadTokens) ?? 0,
    cacheWriteTokens: asNumber(payload.cacheWriteTokens) ?? 0,
    reasoningTokens: asNumber(payload.reasoningTokens) ?? 0,
    timestampMs: asNumber(payload.timestampMs) ?? asNumber(row.timestampMs) ?? 0,
  };
}
/**
 * Fails fast at dispatch time if a route names a collection the API layer
 * does not export (API_COLLECTION_NAME_SET is the source of truth).
 * @param {string[]} names
 * @returns {string[]}
 */
function apiCollections(...names) {
  for (const name of names) {
    if (!API_COLLECTION_NAME_SET.has(name)) {
      throw new Error(`Unknown Gateway API collection name: ${name}`);
    }
  }
  return names;
}
/**
 * @param {string} method
 * @returns {string[]}
 */
function apiMutationCollections(method) {
  switch (method) {
    case "launchRun":
      return apiCollections("runs", "run_events");
    case "resumeRun":
    case "cancelRun":
    case "rewindRun":
    case "oneshotMonitorAttach":
    case "oneshotMonitorSteer":
    case "oneshotMonitorRestart":
      return apiCollections("runs", "run_events", "nodes", "node_outputs");
    case "submitApproval":
      return apiCollections("approvals", "runs", "run_events", "nodes");
    case "submitSignal":
      return apiCollections("runs", "run_events", "nodes");
    case "cronCreate":
    case "cronDelete":
    case "cronRun":
      return apiCollections("crons", "runs", "run_events");
    case "createTicket":
    case "updateTicket":
    case "deleteTicket":
      return apiCollections("tickets", "docs");
    default:
      return apiCollections("runs");
  }
}
/**
 * @param {string} event
 * @returns {string[]}
 */
function apiCollectionsForGatewayEvent(event) {
  if (event.startsWith("approval.")) {
    return apiCollections("approvals", "runs", "run_events", "nodes");
  }
  if (event.startsWith("node.") || event.startsWith("task.") || event.startsWith("agent.")) {
    return event === "task.output"
      ? apiCollections("run_events", "nodes", "node_outputs")
      : apiCollections("run_events", "nodes");
  }
  if (event.startsWith("run.")) {
    return apiCollections("runs", "run_events", "nodes");
  }
  if (event.startsWith("cron.")) {
    return apiCollections("crons", "runs");
  }
  return apiCollections("runs", "run_events");
}
/**
 * @param {string} event
 * @param {unknown} data
 * @param {number} [id]
 * @returns {string}
 */
function formatSseEvent(event, data, id) {
  const lines = [];
  if (id !== undefined) {
    lines.push(`id: ${id}`);
  }
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}
/**
 * @param {number} seq
 * @returns {string}
 */
function formatSseHeartbeat(seq) {
  return `: heartbeat\n${formatSseEvent("heartbeat", { seq })}`;
}
/**
 * @param {unknown} value
 * @returns {number}
 */
function byteLengthOfJson(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
/**
 * @param {Map<string, number>} counts
 * @param {string} key
 */
function decrementSubscriberCount(counts, key) {
  const next = (counts.get(key) ?? 0) - 1;
  if (next > 0) {
    counts.set(key, next);
  } else {
    counts.delete(key);
  }
}
/**
 * Read the persisted terminal outcome instead of reconstructing it from nodes.
 *
 * @param {Pick<SmithersDb, "listEventsByType">} adapter
 * @param {string} runId
 * @param {string} status
 * @returns {Promise<{ failedChildren?: number, failedChildKeys?: string[] }>}
 */
async function readPersistedDegradedOutcome(adapter, runId, status) {
  if (status !== "finished") {
    return {};
  }
  const events = await adapter.listEventsByType(runId, "RunFinished");
  const payloadJson = events.at(-1)?.payloadJson;
  if (typeof payloadJson !== "string") {
    return {};
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return {};
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.failedChildren !== "number" ||
    !Number.isFinite(payload.failedChildren) ||
    payload.failedChildren <= 0
  ) {
    return {};
  }
  return {
    failedChildren: payload.failedChildren,
    failedChildKeys: Array.isArray(payload.failedChildKeys)
      ? payload.failedChildKeys.filter((key) => typeof key === "string")
      : [],
  };
}
export class Gateway {
  protocol;
  features;
  heartbeatMs;
  maxBodyBytes;
  maxPayload;
  maxConnections;
  maxPreAuthConnections;
  eventWindowSize;
  outOfProcessEventBridge;
  outOfProcessEventBridgePollMs;
  headersTimeout;
  requestTimeout;
  authDeadlineMs;
  auth;
  ui;
  operatorUi;
  uiApp;
  defaults;
  routes;
  /**
   * Absolute workspace root for disk-backed registry reads (e.g. the
   * `listPrompts` RPC, which walks `<workspaceRoot>/.smithers/prompts/`).
   * `null` ⇒ fall back to `process.cwd()`. Set from `options.workspaceRoot`.
   * @type {string | null}
   */
  workspaceRoot = null;
  browser;
  workflows = new Map();
  /**
   * Host-owned workspace workflow rescan. It is intentionally invoked only
   * after a concrete key misses the in-memory registry.
   * @type {((workflowKey: string) => void | Promise<void>) | null}
   */
  workflowRegistryRefresh = null;
  workflowRegistryStatus = null;
  workflowRegistryReady = null;
  /** @type {Map<string, Promise<void>>} */
  workflowRegistryRefreshes = new Map();
  /** @type {{ reports: UsageReport[], cachedAtMs: number } | null} */
  usageReportsCache = null;
  /** @type {Promise<UsageReport[]> | null} */
  usageReportsInFlight = null;
  connections = new Set();
  /**
   * Subset of `connections` still awaiting a successful `connect` RPC.
   * Pre-auth sockets hold a slot in this bounded pool instead of consuming
   * authenticated `maxConnections` capacity; a successful `connect` promotes
   * them out and close / failed authentication releases the slot (#1008).
   * @type {Set<Record<string, unknown>>}
   */
  preAuthConnections = new Set();
  runRegistry = new Map();
  activeRuns = new Map();
  inflightRuns = new Map();
  /**
   * Resume attempts keyed by run id.
   * @type {Map<string, Promise<void>>}
   */
  inflightResumes = new Map();
  devtoolsSubscribers = new Map();
  runEventWindows = new Map();
  runEventSubscriberCounts = new Map();
  runEventSubscriberTotal = 0;
  /** Active streamRunEvents subscriber count per user identity (userId ?? tokenId ?? role). @type {Map<string, number>} */
  runEventSubscribersByUser = new Map();
  // Instance copies let tests exercise every cap without opening hundreds of
  // streams. Production uses the constants above.
  runEventStreamMaxSubscribers = RUN_EVENT_STREAM_MAX_SUBSCRIBERS;
  runEventStreamMaxSubscribersPerUser = RUN_EVENT_STREAM_MAX_SUBSCRIBERS_PER_USER;
  runEventStreamMaxSubscribersPerConnection = RUN_EVENT_STREAM_MAX_SUBSCRIBERS_PER_CONNECTION;
  runEventStreamMaxSubscribersPerRun = RUN_EVENT_STREAM_MAX_SUBSCRIBERS_PER_RUN;
  terminalRunEventWindows = new Map();
  terminalRunEventWindowTimers = new Map();
  apiStreamSeq = 0;
  apiStreamFrames = [];
  apiStreamFrameBytes = 0;
  apiStreamSubscribers = new Set();
  apiStreamPendingCollections = new Set();
  apiStreamPendingResolvers = [];
  apiStreamFlushTimer = null;
  // Instance copies of the SSE caps so tests can shrink a limit without
  // opening hundreds of real sockets; production always runs the constants.
  apiStreamMaxSubscribers = API_STREAM_MAX_SUBSCRIBERS;
  apiStreamMaxSubscribersPerUser = API_STREAM_MAX_SUBSCRIBERS_PER_USER;
  apiStreamMaxSubscribersPerConnection = API_STREAM_MAX_SUBSCRIBERS_PER_CONNECTION;
  /** Active SSE subscriber count per user identity (userId ?? tokenId ?? role). @type {Map<string, number>} */
  apiStreamSubscribersByUser = new Map();
  /** Active SSE subscriber count per declared connection id (`x-request-id`). @type {Map<string, number>} */
  apiStreamSubscribersByConnection = new Map();
  /** One shared heartbeat interval for every SSE subscriber (never one per subscriber). */
  apiStreamHeartbeatTimer = null;
  /** Absolute active subscriber count per runId (gauge source of truth). */
  devtoolsSubscriberCounts = new Map();
  /** Flagged subscriber IDs that should force a snapshot on their next emit. */
  devtoolsInvalidateFlags = new Set();
  uiAssetCache = new Map();
  /** @type {GatewayExtensions} */
  extensions = new GatewayExtensions();
  /**
   * Per-connection extension stream subscriptions. Lets us tear them down on
   * close and fence stale subscriber callbacks behind a per-stream
   * AbortController, so a slow extension handler emitting after disconnect
   * never reaches a dead socket.
   * @type {WeakMap<GatewayRequestContext, Map<string, {
   *   namespace: string;
   *   key: string;
   *   abort: AbortController;
   *   cleanup: () => Promise<void>;
   * }>>}
   */
  extensionStreamSubscriptions = new WeakMap();
  /**
   * Per-connection in-flight resource/action handler aborts. A long-running
   * extension RPC (LLM call, remote API hit) must NOT keep running after the
   * client cancels or disconnects — `cleanupExtensionPendingHandlers` fires
   * the abort signal on connection close so handlers that observe `ctx.signal`
   * can stop work immediately instead of completing into a dead socket.
   * @type {WeakMap<GatewayRequestContext, Set<AbortController>>}
   */
  extensionPendingHandlers = new WeakMap();
  server = null;
  wsServer = null;
  schedulerTimer = null;
  outOfProcessEventBridgeTimer = null;
  outOfProcessEventBridgeStopped = true;
  outOfProcessEventBridgeLastFedSeq = new Map();
  outOfProcessEventBridgeDrainedRuns = new Set();
  stateVersion = 0;
  startedAtMs = nowMs();
  // Idle spin-down (spec decision 14). When idleTimeoutMs > 0 and an onIdle
  // handler is set, the daemon fires onIdle once it has been idle — no clients,
  // no in-flight runs, no registered schedules — for idleTimeoutMs. The CLI
  // wires this for AUTOSTARTED daemons only; an explicit `smithers gateway`
  // leaves idleTimeoutMs at 0 and never idle-exits.
  idleTimeoutMs = 0;
  /** @type {(() => void | Promise<void>) | null} */
  onIdle = null;
  lastActivityMs = nowMs();
  /** @type {ReturnType<typeof setInterval> | null} */
  idleTimer = null;
  idleFired = false;
  hasActiveCrons = false;
  hasPendingTimers = false;
  cronSweepInFlight = false;
  /**
   * @param {GatewayOptions} [options]
   */
  constructor(options = {}) {
    this.protocol = options.protocol ?? DEFAULT_PROTOCOL;
    this.features = [...(options.features ?? ["streaming", "runs"])];
    this.idleTimeoutMs =
      options.idleTimeoutMs === undefined ? 0 : Math.max(0, Math.floor(Number(options.idleTimeoutMs) || 0));
    this.onIdle = typeof options.onIdle === "function" ? options.onIdle : null;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.maxBodyBytes =
      options.maxBodyBytes === undefined
        ? DEFAULT_MAX_BODY_BYTES
        : Math.floor(assertPositiveFiniteInteger("maxBodyBytes", Number(options.maxBodyBytes)));
    this.maxPayload =
      options.maxPayload === undefined
        ? GATEWAY_RPC_MAX_PAYLOAD_BYTES
        : Math.floor(assertPositiveFiniteInteger("maxPayload", Number(options.maxPayload)));
    this.maxConnections =
      options.maxConnections === undefined
        ? DEFAULT_MAX_CONNECTIONS
        : Math.floor(assertPositiveFiniteInteger("maxConnections", Number(options.maxConnections)));
    this.maxPreAuthConnections =
      options.maxPreAuthConnections === undefined
        ? DEFAULT_MAX_PRE_AUTH_CONNECTIONS
        : Math.floor(assertPositiveFiniteInteger("maxPreAuthConnections", Number(options.maxPreAuthConnections)));
    this.eventWindowSize =
      options.eventWindowSize === undefined
        ? GATEWAY_EVENT_WINDOW_DEFAULT
        : Math.floor(assertPositiveFiniteInteger("eventWindowSize", Number(options.eventWindowSize)));
    this.outOfProcessEventBridge = options.outOfProcessEventBridge ?? options.defaults?.outOfProcessEventBridge ?? true;
    this.outOfProcessEventBridgePollMs =
      options.outOfProcessEventBridgePollMs === undefined &&
      options.defaults?.outOfProcessEventBridgePollMs === undefined
        ? DEFAULT_OUT_OF_PROCESS_EVENT_BRIDGE_POLL_MS
        : Math.floor(
            assertPositiveFiniteInteger(
              "outOfProcessEventBridgePollMs",
              Number(options.outOfProcessEventBridgePollMs ?? options.defaults?.outOfProcessEventBridgePollMs),
            ),
          );
    this.headersTimeout =
      options.headersTimeout === undefined
        ? DEFAULT_HEADERS_TIMEOUT
        : Math.floor(assertPositiveFiniteInteger("headersTimeout", Number(options.headersTimeout)));
    this.requestTimeout =
      options.requestTimeout === undefined
        ? DEFAULT_REQUEST_TIMEOUT
        : Math.floor(assertPositiveFiniteInteger("requestTimeout", Number(options.requestTimeout)));
    this.authDeadlineMs =
      options.authDeadlineMs === undefined
        ? DEFAULT_AUTH_DEADLINE_MS
        : Math.floor(assertPositiveFiniteInteger("authDeadlineMs", Number(options.authDeadlineMs)));
    this.auth = options.auth;
    // A deliberate unauthenticated remote bind (`smithers gateway --insecure`)
    // trusts any Host, matching serve.js. Without this, --insecure passes the
    // CLI bind guard but isHostAllowed still 403s every non-loopback request.
    this.trustAnyHost = options.insecure === true;
    this.routes = typeof options.routes === "function" ? options.routes : null;
    // Host-injected "what happened" narrator (the smithers CLI wires a cheap
    // agent here). Null means the whatHappened RPC answers with the
    // deterministic fact summary only — the Gateway itself never calls an LLM.
    this.whatHappenedNarrator = typeof options.whatHappened === "function" ? options.whatHappened : null;
    /** @type {Map<string, { payload: Record<string, unknown> }>} */
    this.whatHappenedCache = new Map();
    // Host-injected PTY hijack launcher (the smithers CLI wires `smithers
    // hijack <runId> [--target <nodeId>]` here). Null disables the
    // /v1/pty/hijack websocket channel — the Gateway itself never guesses
    // how to resume an agent CLI session.
    this.hijackPty = typeof options.hijackPty === "function" ? options.hijackPty : null;
    this.oneshotMonitor =
      options.oneshotMonitor &&
      typeof options.oneshotMonitor.attach === "function" &&
      typeof options.oneshotMonitor.steer === "function" &&
      typeof options.oneshotMonitor.restart === "function"
        ? options.oneshotMonitor
        : null;
    /** @type {Set<{ dispose: () => void }>} */
    this.ptySessions = new Set();
    this.ui = resolveGatewayUiConfig(options.ui, "/");
    this.operatorUi = resolveDefaultOperatorUiConfig(options.operatorUi);
    this.uiApp = createGatewayUiApp({
      resolveMatch: (pathname) => this.resolveUiMatch(pathname),
      renderIndex: (match) => this.renderUiIndex(match),
      renderAsset: (match) => this.renderUiAsset(match),
    });
    this.defaults = options.defaults;
    // Resolve the workspace root to an absolute path once at construction so
    // disk-backed registry reads (e.g. `listPromptsFromDisk`) are independent
    // of `process.cwd()` at call time. `null` keeps the cwd-relative default
    // for the common case where the gateway boots from the workspace root.
    this.workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : null;
    this.workflowRegistryRefresh =
      typeof options.workflowRegistryRefresh === "function" ? options.workflowRegistryRefresh : null;
    this.workflowRegistryStatus =
      typeof options.workflowRegistryStatus === "function" ? options.workflowRegistryStatus : null;
    this.workflowRegistryReady =
      typeof options.workflowRegistryReady === "function" ? options.workflowRegistryReady : null;
    this.identity = options.identity ?? null;
    this.browser = options.browser ?? createBrowserSessionRegistry();
    this.browser.subscribe("activity", (payload) => this.broadcastEvent("browser.activity", payload));
    this.browser.subscribe("frame", (payload) => this.broadcastEvent("browser.frame", payload));
  }
  /**
   * Identity block advertised on `GET /health`, the `health` RPC, and the WS
   * hello. Lets a client verify it reached the gateway for the workspace it
   * resolved locally instead of trusting whichever process owns the port.
   */
  buildIdentity() {
    return {
      workspaceRoot: this.workspaceRoot,
      backend: this.identity?.backend ?? null,
      version: this.identity?.version ?? null,
      pid: process.pid,
      startedAtMs: this.startedAtMs,
    };
  }
  workflowRegistryProgress() {
    const status = this.workflowRegistryStatus?.() ?? {};
    const total = Math.max(0, Math.floor(Number(status.workflowsTotal) || 0));
    const loaded = Math.min(total, Math.max(0, Math.floor(Number(status.workflowsLoaded) || 0)));
    return { workflowsLoaded: loaded, workflowsTotal: total };
  }
  /** Wait for a host-owned registry load before returning aggregate data. */
  async awaitWorkflowRegistryReady() {
    if (!this.workflowRegistryReady) {
      return;
    }
    const { workflowsLoaded, workflowsTotal } = this.workflowRegistryProgress();
    if (workflowsLoaded >= workflowsTotal) {
      return;
    }
    await this.workflowRegistryReady();
  }
  /**
   * Give the host one chance to register an unknown workflow. Concurrent
   * requests for the same key share a single rescan, and loader failures are
   * warnings rather than request/server failures.
   * @param {string} workflowKey
   * @returns {Promise<boolean>}
   */
  async refreshWorkflowRegistryOnMiss(workflowKey) {
    if (this.workflows.has(workflowKey)) {
      return true;
    }
    if (!this.workflowRegistryRefresh) {
      return false;
    }
    let refresh = this.workflowRegistryRefreshes.get(workflowKey);
    if (!refresh) {
      refresh = Promise.resolve()
        .then(() => this.workflowRegistryRefresh?.(workflowKey))
        .catch((error) => {
          emitGatewayLog(
            "warning",
            "workflow registry refresh failed",
            {
              workflow: workflowKey,
              ...gatewayErrorAnnotations(error),
            },
            "gateway:workflow-registry-refresh",
          );
        })
        .finally(() => {
          this.workflowRegistryRefreshes.delete(workflowKey);
        });
      this.workflowRegistryRefreshes.set(workflowKey, refresh);
    }
    await refresh;
    return this.workflows.has(workflowKey);
  }
  /**
   * A workflow's UI: the one it declared, or — by convention — a sibling
   * `ui/<key>.tsx` next to its entry file's `workflows/` directory. The
   * convention is resolved on every call (a cheap existsSync) so a UI file
   * created while the gateway is running becomes servable immediately, with
   * no workflow edit (which would break parked runs' resume hashes) and no
   * gateway restart.
   *
   * @param {string} key
   * @param {RegisteredWorkflow} entry
   * @returns {GatewayUiConfig | null}
   */
  resolvedUiFor(key, entry) {
    if (entry.ui) {
      return entry.ui;
    }
    if (!entry.entryFile) {
      return null;
    }
    const conventionEntry = join(dirname(entry.entryFile), "..", "ui", `${key}.tsx`);
    if (!existsSync(conventionEntry)) {
      return null;
    }
    const fallbackPath = `/workflows/${encodeURIComponent(key)}`;
    return {
      entry: conventionEntry,
      path: normalizeUiMountPath(undefined, fallbackPath),
      ...(entry.workflow.readableName ? { title: entry.workflow.readableName } : {}),
      props: {},
    };
  }
  /**
   * @returns {GatewayUiMount[]}
   */
  getUiMounts() {
    const mounts = [];
    if (this.ui) {
      mounts.push({
        kind: this.ui.builtin === "operator" ? "operator" : "gateway",
        workflowKey: null,
        config: this.ui,
      });
    }
    if (this.operatorUi && (!this.ui || this.ui.path !== this.operatorUi.path)) {
      mounts.push({ kind: "operator", workflowKey: null, config: this.operatorUi });
    }
    for (const [workflowKey, entry] of this.workflows.entries()) {
      const ui = this.resolvedUiFor(workflowKey, entry);
      if (ui) {
        mounts.push({ kind: "workflow", workflowKey, config: ui });
      }
    }
    return mounts.sort((left, right) => right.config.path.length - left.config.path.length);
  }
  /**
   * Where to send a request for the conventional `/workflows/<key>` route when
   * the workflow mounts its UI somewhere else (a `<UI path="…">` declaration).
   * The conventional route is the only one clients can construct without
   * loading the module, so it is also the route that triggers a lazy
   * registration — a workflow whose module loads AFTER listen() would
   * otherwise register, mount its UI at the declared path, and still 404 the
   * request that loaded it (#1362).
   *
   * @param {string} workflowKey
   * @param {URL} url
   * @returns {string | null}
   */
  workflowUiMountRedirect(workflowKey, url) {
    const conventionalPath = `/workflows/${encodeURIComponent(workflowKey)}`;
    // Only the mount root redirects: asset paths belong to the real mount.
    if (url.pathname !== conventionalPath && url.pathname !== `${conventionalPath}/`) {
      return null;
    }
    const entry = this.workflows.get(workflowKey);
    if (!entry) {
      return null;
    }
    const ui = this.resolvedUiFor(workflowKey, entry);
    if (!ui || ui.path === url.pathname) {
      return null;
    }
    return `${ui.path}${url.search}`;
  }
  /**
   * @param {string} pathname
   * @returns {GatewayUiMount | null}
   */
  findUiMount(pathname) {
    for (const mount of this.getUiMounts()) {
      const mountPath = mount.config.path;
      if (mountPath === "/" || pathname === mountPath || pathname.startsWith(`${mountPath}/`)) {
        return mount;
      }
    }
    return null;
  }
  /**
   * @param {string} pathname
   */
  resolveUiMatch(pathname) {
    const mount = this.findUiMount(pathname);
    if (!mount) {
      return null;
    }
    const assetBase = joinUiPath(mount.config.path, `${GATEWAY_UI_ASSET_PREFIX}/`);
    const assetPath = pathname.startsWith(assetBase) ? pathname.slice(assetBase.length) : null;
    return {
      pathname,
      mountPath: mount.config.path,
      assetPath,
      config: mount,
    };
  }
  /**
   * @param {GatewayUiMount} mount
   */
  uiBootConfig(mount) {
    return {
      apiVersion: SMITHERS_API_VERSION,
      kind: mount.kind,
      workflowKey: mount.workflowKey,
      mountPath: mount.config.path,
      rpcPath: "/v1/rpc",
      wsPath: "/",
      assetBasePath: joinUiPath(mount.config.path, `${GATEWAY_UI_ASSET_PREFIX}/`),
      props: mount.config.props ?? {},
    };
  }
  /**
   * @param {{ config: GatewayUiMount }} match
   */
  renderUiIndex(match) {
    const mount = match.config;
    const title = mount.config.title ?? (mount.workflowKey ? `${mount.workflowKey} | Smithers` : "Smithers");
    const boot = this.uiBootConfig(mount);
    const assetSrc = joinUiPath(mount.config.path, `${GATEWAY_UI_ASSET_PREFIX}/client.js`);
    // The style-guide token block ships in the host page itself so the
    // document is themed (light AND dark, `color-scheme` included) before —
    // and independently of — the client bundle: no white flash for dark
    // users, and custom UIs inherit the tokens even if they never render
    // `WorkflowUiStyles`. The bootstrap script honors `?theme=dark|light`
    // by stamping `data-theme` on <html> pre-paint.
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <script>${GATEWAY_UI_THEME_BOOTSTRAP_SCRIPT}</script>
    <style>${workflowUiThemeCss}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>globalThis.__SMITHERS_GATEWAY_UI__=${safeJsonScript(boot)};</script>
    <script type="module" src="${escapeHtml(assetSrc)}"></script>
  </body>
</html>`;
  }
  /**
   * @param {{ config: GatewayUiMount; assetPath: string | null }} match
   */
  async renderUiAsset(match) {
    if (match.assetPath !== "client.js") {
      return null;
    }
    if (match.config.config.builtin === "operator") {
      return {
        body: renderDefaultConsoleClient(),
        contentType: "text/javascript; charset=utf-8",
      };
    }
    const body = await bundleGatewayUiEntry(match.config.config, this.uiAssetCache);
    return {
      body,
      contentType: "text/javascript; charset=utf-8",
    };
  }
  /**
   * Browser session handoff: `GET /v1/auth/session?token=<bearer>&next=<path>`
   * exchanges a valid bearer for an HttpOnly session cookie and lands the
   * browser on `next` via an HTML `location.replace` (not a 30x), so the
   * token never stays in the address bar or browser history. `next` is
   * constrained to a same-origin absolute path — this must never become an
   * open redirect. With no auth configured there is nothing to exchange and
   * the browser goes straight to `next`.
   *
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  async handleAuthSession(req, res) {
    const host = headerValue(req, "host") ?? "127.0.0.1";
    const url = new URL(`http://${host}${req.url ?? "/"}`);
    const rawNext = url.searchParams.get("next") ?? "/";
    // `next` must resolve to a same-origin PATH and nothing else. A leading
    // `//` OR `/\` (browsers treat backslash as a path separator for special
    // schemes, so `/\evil.tld` resolves to `http://evil.tld`) is an authority
    // form, i.e. an open redirect. Resolve against a throwaway origin and keep
    // it only if the origin did not change; fall back to "/" otherwise.
    const next = sameOriginNextPath(rawNext);
    if (gatewayAuthMode(this.auth) === "none") {
      sendText(res, 200, renderSessionHandoffPage(next), "text/html; charset=utf-8");
      return;
    }
    // `?token=` is the browser handoff, but a re-navigation (or a curl with a
    // header) may carry the bearer the normal way — fall back to it so an
    // already-authenticated client refreshes its cookie instead of 401-ing.
    const token = url.searchParams.get("token") ?? bearerTokenFromHeaders(req);
    const authResult = await this.authenticateRequest(req, token);
    if (authResult.ok === false) {
      sendJson(
        res,
        statusForRpcError(authResult.code),
        responseError(randomUUID(), authResult.code, authResult.message, authResult.details),
      );
      return;
    }
    // Header-authenticated modes (trusted-proxy, mTLS) carry no token to store;
    // writing an empty/"null" cookie would only poison later requests.
    if (token) {
      res.setHeader(
        "set-cookie",
        `${GATEWAY_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${
          isSecureRequest(req) ? "; Secure" : ""
        }`,
      );
    }
    sendText(res, 200, renderSessionHandoffPage(next), "text/html; charset=utf-8");
  }
  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  async handleUiHttp(req, res) {
    if ((req.method ?? "GET") !== "GET" && (req.method ?? "GET") !== "HEAD") {
      return false;
    }
    const host = headerValue(req, "host") ?? "127.0.0.1";
    const url = new URL(`http://${host}${req.url ?? "/"}`);
    const browserViewer = url.pathname.match(/^\/browser\/([^/]+)\/viewer$/);
    if (browserViewer) {
      const uiAuthFailure = await authorizeGatewayUiRequest({
        match: { config: { kind: "browser", config: {} } },
        authMode: gatewayAuthMode(this.auth),
        token: bearerTokenFromHeaders(req),
        authenticate: (token) => this.authenticateRequest(req, token),
      });
      if (uiAuthFailure) {
        sendJson(
          res,
          statusForRpcError(uiAuthFailure.code),
          responseError(randomUUID(), uiAuthFailure.code, uiAuthFailure.message, uiAuthFailure.details),
        );
        return true;
      }
      try {
        this.browser.get(decodeURIComponent(browserViewer[1]));
      } catch {
        sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
        return true;
      }
      sendText(
        res,
        200,
        renderBrowserViewer(decodeURIComponent(browserViewer[1]), url.searchParams),
        "text/html; charset=utf-8",
      );
      return true;
    }
    const requestedWorkflowKey = workflowKeyFromUiPath(url.pathname);
    if (requestedWorkflowKey && !this.workflows.has(requestedWorkflowKey)) {
      await this.refreshWorkflowRegistryOnMiss(requestedWorkflowKey);
    }
    const uiMatch = this.resolveUiMatch(url.pathname);
    if (!uiMatch) {
      const declaredMount = requestedWorkflowKey ? this.workflowUiMountRedirect(requestedWorkflowKey, url) : null;
      if (declaredMount) {
        sendRedirect(res, declaredMount);
        return true;
      }
      return false;
    }
    const uiAuthFailure = await authorizeGatewayUiRequest({
      match: uiMatch,
      authMode: gatewayAuthMode(this.auth),
      token: bearerTokenFromHeaders(req),
      authenticate: (token) => this.authenticateRequest(req, token),
    });
    if (uiAuthFailure) {
      sendJson(
        res,
        statusForRpcError(uiAuthFailure.code),
        responseError(randomUUID(), uiAuthFailure.code, uiAuthFailure.message, uiAuthFailure.details),
      );
      return true;
    }
    const request = new Request(`http://${host}${req.url ?? "/"}`, {
      method: "GET",
      headers: nodeHeadersToFetchHeaders(req.headers),
    });
    const response = await this.uiApp.fetch(request);
    if (response.status === 404 && response.headers.get("x-smithers-ui-miss") === "1") {
      return false;
    }
    await writeFetchResponse(res, response, (req.method ?? "GET") === "HEAD");
    return true;
  }
  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  handleRootRequest(req, res) {
    const mounts = this.getUiMounts();
    const operatorMount = mounts.find((mount) => mount.kind === "operator");
    if (operatorMount) {
      return sendRedirect(res, operatorMount.config.path);
    }
    const uiMounts = mounts.filter((mount) => mount.config.path !== "/");
    const links = [
      { href: "/health", label: "Health" },
      { href: "/metrics", label: "Metrics" },
      { href: "/workflows", label: "Workflows" },
      ...uiMounts.map((mount) => ({
        href: mount.config.path,
        label: mount.config.title ?? `${mount.kind} UI`,
      })),
    ];
    const uiMessage = uiMounts.length > 0 ? "Workflow UIs are mounted below." : "No UI mounted at this gateway root.";
    const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Smithers Gateway</title>
    <script>${GATEWAY_UI_THEME_BOOTSTRAP_SCRIPT}</script>
    <style>${workflowUiThemeCss}
main { padding: 24px; display: grid; gap: 12px; }
a { color: var(--brand); }</style>
  </head>
  <body>
    <main>
      <h1>Smithers Gateway</h1>
      <p>${escapeHtml(uiMessage)}</p>
      <nav aria-label="Gateway links">
        <ul>
          ${links.map((link) => `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></li>`).join("\n          ")}
        </ul>
      </nav>
    </main>
  </body>
</html>
`;
    return sendText(res, 200, body, "text/html; charset=utf-8");
  }
  /**
   * @param {string} key
   * @param {RegisteredWorkflow} entry
   */
  workflowSummary(key, entry) {
    const ui = this.resolvedUiFor(key, entry);
    return {
      key,
      ...(entry.workflow.readableName ? { readableName: entry.workflow.readableName } : {}),
      ...(entry.workflow.description ? { description: entry.workflow.description } : {}),
      hasUi: Boolean(ui),
      uiPath: ui?.path ?? null,
      system: Boolean(entry.system),
    };
  }
  /**
   * @param {boolean | undefined} hasUi
   * @param {boolean | undefined} [includeSystem] System (internal plumbing) workflows are hidden unless true.
   */
  listWorkflowSummaries(hasUi, includeSystem) {
    const rows = [];
    for (const [key, entry] of this.workflows.entries()) {
      const summary = this.workflowSummary(key, entry);
      if (hasUi !== undefined && summary.hasUi !== hasUi) {
        continue;
      }
      if (summary.system && includeSystem !== true) {
        continue;
      }
      rows.push(summary);
    }
    rows.sort((left, right) => left.key.localeCompare(right.key));
    return rows;
  }
  authModeLabel() {
    return gatewayAuthMode(this.auth);
  }
  /**
   * @param {string} [runId]
   * @returns {number}
   */
  getDevToolsSubscriberCount(runId) {
    if (!runId) {
      return this.devtoolsSubscribers.size;
    }
    let count = 0;
    for (const subscriber of this.devtoolsSubscribers.values()) {
      if (subscriber.runId === runId) {
        count += 1;
      }
    }
    return count;
  }
  /**
   * Record a single subscribe attempt outcome. Centralised so that invalid
   * runId, missing run, SeqOutOfRange, etc. still update
   * `smithers_devtools_subscribe_total{result="error"}`.
   *
   * @param {"ok" | "error"} result
   */
  recordDevToolsSubscribeAttempt(result) {
    emitGatewayEffect(Metric.update(taggedMetric(devtoolsSubscribeTotal, { result }), 1));
  }
  /**
   * Push the absolute active-subscriber count to the Prometheus gauge. The
   * `runId` is hashed for bounded cardinality.
   *
   * @param {string} runId
   */
  publishDevToolsActiveSubscribersGauge(runId) {
    const runMetricLabel = devtoolsRunMetricTag(runId);
    const value = this.devtoolsSubscriberCounts.get(runId) ?? 0;
    emitGatewayEffect(Metric.update(taggedMetric(devtoolsActiveSubscribers, { runId: runMetricLabel }), value));
  }
  /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {string} runId
   * @returns {AbortController}
   */
  registerDevToolsSubscriber(connection, streamId, runId) {
    const abort = new AbortController();
    if (!connection.devtoolsStreams) {
      connection.devtoolsStreams = new Map();
    }
    connection.devtoolsStreams.set(streamId, {
      runId,
      abort,
    });
    this.devtoolsSubscribers.set(streamId, {
      runId,
      connectionId: connection.connectionId,
      abort,
      startedAtMs: Date.now(),
    });
    const previous = this.devtoolsSubscriberCounts.get(runId) ?? 0;
    this.devtoolsSubscriberCounts.set(runId, previous + 1);
    this.recordDevToolsSubscribeAttempt("ok");
    this.publishDevToolsActiveSubscribersGauge(runId);
    return abort;
  }
  /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {Record<string, unknown>} [details]
   */
  unregisterDevToolsSubscriber(connection, streamId, details = {}) {
    const stream = connection.devtoolsStreams?.get(streamId);
    if (stream) {
      stream.abort.abort();
      connection.devtoolsStreams?.delete(streamId);
    }
    const subscriber = this.devtoolsSubscribers.get(streamId);
    if (!subscriber) {
      return;
    }
    this.devtoolsSubscribers.delete(streamId);
    this.devtoolsInvalidateFlags.delete(streamId);
    const previous = this.devtoolsSubscriberCounts.get(subscriber.runId) ?? 0;
    const nextCount = Math.max(0, previous - 1);
    if (nextCount === 0) {
      this.devtoolsSubscriberCounts.delete(subscriber.runId);
    } else {
      this.devtoolsSubscriberCounts.set(subscriber.runId, nextCount);
    }
    this.publishDevToolsActiveSubscribersGauge(subscriber.runId);
    emitGatewayLog(
      "info",
      "devtools stream unsubscribed",
      {
        runId: subscriber.runId,
        streamId,
        durationMs: Date.now() - subscriber.startedAtMs,
        ...details,
      },
      "gateway:devtools",
    );
  }
  /**
   * Flag every active subscriber for `runId` to rebaseline on its next emit.
   * Called when the gateway observes `TimeTravelJumped` for that run.
   *
   * @param {string} runId
   */
  invalidateDevToolsSubscribersForRun(runId) {
    for (const [streamId, subscriber] of this.devtoolsSubscribers.entries()) {
      if (subscriber.runId === runId) {
        this.devtoolsInvalidateFlags.add(streamId);
      }
    }
  }
  /**
   * Authorize a devtools request against the connection's `subscribe` set.
   *
   * If the client provided a `subscribe` filter at `connect` time, the run
   * must be in that set before any DB lookup happens.
   *
   * @param {ConnectionState | null | undefined} connection
   * @param {string} runId
   * @returns {boolean}
   */
  isDevToolsRunAuthorized(connection, runId) {
    if (!connection) {
      return true;
    }
    // Two-state filter: a null/undefined `subscribedRuns` means no filter
    // was ever provided (unrestricted, backward compatible). A Set means a
    // `subscribe` filter WAS provided at connect time — the runId must be in
    // it. An explicitly-empty Set therefore denies every run.
    if (!connection.subscribedRuns) {
      return true;
    }
    return connection.subscribedRuns.has(runId);
  }
  /**
   * @param {ConnectionState} connection
   */
  cleanupDevToolsSubscribers(connection) {
    const streams = connection.devtoolsStreams;
    if (!streams || streams.size === 0) {
      return;
    }
    for (const streamId of streams.keys()) {
      this.unregisterDevToolsSubscriber(connection, streamId, {
        reason: "connection_closed",
      });
    }
  }
  /**
   * @param {string} runId
   * @returns {number}
   */
  getRunEventSubscriberCount(runId) {
    return this.runEventSubscriberCounts.get(runId) ?? 0;
  }
  /**
   * @param {string} runId
   */
  deleteRunEventWindow(runId) {
    this.clearTerminalRunEventWindowTimer(runId);
    this.runEventWindows.delete(runId);
    this.outOfProcessEventBridgeLastFedSeq.delete(runId);
  }
  /**
   * @param {string} runId
   */
  clearTerminalRunEventWindowTimer(runId) {
    const timer = this.terminalRunEventWindowTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.terminalRunEventWindowTimers.delete(runId);
    }
  }
  /**
   * @param {string} runId
   */
  scheduleTerminalRunEventWindowRelease(runId) {
    this.clearTerminalRunEventWindowTimer(runId);
    const timer = setTimeout(() => {
      this.terminalRunEventWindowTimers.delete(runId);
      this.releaseTerminalRunEventWindow(runId);
      this.enforceRunEventWindowLimit();
    }, RUN_EVENT_TERMINAL_WINDOW_GRACE_MS);
    timer.unref?.();
    this.terminalRunEventWindowTimers.set(runId, timer);
  }
  /**
   * @param {string} runId
   * @returns {boolean}
   */
  releaseTerminalRunEventWindow(runId) {
    if (!this.terminalRunEventWindows.has(runId)) {
      return false;
    }
    if (this.getRunEventSubscriberCount(runId) > 0) {
      return false;
    }
    this.clearTerminalRunEventWindowTimer(runId);
    this.deleteRunEventWindow(runId);
    this.terminalRunEventWindows.delete(runId);
    return true;
  }
  /**
   * @param {string} runId
   */
  markRunEventWindowTerminal(runId) {
    this.terminalRunEventWindows.delete(runId);
    this.terminalRunEventWindows.set(runId, nowMs());
    this.scheduleTerminalRunEventWindowRelease(runId);
    this.enforceRunEventWindowLimit();
  }
  enforceRunEventWindowLimit() {
    if (this.runEventWindows.size <= RUN_EVENT_WINDOW_RETAINED_RUN_LIMIT) {
      return;
    }
    for (const runId of this.terminalRunEventWindows.keys()) {
      if (this.runEventWindows.size <= RUN_EVENT_WINDOW_RETAINED_RUN_LIMIT) {
        return;
      }
      if (this.getRunEventSubscriberCount(runId) > 0) {
        continue;
      }
      this.deleteRunEventWindow(runId);
      this.terminalRunEventWindows.delete(runId);
    }
  }
  /**
   * @param {string} runId
   * @returns {{ nextSeq: number; window: Array<Record<string, unknown>> }}
   */
  getRunEventWindow(runId) {
    let state = this.runEventWindows.get(runId);
    if (!state) {
      state = { nextSeq: 0, window: [] };
      this.runEventWindows.set(runId, state);
    }
    return state;
  }
  /**
   * @param {string} event
   * @param {unknown} payload
   * @param {number} stateVersion
   * @returns {Record<string, unknown> | null}
   */
  appendRunEventWindow(event, payload, stateVersion) {
    const runId = eventRunId(payload);
    const browserSessionId = eventBrowserSessionId(event, payload);
    if (!runId) {
      return null;
    }
    const state = this.getRunEventWindow(runId);
    state.nextSeq += 1;
    const frame = {
      apiVersion: SMITHERS_API_VERSION,
      type: "RunEvent",
      runId,
      event,
      payload,
      seq: state.nextSeq,
      stateVersion,
    };
    state.window.push(frame);
    while (state.window.length > this.eventWindowSize) {
      state.window.shift();
    }
    this.enforceRunEventWindowLimit();
    return frame;
  }
  /**
   * @param {string} runId
   * @returns {number}
   */
  getRunEventCurrentSeq(runId) {
    return this.runEventWindows.get(runId)?.nextSeq ?? 0;
  }
  /**
   * First cap a run-event subscription would violate, or null when it fits.
   * The caller checks this immediately before registration, with no await in
   * between, so rejection happens before a stream map, heartbeat, or counter
   * is allocated.
   * @param {ConnectionState} connection
   * @param {string} runId
   * @returns {{ scope: "global" | "user" | "connection" | "run"; limit: number } | null}
   */
  runEventStreamCapViolation(connection, runId) {
    const userKey =
      asString(connection.userId) ?? asString(connection.tokenId) ?? asString(connection.role) ?? "anonymous";
    if (this.runEventSubscriberTotal >= this.runEventStreamMaxSubscribers) {
      return { scope: "global", limit: this.runEventStreamMaxSubscribers };
    }
    if ((this.runEventSubscribersByUser.get(userKey) ?? 0) >= this.runEventStreamMaxSubscribersPerUser) {
      return { scope: "user", limit: this.runEventStreamMaxSubscribersPerUser };
    }
    if ((connection.runEventStreams?.size ?? 0) >= this.runEventStreamMaxSubscribersPerConnection) {
      return { scope: "connection", limit: this.runEventStreamMaxSubscribersPerConnection };
    }
    if (this.getRunEventSubscriberCount(runId) >= this.runEventStreamMaxSubscribersPerRun) {
      return { scope: "run", limit: this.runEventStreamMaxSubscribersPerRun };
    }
    return null;
  }
  /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {string} runId
   * @param {boolean} [replayPending]
   * @returns {() => void}
   */
  registerRunEventSubscriber(connection, streamId, runId, replayPending = false) {
    if (!connection.runEventStreams) {
      connection.runEventStreams = new Map();
    }
    const userKey =
      asString(connection.userId) ?? asString(connection.tokenId) ?? asString(connection.role) ?? "anonymous";
    connection.runEventStreams.set(streamId, {
      streamId,
      runId,
      userKey,
      outboundQueue: [],
      flushPending: false,
      backpressureDisconnected: false,
      replayPending,
    });
    this.startRunEventHeartbeat(connection);
    this.runEventSubscriberTotal += 1;
    this.runEventSubscribersByUser.set(userKey, (this.runEventSubscribersByUser.get(userKey) ?? 0) + 1);
    const previous = this.runEventSubscriberCounts.get(runId) ?? 0;
    this.runEventSubscriberCounts.set(runId, previous + 1);
    return () => this.unregisterRunEventSubscriber(connection, streamId);
  }
  /**
   * Start the connection's shared run-event heartbeat timer. Each WebSocket
   * connection owns at most ONE heartbeat interval no matter how many run
   * event streams it registers; every tick emits one `run.heartbeat` frame
   * per active stream. No-op while the timer is already running; the timer
   * stops when the last stream unregisters (or the connection tears down).
   * @param {ConnectionState} connection
   */
  startRunEventHeartbeat(connection) {
    if (connection.runEventHeartbeatTimer) {
      return;
    }
    connection.runEventHeartbeatTimer = setInterval(() => {
      const streams = connection.runEventStreams;
      if (!streams || streams.size === 0) {
        this.stopRunEventHeartbeat(connection);
        return;
      }
      for (const stream of streams.values()) {
        this.sendEvent(connection, "run.heartbeat", {
          apiVersion: SMITHERS_API_VERSION,
          type: "Heartbeat",
          streamId: stream.streamId,
          runId: stream.runId,
          ts: nowMs(),
        });
      }
    }, RUN_EVENT_HEARTBEAT_MS);
  }
  /**
   * @param {ConnectionState} connection
   */
  stopRunEventHeartbeat(connection) {
    if (connection.runEventHeartbeatTimer) {
      clearInterval(connection.runEventHeartbeatTimer);
      connection.runEventHeartbeatTimer = null;
    }
  }
  /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   */
  unregisterRunEventSubscriber(connection, streamId) {
    const stream = connection.runEventStreams?.get(streamId);
    if (!stream) {
      return;
    }
    connection.runEventStreams?.delete(streamId);
    if (!connection.runEventStreams || connection.runEventStreams.size === 0) {
      this.stopRunEventHeartbeat(connection);
    }
    this.runEventSubscriberTotal = Math.max(0, this.runEventSubscriberTotal - 1);
    decrementSubscriberCount(this.runEventSubscribersByUser, stream.userKey);
    decrementSubscriberCount(this.runEventSubscriberCounts, stream.runId);
    this.releaseTerminalRunEventWindow(stream.runId);
    this.enforceRunEventWindowLimit();
  }
  /**
   * @param {ConnectionState} connection
   */
  cleanupRunEventSubscribers(connection) {
    const streams = connection.runEventStreams;
    if (!streams || streams.size === 0) {
      this.stopRunEventHeartbeat(connection);
      return;
    }
    for (const streamId of streams.keys()) {
      this.unregisterRunEventSubscriber(connection, streamId);
    }
  }
  /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {Record<string, unknown>} frame
   * @param {boolean} [replay]
   */
  sendRunEventStreamFrame(connection, streamId, frame, replay = false) {
    const stream = connection.runEventStreams?.get(streamId);
    if (!stream) {
      // Stream is not (or no longer) registered; deliver directly so any
      // legacy/out-of-band caller still works, then bail out of the queue.
      if (!replay) {
        this.sendEvent(connection, "run.event", { streamId, ...frame });
      }
      return;
    }
    if (stream.backpressureDisconnected) {
      return;
    }
    if (replay) {
      this.sendEvent(connection, "run.event", { streamId, ...frame });
      return;
    }
    if (stream.outboundQueue.length >= RUN_EVENT_STREAM_OUTBOUND_QUEUE_LIMIT) {
      this.disconnectRunEventStreamForBackpressure(connection, stream);
      return;
    }
    stream.outboundQueue.push(frame);
    if (!stream.replayPending) {
      this.drainRunEventStream(connection, stream);
    }
  }
  /**
   * Drain a run event stream's outbound queue against the socket's buffered
   * bytes. If the socket is congested past the high-water mark we re-arm a
   * short retry instead of dropping frames; the queue cap (enforced at enqueue
   * time) is what bounds memory and trips the slow-consumer disconnect.
   * @param {ConnectionState} connection
   * @param {RunEventStreamState} stream
   */
  drainRunEventStream(connection, stream) {
    if (stream.flushPending || stream.backpressureDisconnected) {
      return;
    }
    stream.flushPending = true;
    try {
      while (
        stream.outboundQueue.length > 0 &&
        !stream.backpressureDisconnected &&
        connection.ws.readyState === connection.ws.OPEN
      ) {
        const ws = connection.ws;
        if (
          typeof ws.bufferedAmount === "number" &&
          ws.bufferedAmount > RUN_EVENT_STREAM_WS_BUFFERED_HIGH_WATER_BYTES
        ) {
          setTimeout(() => {
            stream.flushPending = false;
            this.drainRunEventStream(connection, stream);
          }, RUN_EVENT_STREAM_DRAIN_RETRY_MS);
          return;
        }
        const frame = stream.outboundQueue.shift();
        if (!frame) {
          continue;
        }
        this.sendEvent(connection, "run.event", { streamId: stream.streamId, ...frame });
      }
    } finally {
      stream.flushPending = false;
    }
  }
  /**
   * Tear down a single slow run event subscriber whose outbound queue overflowed.
   * The WS connection itself stays open so other streams keep receiving events.
   * @param {ConnectionState} connection
   * @param {RunEventStreamState} stream
   */
  disconnectRunEventStreamForBackpressure(connection, stream) {
    if (stream.backpressureDisconnected) {
      return;
    }
    stream.backpressureDisconnected = true;
    stream.outboundQueue.length = 0;
    emitGatewayEffect(Metric.update(gatewayRunEventBackpressureDisconnectTotal, 1));
    emitGatewayLog(
      "warning",
      "run event stream disconnected for backpressure",
      {
        runId: stream.runId,
        streamId: stream.streamId,
        queueLimit: RUN_EVENT_STREAM_OUTBOUND_QUEUE_LIMIT,
      },
      "gateway:run-events",
    );
    this.sendEvent(connection, "run.error", {
      streamId: stream.streamId,
      runId: stream.runId,
      error: {
        version: SMITHERS_API_VERSION,
        code: "BackpressureDisconnect",
        message: `Run event stream outbound queue exceeded ${RUN_EVENT_STREAM_OUTBOUND_QUEUE_LIMIT} frames; disconnecting slow consumer.`,
      },
    });
    this.unregisterRunEventSubscriber(connection, stream.streamId);
  }
  /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {string} runId
   * @param {number} fromSeq
   * @param {number} toSeq
   * @param {unknown} snapshot
   */
  sendRunGapResync(connection, streamId, runId, fromSeq, toSeq, snapshot) {
    this.sendEvent(connection, "run.gap_resync", {
      apiVersion: SMITHERS_API_VERSION,
      type: "GapResync",
      streamId,
      runId,
      fromSeq,
      toSeq,
      snapshot,
    });
  }
  /**
   * @param {string} runId
   */
  async buildRunSnapshot(runId) {
    const resolved = await this.resolveRun(runId);
    if (!resolved) {
      return null;
    }
    const run = await resolved.adapter.getRun(runId);
    if (!run) {
      return null;
    }
    const [summary, runState, degradedOutcome] = await Promise.all([
      resolved.adapter.countNodesByState(runId),
      computeRunStateFromRow(resolved.adapter, run).catch(() => undefined),
      readPersistedDegradedOutcome(resolved.adapter, runId, run.status),
    ]);
    return {
      ...run,
      workflowKey: resolved.workflowKey,
      summary: summary.reduce((acc, row) => {
        acc[row.state] = row.count;
        return acc;
      }, {}),
      ...(runState ? { runState } : {}),
      ...degradedOutcome,
    };
  }
  /**
   * @param {GatewayTransport} transport
   * @param {string} frameType
   * @param {GatewayMetricLabels} [labels]
   */
  recordMessageReceived(transport, frameType, labels = {}) {
    emitGatewayEffect(
      incrementMetric(gatewayMessagesReceivedTotal, {
        transport,
        frameType,
        ...labels,
      }),
    );
  }
  /**
   * @param {GatewayTransport} transport
   * @param {string} frameType
   * @param {GatewayMetricLabels} [labels]
   */
  recordMessageSent(transport, frameType, labels = {}) {
    emitGatewayEffect(
      incrementMetric(gatewayMessagesSentTotal, {
        transport,
        frameType,
        ...labels,
      }),
    );
  }
  /**
   * @param {GatewayTransport} transport
   * @param {"success" | "failure"} outcome
   * @param {GatewayRequestContext} context
   * @param {Record<string, unknown>} [details]
   * @param {"debug" | "info" | "warning"} [level]
   */
  recordAuthEvent(transport, outcome, context, details = {}, level = outcome === "success" ? "info" : "warning") {
    const annotations = {
      ...gatewayContextAnnotations(context),
      authMode: this.authModeLabel(),
      outcome,
      ...details,
    };
    const logEffect =
      level === "debug"
        ? Effect.logDebug(outcome === "success" ? "Gateway auth succeeded" : "Gateway auth rejected")
        : level === "info"
          ? Effect.logInfo("Gateway auth succeeded")
          : Effect.logWarning("Gateway auth rejected");
    emitGatewayEffect(
      Effect.all(
        [
          incrementMetric(gatewayAuthEventsTotal, {
            transport,
            mode: this.authModeLabel(),
            outcome,
          }),
          logEffect.pipe(Effect.annotateLogs(annotations), Effect.withLogSpan("gateway:auth")),
        ],
        { discard: true },
      ),
    );
  }
  /**
   * @param {GatewayRequestContext} context
   * @param {RequestFrame} frame
   * @param {() => Promise<ResponseFrame>} handler
   * @returns {Promise<ResponseFrame>}
   */
  async executeRpc(context, frame, handler) {
    const self = this;
    const start = performance.now();
    const params = asObject(frame.params) ?? {};
    const result = await runPromise(
      Effect.gen(function* () {
        yield* incrementMetric(gatewayRpcCallsTotal, {
          transport: context.transport,
          method: frame.method,
        });
        yield* Effect.logDebug("Gateway RPC started");
        const result = yield* Effect.promise(() =>
          handler()
            .then((response) => ({ _tag: "success", response }))
            .catch((error) => ({ _tag: "failure", error })),
        );
        yield* updateMetric(gatewayRpcDuration, performance.now() - start, {
          transport: context.transport,
          method: frame.method,
        });
        if (result._tag === "failure") {
          yield* incrementMetric(gatewayErrorsTotal, {
            kind: "rpc",
            transport: context.transport,
            method: frame.method,
            code: gatewayErrorCode(result.error),
          });
          yield* Effect.logError("Gateway RPC failed").pipe(Effect.annotateLogs(gatewayErrorAnnotations(result.error)));
          return result;
        }
        if (!result.response.ok) {
          yield* incrementMetric(gatewayErrorsTotal, {
            kind: "rpc",
            transport: context.transport,
            method: frame.method,
            code: result.response.error?.code ?? "UNKNOWN",
          });
          yield* Effect.logWarning("Gateway RPC rejected").pipe(
            Effect.annotateLogs({
              ...gatewayRunAnnotations(params, result.response.payload),
              rpcCode: result.response.error?.code ?? "UNKNOWN",
              ...(result.response.error?.message ? { rpcMessage: result.response.error.message } : {}),
            }),
          );
        } else {
          yield* Effect.logDebug("Gateway RPC completed").pipe(
            Effect.annotateLogs(gatewayRunAnnotations(params, result.response.payload)),
          );
          yield* self.rpcSuccessEffect(context, frame, result.response);
        }
        return result;
      }).pipe(
        Effect.annotateLogs(gatewayRpcAnnotations(context, frame)),
        Effect.withLogSpan(`gateway:rpc:${frame.method}`),
      ),
    );
    if (result._tag === "failure") {
      throw result.error;
    }
    return result.response;
  }
  /**
   * @param {GatewayRequestContext} context
   * @param {RequestFrame} frame
   * @param {ResponseFrame} response
   * @returns {Effect.Effect<void>}
   */
  rpcSuccessEffect(context, frame, response) {
    const params = asObject(frame.params) ?? {};
    switch (frame.method) {
      case "approvals.decide":
      case "submitApproval": {
        const decision = asObject(params.decision);
        const approved = asBoolean(params.approved) ?? asBoolean(decision?.approved) ?? false;
        const nodeId = asString(params.nodeId);
        return Effect.all(
          [
            incrementMetric(gatewayApprovalDecisionsTotal, {
              outcome: approved ? "approved" : "denied",
            }),
            Effect.logInfo("Gateway approval decision recorded").pipe(
              Effect.annotateLogs({
                ...gatewayRpcAnnotations(context, frame, response.payload),
                ...(nodeId ? { nodeId } : {}),
                iteration: asNumber(params.iteration) ?? 0,
                approved,
              }),
            ),
          ],
          { discard: true },
        );
      }
      case "signals.send":
      case "submitSignal": {
        const signalName = asString(params.signalName) ?? asString(params.correlationKey);
        const correlationId = asString(params.correlationId) ?? asString(params.correlationKey);
        return Effect.all(
          [
            incrementMetric(gatewaySignalsTotal, { outcome: "sent" }),
            Effect.logInfo("Gateway signal sent").pipe(
              Effect.annotateLogs({
                ...gatewayRpcAnnotations(context, frame, response.payload),
                ...(signalName ? { signalName } : {}),
                ...(correlationId ? { correlationId } : {}),
              }),
            ),
          ],
          { discard: true },
        );
      }
      case "cron.trigger":
      case "cronRun": {
        const cronId = asString(params.cronId);
        const workflow = asString(params.workflow);
        return Effect.all(
          [
            incrementMetric(gatewayCronTriggersTotal, { source: "manual" }),
            Effect.logInfo("Gateway cron trigger requested").pipe(
              Effect.annotateLogs({
                ...gatewayRpcAnnotations(context, frame, response.payload),
                ...(cronId ? { cronId } : {}),
                ...(workflow ? { workflow } : {}),
              }),
            ),
          ],
          { discard: true },
        );
      }
      default:
        return Effect.void;
    }
  }
  /**
   * @param {ServerResponse} res
   * @param {number} status
   * @param {ResponseFrame} response
   */
  sendHttpRpcResponse(res, status, response) {
    this.recordMessageSent("http", "response", {
      outcome: response.ok ? "ok" : "error",
    });
    return sendJson(res, status, response);
  }
  /**
   * @param {Record<string, unknown>} frame
   */
  recordApiStreamFrame(frame) {
    const size = byteLengthOfJson(frame);
    this.apiStreamFrames.push({ frame, size });
    this.apiStreamFrameBytes += size;
    while (
      this.apiStreamFrames.length > API_STREAM_REPLAY_LIMIT ||
      this.apiStreamFrameBytes > API_STREAM_REPLAY_BYTES
    ) {
      const dropped = this.apiStreamFrames.shift();
      this.apiStreamFrameBytes -= dropped?.size ?? 0;
    }
  }
  /**
   * @param {Record<string, unknown>} subscriber
   */
  drainApiStreamSubscriber(subscriber) {
    if (subscriber.closed || subscriber.flushing) {
      return;
    }
    subscriber.flushing = true;
    try {
      if (subscriber.needsReset) {
        subscriber.needsReset = false;
        const reset = formatSseEvent("reset", { seq: this.apiStreamSeq });
        const ok = subscriber.res.write(reset);
        if (!ok) {
          subscriber.res.once("drain", () => {
            subscriber.flushing = false;
            this.drainApiStreamSubscriber(subscriber);
          });
          return;
        }
      }
      while (subscriber.queue.length > 0 && !subscriber.closed) {
        const item = subscriber.queue.shift();
        if (!item) {
          continue;
        }
        subscriber.queueBytes -= item.bytes;
        const ok = subscriber.res.write(item.text);
        if (!ok) {
          subscriber.res.once("drain", () => {
            subscriber.flushing = false;
            this.drainApiStreamSubscriber(subscriber);
          });
          return;
        }
      }
    } finally {
      subscriber.flushing = false;
    }
  }
  /**
   * @param {Record<string, unknown>} subscriber
   * @param {string} text
   * @param {number} bytes
   */
  enqueueApiStreamText(subscriber, text, bytes = Buffer.byteLength(text, "utf8")) {
    if (subscriber.closed) {
      return;
    }
    if (!subscriber.flushing && subscriber.queue.length === 0) {
      const ok = subscriber.res.write(text);
      if (!ok) {
        subscriber.flushing = true;
        subscriber.res.once("drain", () => {
          subscriber.flushing = false;
          this.drainApiStreamSubscriber(subscriber);
        });
      }
      return;
    }
    if (
      subscriber.queue.length >= API_STREAM_OUTBOUND_QUEUE_LIMIT ||
      subscriber.queueBytes + bytes > API_STREAM_OUTBOUND_BYTES
    ) {
      subscriber.queue.length = 0;
      subscriber.queueBytes = 0;
      subscriber.needsReset = true;
      return;
    }
    subscriber.queue.push({ text, bytes });
    subscriber.queueBytes += bytes;
    this.drainApiStreamSubscriber(subscriber);
  }
  /**
   * @param {Record<string, unknown>} subscriber
   * @param {Record<string, unknown>} frame
   */
  sendApiStreamFrame(subscriber, frame) {
    const text = formatSseEvent("change", frame, Number(frame.seq));
    this.enqueueApiStreamText(subscriber, text, Buffer.byteLength(text, "utf8"));
  }
  /**
   * @param {string[]} collections
   * @returns {Promise<number>}
   */
  queueApiInvalidation(collections) {
    for (const collection of collections) {
      if (typeof collection === "string" && collection.trim() !== "") {
        this.apiStreamPendingCollections.add(collection);
      }
    }
    return new Promise((resolve) => {
      this.apiStreamPendingResolvers.push(resolve);
      if (this.apiStreamFlushTimer) {
        return;
      }
      this.apiStreamFlushTimer = setTimeout(() => {
        this.apiStreamFlushTimer = null;
        this.flushApiInvalidation();
      }, API_STREAM_COALESCE_MS);
    });
  }
  flushApiInvalidation() {
    const collections = [...this.apiStreamPendingCollections].sort();
    const resolvers = this.apiStreamPendingResolvers.splice(0);
    this.apiStreamPendingCollections.clear();
    if (collections.length === 0) {
      for (const resolve of resolvers) {
        resolve(this.apiStreamSeq);
      }
      return;
    }
    this.apiStreamSeq += 1;
    const frame = { seq: this.apiStreamSeq, collections };
    this.recordApiStreamFrame(frame);
    // One logical copy per subscriber: serialize the frame once and route
    // the same text through every subscriber's byte-bounded queue. There is
    // no second direct-write path, so a subscriber can never receive a
    // duplicate generic copy of the same invalidation.
    const text = formatSseEvent("change", frame, this.apiStreamSeq);
    const bytes = Buffer.byteLength(text, "utf8");
    for (const subscriber of this.apiStreamSubscribers) {
      this.enqueueApiStreamText(subscriber, text, bytes);
    }
    for (const resolve of resolvers) {
      resolve(this.apiStreamSeq);
    }
  }
  /**
   * First cap an SSE subscription would violate, or null when it fits.
   * Checked before headers are written so rejected requests get a real
   * 429 JSON body instead of a half-open stream.
   * @param {string} userKey
   * @param {string} connectionKey
   * @returns {{ scope: "global" | "user" | "connection"; limit: number } | null}
   */
  apiStreamCapViolation(userKey, connectionKey) {
    if (this.apiStreamSubscribers.size >= this.apiStreamMaxSubscribers) {
      return { scope: "global", limit: this.apiStreamMaxSubscribers };
    }
    if ((this.apiStreamSubscribersByUser.get(userKey) ?? 0) >= this.apiStreamMaxSubscribersPerUser) {
      return { scope: "user", limit: this.apiStreamMaxSubscribersPerUser };
    }
    if ((this.apiStreamSubscribersByConnection.get(connectionKey) ?? 0) >= this.apiStreamMaxSubscribersPerConnection) {
      return { scope: "connection", limit: this.apiStreamMaxSubscribersPerConnection };
    }
    return null;
  }
  ensureApiStreamHeartbeat() {
    if (this.apiStreamHeartbeatTimer) {
      return;
    }
    // One shared interval for the whole subscriber set: each tick
    // serializes the heartbeat once and fans it out through the bounded
    // per-subscriber queues, instead of allocating a timer per subscriber.
    this.apiStreamHeartbeatTimer = setInterval(() => {
      const heartbeat = formatSseHeartbeat(this.apiStreamSeq);
      const bytes = Buffer.byteLength(heartbeat, "utf8");
      for (const subscriber of this.apiStreamSubscribers) {
        this.enqueueApiStreamText(subscriber, heartbeat, bytes);
      }
    }, API_STREAM_HEARTBEAT_MS);
  }
  stopApiStreamHeartbeatIfIdle() {
    if (this.apiStreamSubscribers.size === 0 && this.apiStreamHeartbeatTimer) {
      clearInterval(this.apiStreamHeartbeatTimer);
      this.apiStreamHeartbeatTimer = null;
    }
  }
  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  async handleApiStream(req, res) {
    const requestId = headerValue(req, "x-request-id") ?? randomUUID();
    const context = {
      connectionId: `api-stream:${requestId}`,
      transport: "http",
      role: null,
      scopes: [],
      userId: null,
      tokenId: null,
      subscribedRuns: null,
      devtoolsStreams: null,
    };
    const authResult = await this.authenticateRequest(req, bearerTokenFromHeaders(req));
    if (authResult.ok === false) {
      return sendJson(res, statusForRpcError(authResult.code), {
        ok: false,
        error: { code: authResult.code, message: authResult.message, details: authResult.details },
      });
    }
    context.role = authResult.role;
    context.scopes = [...authResult.scopes];
    context.userId = authResult.userId ?? null;
    context.tokenId = authResult.tokenId ?? null;
    if (!hasScope(context.scopes, "listRuns", this.extensions)) {
      const forbidden = responseForbidden(requestId, "listRuns", this.extensions);
      return sendJson(res, statusForRpcError(forbidden.error?.code), {
        ok: false,
        error: forbidden.error,
      });
    }
    const host = headerValue(req, "host") ?? "127.0.0.1";
    const url = new URL(`http://${host}${req.url ?? "/"}`);
    const lastEventIdRaw = headerValue(req, "last-event-id") ?? url.searchParams.get("lastEventId");
    let lastEventId;
    try {
      lastEventId = asOptionalNonNegativeInt(lastEventIdRaw, "Last-Event-ID");
    } catch (error) {
      if (!isSmithersError(error)) {
        throw error;
      }
      return sendJson(res, statusForRpcError(error.code), {
        ok: false,
        error: { code: error.code, message: error.summary },
      });
    }
    const userKey = context.userId ?? context.tokenId ?? context.role ?? "anonymous";
    const connectionKey = context.connectionId;
    const violation = this.apiStreamCapViolation(userKey, connectionKey);
    if (violation) {
      emitGatewayLog(
        "warning",
        "Gateway SSE subscriber rejected: cap reached",
        {
          requestId,
          capScope: violation.scope,
          capLimit: violation.limit,
          subscriberCount: this.apiStreamSubscribers.size,
        },
        "gateway:api-stream",
      );
      return sendJson(res, statusForRpcError("RateLimited"), {
        ok: false,
        error: {
          code: "RateLimited",
          message: `Gateway SSE subscriber limit reached (${violation.scope} cap of ${violation.limit}).`,
          details: { scope: violation.scope, limit: violation.limit },
        },
      });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Smithers-API-Version": SMITHERS_API_VERSION,
    });
    res.flushHeaders?.();
    const subscriber = {
      id: requestId,
      res,
      queue: [],
      queueBytes: 0,
      flushing: false,
      needsReset: false,
      closed: false,
    };
    const cleanup = () => {
      if (subscriber.closed) {
        return;
      }
      subscriber.closed = true;
      // Only give back cap slots for a subscriber that actually held
      // them — delete() is the registration source of truth.
      if (this.apiStreamSubscribers.delete(subscriber)) {
        decrementSubscriberCount(this.apiStreamSubscribersByUser, userKey);
        decrementSubscriberCount(this.apiStreamSubscribersByConnection, connectionKey);
      }
      this.stopApiStreamHeartbeatIfIdle();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    this.apiStreamSubscribers.add(subscriber);
    this.apiStreamSubscribersByUser.set(userKey, (this.apiStreamSubscribersByUser.get(userKey) ?? 0) + 1);
    this.apiStreamSubscribersByConnection.set(
      connectionKey,
      (this.apiStreamSubscribersByConnection.get(connectionKey) ?? 0) + 1,
    );
    this.ensureApiStreamHeartbeat();
    const firstSeq =
      this.apiStreamFrames.length > 0 ? Number(this.apiStreamFrames[0].frame.seq) : this.apiStreamSeq + 1;
    if (lastEventId !== undefined && lastEventId < firstSeq - 1) {
      this.enqueueApiStreamText(subscriber, formatSseEvent("reset", { seq: this.apiStreamSeq }));
    } else if (lastEventId !== undefined) {
      for (const { frame } of this.apiStreamFrames) {
        if (Number(frame.seq) > lastEventId) {
          this.sendApiStreamFrame(subscriber, frame);
        }
      }
    }
    this.enqueueApiStreamText(subscriber, formatSseHeartbeat(this.apiStreamSeq));
  }
  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @returns {Promise<SmithersDb | null>}
   */
  async adapterForApiMutation(method, params) {
    if (method === "launchRun" || method === "cronCreate" || method === "cronRun") {
      const workflowKey = asString(params.workflow);
      const resolvedCron =
        method === "cronRun" && !workflowKey && asString(params.cronId)
          ? await this.findCron(asString(params.cronId))
          : null;
      if (resolvedCron) {
        return resolvedCron.adapter;
      }
      const entry = workflowKey ? this.workflows.get(workflowKey) : undefined;
      return entry ? this.adapterForWorkflow(entry.workflow) : null;
    }
    if (method === "cronDelete") {
      const cronId = asString(params.cronId);
      const resolvedCron = cronId ? await this.findCron(cronId) : null;
      return resolvedCron?.adapter ?? null;
    }
    if (method === "createTicket" || method === "updateTicket" || method === "deleteTicket") {
      return this.primaryDocsAdapter();
    }
    if (method === "hijackRun") {
      return null;
    }
    const runId = asString(params.runId);
    if (!runId) {
      return null;
    }
    const resolved = await this.resolveRun(runId);
    return resolved?.adapter ?? null;
  }
  /**
   * @param {string} httpMethod
   * @param {URL} url
   * @param {Record<string, unknown>} body
   * @returns {{ method: string; params: Record<string, unknown>; mutation?: boolean; direct?: "events" } | null}
   */
  apiRouteForRequest(httpMethod, url, body) {
    const pathname = url.pathname;
    if (httpMethod === "GET" && pathname === "/v1/api/runs") {
      return {
        method: "listRuns",
        params: {
          filter: {
            limit: queryPositiveInt(url.searchParams, "limit"),
            offset: queryNonNegativeInt(url.searchParams, "offset"),
            status: queryString(url.searchParams, "status"),
            workflow: queryString(url.searchParams, "workflow"),
            parentRunId: queryString(url.searchParams, "parentRunId"),
            includeSystem:
              queryString(url.searchParams, "includeSystem") === undefined
                ? undefined
                : url.searchParams.get("includeSystem") === "true",
          },
        },
      };
    }
    if (httpMethod === "POST" && pathname === "/v1/api/runs") {
      return {
        method: "launchRun",
        params: {
          ...body,
          workflow: asString(body.workflow) ?? asString(body.workflowKey) ?? asString(body.workflowId),
          input: body.input ?? {},
        },
        mutation: true,
      };
    }
    const runAction = pathname.match(/^\/v1\/api\/runs\/([^/]+)\/(cancel|pause|resume|rewind|hijack)$/);
    if (httpMethod === "POST" && runAction) {
      const action = runAction[2];
      return {
        method:
          action === "cancel"
            ? "cancelRun"
            : action === "pause"
              ? "pauseRun"
              : action === "resume"
                ? "resumeRun"
                : action === "hijack"
                  ? "hijackRun"
                  : "rewindRun",
        params: { ...body, runId: decodeURIComponent(runAction[1]) },
        mutation: true,
      };
    }
    const oneshotMonitorAction = pathname.match(/^\/v1\/api\/runs\/([^/]+)\/oneshot-monitor\/(attach|steer|restart)$/);
    if (httpMethod === "POST" && oneshotMonitorAction) {
      const action = oneshotMonitorAction[2];
      return {
        method:
          action === "attach"
            ? "oneshotMonitorAttach"
            : action === "steer"
              ? "oneshotMonitorSteer"
              : "oneshotMonitorRestart",
        direct: "oneshotMonitor",
        params: {
          ...body,
          runId: decodeURIComponent(oneshotMonitorAction[1]),
          action,
        },
        mutation: true,
      };
    }
    const runHijackCandidates = pathname.match(/^\/v1\/api\/runs\/([^/]+)\/hijack-candidates$/);
    if (httpMethod === "GET" && runHijackCandidates) {
      // HTTP-API-only read (no RPC method): which nodes of a run have a
      // resumable agent session, so UIs can gate their hijack affordance.
      return {
        method: "listHijackCandidates",
        direct: "hijackCandidates",
        params: { runId: decodeURIComponent(runHijackCandidates[1]) },
      };
    }
    const runNodeStates = pathname.match(/^\/v1\/api\/runs\/([^/]+)\/node-states$/);
    if (httpMethod === "GET" && runNodeStates) {
      // Flat per-(nodeId, iteration) execution states with latest-attempt
      // timing — the tree route folds these into the snapshot, this
      // returns the raw rows for chronological views.
      return {
        method: "listNodeStates",
        params: { runId: decodeURIComponent(runNodeStates[1]) },
      };
    }
    const runTokenUsage = pathname.match(/^\/v1\/api\/runs\/([^/]+)\/token-usage$/);
    if (httpMethod === "GET" && runTokenUsage) {
      return {
        method: "listRunTokenUsage",
        params: { runId: decodeURIComponent(runTokenUsage[1]) },
      };
    }
    const runDescendants = pathname.match(/^\/v1\/api\/runs\/([^/]+)\/descendants$/);
    if (httpMethod === "GET" && runDescendants) {
      return {
        method: "listRunDescendants",
        params: {
          runId: decodeURIComponent(runDescendants[1]),
          limit: queryPositiveInt(url.searchParams, "limit"),
        },
      };
    }
    const runTree = pathname.match(/^\/v1\/api\/runs\/([^/]+)\/(?:tree|devtools)$/);
    if (httpMethod === "GET" && runTree) {
      return {
        method: "getDevToolsSnapshot",
        params: {
          runId: decodeURIComponent(runTree[1]),
          frameNo: queryNonNegativeInt(url.searchParams, "frameNo"),
        },
      };
    }
    const runEvents = pathname.match(/^\/v1\/api\/runs\/([^/]+)\/events$/);
    if (httpMethod === "GET" && (pathname === "/v1/api/events" || runEvents)) {
      return {
        method: "streamRunEvents",
        direct: "events",
        params: {
          runId: runEvents ? decodeURIComponent(runEvents[1]) : queryString(url.searchParams, "runId"),
          nodeId: queryString(url.searchParams, "nodeId"),
          afterSeq: queryNonNegativeInt(url.searchParams, "afterSeq"),
          limit: queryPositiveInt(url.searchParams, "limit"),
        },
      };
    }
    const runById = pathname.match(/^\/v1\/api\/runs\/([^/]+)$/);
    if (httpMethod === "GET" && runById) {
      return { method: "getRun", params: { runId: decodeURIComponent(runById[1]) } };
    }
    const nodeRetry =
      pathname.match(/^\/v1\/api\/nodes\/([^/]+)\/([^/]+)\/retry$/) ??
      pathname.match(/^\/v1\/api\/runs\/([^/]+)\/nodes\/([^/]+)\/retry$/);
    if (httpMethod === "POST" && nodeRetry) {
      return {
        method: "retryTask",
        params: {
          ...body,
          runId: decodeURIComponent(nodeRetry[1]),
          nodeId: decodeURIComponent(nodeRetry[2]),
        },
        mutation: true,
      };
    }
    const nodeRoute =
      pathname.match(/^\/v1\/api\/nodes\/([^/]+)\/([^/]+)\/(output|diff)$/) ??
      pathname.match(/^\/v1\/api\/runs\/([^/]+)\/nodes\/([^/]+)\/(output|diff)$/);
    if (httpMethod === "GET" && nodeRoute) {
      return {
        method: nodeRoute[3] === "output" ? "getNodeOutput" : "getNodeDiff",
        params: {
          runId: decodeURIComponent(nodeRoute[1]),
          nodeId: decodeURIComponent(nodeRoute[2]),
          iteration: queryNonNegativeInt(url.searchParams, "iteration") ?? 0,
        },
      };
    }
    if (httpMethod === "GET" && pathname === "/v1/api/approvals") {
      return {
        method: "listApprovals",
        params: {
          runId: queryString(url.searchParams, "runId"),
          workflow: queryString(url.searchParams, "workflow"),
          limit: queryPositiveInt(url.searchParams, "limit"),
        },
      };
    }
    const approvalSubmit = pathname.match(/^\/v1\/api\/approvals\/([^/]+)$/);
    if (httpMethod === "POST" && approvalSubmit) {
      const approvalId = decodeURIComponent(approvalSubmit[1]);
      const first = approvalId.indexOf(":");
      const last = approvalId.lastIndexOf(":");
      const parsed =
        first > 0 && last > first
          ? {
              runId: approvalId.slice(0, first),
              nodeId: approvalId.slice(first + 1, last),
              iteration: Number(approvalId.slice(last + 1)),
            }
          : {};
      return {
        method: "submitApproval",
        params: {
          ...parsed,
          ...body,
          approvalId,
        },
        mutation: true,
      };
    }
    if (httpMethod === "POST" && pathname === "/v1/api/signals") {
      return { method: "submitSignal", params: body, mutation: true };
    }
    if (httpMethod === "POST" && pathname === "/v1/api/crons") {
      return { method: "cronCreate", params: body, mutation: true };
    }
    const cronById = pathname.match(/^\/v1\/api\/crons\/([^/]+)$/);
    if (httpMethod === "DELETE" && cronById) {
      return { method: "cronDelete", params: { ...body, cronId: decodeURIComponent(cronById[1]) }, mutation: true };
    }
    if (httpMethod === "POST" && pathname === "/v1/api/crons/run") {
      return { method: "cronRun", params: body, mutation: true };
    }
    // Keep the fixed comparison path ahead of the parameterized score
    // detail route so `compare` can never be interpreted as a run id.
    if (httpMethod === "GET" && pathname === "/v1/api/scores/compare") {
      return {
        method: "listScoresForRuns",
        params: {
          runIds: url.searchParams.getAll("runId"),
          nodeId: queryString(url.searchParams, "nodeId"),
          scorerId: queryString(url.searchParams, "scorerId"),
          scorerName: queryString(url.searchParams, "scorerName"),
          source: queryString(url.searchParams, "source"),
          order: queryString(url.searchParams, "order"),
          offset: queryNonNegativeInt(url.searchParams, "offset"),
          limit: queryNonNegativeInt(url.searchParams, "limit"),
        },
      };
    }
    const scoreDetail = pathname.match(/^\/v1\/api\/scores\/([^/]+)\/([^/]+)$/);
    if (httpMethod === "GET" && scoreDetail) {
      return {
        method: "getScoreDetail",
        params: {
          runId: decodeURIComponent(scoreDetail[1]),
          scoreId: decodeURIComponent(scoreDetail[2]),
        },
      };
    }
    if (httpMethod === "POST" && pathname === "/v1/api/tickets") {
      return { method: "createTicket", params: body, mutation: true };
    }
    const ticketByPath = pathname.match(/^\/v1\/api\/tickets\/(.+)$/);
    if ((httpMethod === "PATCH" || httpMethod === "PUT") && ticketByPath) {
      return { method: "updateTicket", params: { ...body, path: decodeURIComponent(ticketByPath[1]) }, mutation: true };
    }
    if (httpMethod === "DELETE" && ticketByPath) {
      return { method: "deleteTicket", params: { ...body, path: decodeURIComponent(ticketByPath[1]) }, mutation: true };
    }
    const simpleReads = new Map([
      ["/v1/api/workflows", "listWorkflows"],
      ["/v1/api/docs", "listDocs"],
      ["/v1/api/prompts", "listPrompts"],
      ["/v1/api/scores", "listScores"],
      ["/v1/api/tickets", "listTickets"],
      ["/v1/api/memory-facts", "listMemoryFacts"],
      ["/v1/api/crons", "cronList"],
      ["/v1/api/accounts", "listAccounts"],
      ["/v1/api/usage", "listUsageReports"],
      ["/v1/api/schema-signature", "getSchemaSignature"],
    ]);
    const method = simpleReads.get(pathname);
    if (httpMethod === "GET" && method) {
      return {
        method,
        params: {
          hasUi:
            queryString(url.searchParams, "hasUi") === undefined ? undefined : url.searchParams.get("hasUi") === "true",
          includeSystem:
            queryString(url.searchParams, "includeSystem") === undefined
              ? undefined
              : url.searchParams.get("includeSystem") === "true",
          kind: queryString(url.searchParams, "kind"),
          namespace: queryString(url.searchParams, "namespace"),
          runId: queryString(url.searchParams, "runId"),
          nodeId: queryString(url.searchParams, "nodeId"),
          workflow: queryString(url.searchParams, "workflow"),
          limit: queryPositiveInt(url.searchParams, "limit"),
          includeDeleted:
            queryString(url.searchParams, "includeDeleted") === undefined
              ? undefined
              : url.searchParams.get("includeDeleted") === "true",
          updatedAfterMs: queryNonNegativeInt(url.searchParams, "updatedAfterMs"),
          fresh:
            queryString(url.searchParams, "fresh") === undefined ? undefined : url.searchParams.get("fresh") === "true",
        },
      };
    }
    return null;
  }
  /**
   * @param {Record<string, unknown>} params
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async listApiRunEvents(params) {
    const runId = asString(params.runId);
    if (!runId) {
      throw new SmithersError("INVALID_INPUT", "runId is required");
    }
    const resolved = await this.resolveRun(runId);
    if (!resolved) {
      throw new SmithersError("NOT_FOUND", `Run not found: ${runId}`);
    }
    const nodeId = asString(params.nodeId);
    const limit = asOptionalPositiveInt(params.limit, "limit") ?? 100;
    if (!nodeId) {
      const rows = await resolved.adapter.listEventHistory(runId, {
        afterSeq: asOptionalNonNegativeInt(params.afterSeq, "afterSeq"),
        limit,
      });
      return rows.map((row) => serializeRunEventRow(row));
    }
    // Per-node transcript: one SQL pass in the adapter (newest matches,
    // returned ascending). JS-side history paging could not stay
    // interactive on long runs, and its bounded recency window missed OLD
    // nodes' events entirely — transcripts for early nodes never loaded.
    if (!/^[a-zA-Z0-9:_.\-]{1,160}$/.test(nodeId)) {
      throw new SmithersError("INVALID_INPUT", "nodeId contains unsupported characters");
    }
    const matches = await resolved.adapter.listNodeEvents(runId, nodeId, {
      afterSeq: asOptionalNonNegativeInt(params.afterSeq, "afterSeq"),
      limit,
    });
    return matches.map((row) => serializeRunEventRow(row));
  }
  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  async handleHttpApi(req, res) {
    const requestId = headerValue(req, "x-request-id") ?? randomUUID();
    const httpMethod = req.method ?? "GET";
    const host = headerValue(req, "host") ?? "127.0.0.1";
    const url = new URL(`http://${host}${req.url ?? "/"}`);
    const baseContext = {
      connectionId: `api:${requestId}`,
      transport: "http",
      role: null,
      scopes: [],
      userId: null,
      tokenId: null,
      subscribedRuns: null,
      devtoolsStreams: null,
    };
    let context = baseContext;
    this.recordMessageReceived("http", "request", { route: "api" });
    try {
      const authResult = await this.authenticateRequest(req, bearerTokenFromHeaders(req));
      if (authResult.ok === false) {
        this.recordAuthEvent(
          "http",
          "failure",
          context,
          {
            requestId,
            authCode: authResult.code,
            authMessage: authResult.message,
          },
          "warning",
        );
        return sendJson(res, statusForRpcError(authResult.code), {
          ok: false,
          error: { code: authResult.code, message: authResult.message, details: authResult.details },
        });
      }
      context = {
        ...baseContext,
        role: authResult.role,
        scopes: [...authResult.scopes],
        userId: authResult.userId ?? null,
        tokenId: authResult.tokenId ?? null,
      };
      this.recordAuthEvent(
        "http",
        "success",
        context,
        {
          requestId,
          scopeCount: authResult.scopes.length,
        },
        "debug",
      );
      const body =
        httpMethod === "POST" || httpMethod === "PUT" || httpMethod === "PATCH"
          ? (asObject(await readBody(req, this.maxBodyBytes)) ?? {})
          : {};
      const route = this.apiRouteForRequest(httpMethod, url, body);
      if (!route) {
        return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found" } });
      }
      const mutationAdapter = route.mutation ? await this.adapterForApiMutation(route.method, route.params) : null;
      const txidCapture = mutationAdapter ? createTxidCapture(mutationAdapter) : null;
      const frame = {
        type: "req",
        id: requestId,
        method: route.method,
        params: route.params,
      };
      const execute = () =>
        this.executeRpc(context, frame, async () => {
          if (!hasScope(context.scopes, route.method, this.extensions)) {
            return responseForbidden(requestId, route.method, this.extensions);
          }
          if (route.direct === "events") {
            return responseOk(requestId, await this.listApiRunEvents(route.params));
          }
          if (route.direct === "hijackCandidates") {
            const runId = asString(route.params.runId);
            if (!runId) {
              return responseError(requestId, "InvalidRunId", "runId is required");
            }
            const resolved = await this.resolveRun(runId);
            if (!resolved) {
              return responseError(requestId, "RunNotFound", `Run not found: ${runId}`);
            }
            const attempts = await resolved.adapter.listAttemptsForRun(runId);
            return responseOk(requestId, { runId, candidates: hijackCandidatesFromAttempts(attempts) });
          }
          if (route.direct === "oneshotMonitor") {
            const runId = asString(route.params.runId);
            const action = asString(route.params.action);
            if (!runId || !action) {
              return responseError(requestId, "InvalidInput", "runId and monitor action are required");
            }
            if (!this.oneshotMonitor) {
              return responseError(requestId, "InvalidInput", "Oneshot monitor controls are not configured");
            }
            const resolved = await this.resolveRun(runId);
            if (!resolved) {
              return responseError(requestId, "RunNotFound", `Run not found: ${runId}`);
            }
            try {
              if (action === "attach") {
                return responseOk(requestId, await this.oneshotMonitor.attach({ runId, adapter: resolved.adapter }));
              }
              if (action === "steer") {
                const message = asString(route.params.message);
                if (!message) {
                  return responseError(requestId, "InvalidInput", "Steering message is required");
                }
                return responseOk(
                  requestId,
                  await this.oneshotMonitor.steer({ runId, message, adapter: resolved.adapter }),
                );
              }
              return responseOk(requestId, await this.oneshotMonitor.restart({ runId, adapter: resolved.adapter }));
            } catch (error) {
              return responseError(requestId, "InvalidInput", error instanceof Error ? error.message : String(error));
            }
          }
          return this.routeRequest(context, frame);
        });
      const response = txidCapture ? await runWithTxidCapture(txidCapture, execute) : await execute();
      if (!response.ok) {
        return sendJson(res, statusForRpcError(response.error?.code), {
          ok: false,
          error: response.error,
        });
      }
      const data = serializeGatewayApiPayload(route.method, response.payload);
      if (!route.mutation) {
        return sendJson(res, 200, { ok: true, data });
      }
      const expectsTxid = mutationAdapter ? await isRealPostgresAdapter(mutationAdapter).catch(() => false) : false;
      const txid = txidCapture
        ? await captureTxid(txidCapture, { waitMs: expectsTxid ? 2_000 : 0 }).catch(() => null)
        : null;
      if (txid) {
        await this.queueApiInvalidation(apiMutationCollections(route.method));
        return sendJson(res, 200, { ok: true, data, txid });
      }
      if (expectsTxid) {
        return sendJson(res, 500, {
          ok: false,
          error: {
            code: "TXID_NOT_CAPTURED",
            message: "Postgres mutation completed without a transaction id captured inside the write transaction.",
          },
        });
      }
      const seq = await this.queueApiInvalidation(apiMutationCollections(route.method));
      return sendJson(res, 200, { ok: true, data, seq });
    } catch (error) {
      emitGatewayEffect(
        incrementMetric(gatewayErrorsTotal, {
          kind: "http",
          transport: "http",
          code: gatewayErrorCode(error),
        }),
      );
      emitGatewayLog(
        isSmithersError(error) ? "warning" : "error",
        "Gateway HTTP API failed",
        {
          ...gatewayContextAnnotations(context),
          requestId,
          ...gatewayErrorAnnotations(error),
        },
        "gateway:http-api",
      );
      if (isSmithersError(error)) {
        return sendJson(res, statusForRpcError(error.code), {
          ok: false,
          error: { code: error.code, message: error.summary },
        });
      }
      const message = error?.message ?? "Gateway API request failed";
      const status = message.includes("valid JSON") ? 400 : message.includes("exceeds") ? 413 : 500;
      return sendJson(res, status, {
        ok: false,
        error: {
          code: status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "INVALID_JSON" : "SERVER_ERROR",
          message,
        },
      });
    }
  }
  /**
   * @param {SmithersDb} adapter
   * @param {string} runId
   * @param {string} signalName
   * @param {string | null} correlationId
   */
  async runWaitsForSignal(adapter, runId, signalName, correlationId) {
    const nodes = await adapter.listNodes(runId);
    for (const node of nodes) {
      if (node.state !== "waiting-event") {
        continue;
      }
      const iteration = node.iteration ?? 0;
      const attempts = await runPromise(adapter.listAttempts(runId, node.nodeId, iteration));
      const waitingAttempt = attempts.find((attempt) => attempt.state === "waiting-event") ?? attempts[0];
      const snapshot = parseWebhookWaitForEventSnapshot(waitingAttempt?.metaJson);
      if (!snapshot) {
        continue;
      }
      if (snapshot.signalName !== signalName) {
        continue;
      }
      if (snapshot.correlationId !== correlationId) {
        continue;
      }
      return true;
    }
    return false;
  }
  /**
   * @param {RegisteredWorkflow} entry
   * @param {string} signalName
   * @param {string | null} correlationId
   * @param {string} [explicitRunId]
   */
  async findMatchingWebhookRuns(entry, signalName, correlationId, explicitRunId) {
    const adapter = this.adapterForWorkflow(entry.workflow);
    const matches = new Set();
    if (explicitRunId) {
      const run = await adapter.getRun(explicitRunId);
      if (
        run &&
        run.status !== "finished" &&
        run.status !== "failed" &&
        run.status !== "cancelled" &&
        (await this.runWaitsForSignal(adapter, explicitRunId, signalName, correlationId))
      ) {
        matches.add(explicitRunId);
      }
      return [...matches];
    }
    // No explicit runId: match every run parked on this signal. Delegate to
    // the adapter's single-query `findRunsAwaitingEvent` — the canonical
    // run-targeting query for external events — instead of listing up to
    // 1000 waiting runs and issuing listNodes + per-node listAttempts for
    // each (an O(runs × nodes) DB scan on the webhook hot path). The query
    // also skips already-resolved waits (`resolvedSignalSeq`), which the old
    // per-run scan did not, closing a latent double-delivery gap.
    const waitingRunIds = await runPromise(adapter.findRunsAwaitingEvent(signalName, correlationId));
    for (const runId of waitingRunIds) {
      matches.add(runId);
    }
    return [...matches];
  }
  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {string} workflowKey
   */
  async handleWebhook(req, res, workflowKey) {
    const requestId = headerValue(req, "x-request-id") ?? randomUUID();
    /**
     * @param {number} status
     * @param {unknown} payload
     */
    const respond = (status, payload) => {
      this.recordMessageSent("http", "response", {
        route: "webhook",
        workflow: workflowKey,
        outcome: status < 400 ? "ok" : "error",
      });
      return sendJson(res, status, payload);
    };
    /**
     * @param {number} status
     * @param {string} code
     * @param {string} message
     * @param {string} reason
     * @param {unknown} [error]
     */
    const reject = (status, code, message, reason, error) => {
      emitGatewayEffect(
        Effect.all(
          [
            incrementMetric(gatewayWebhooksRejectedTotal, {
              workflow: workflowKey,
              reason,
            }),
            incrementMetric(gatewayErrorsTotal, {
              kind: "webhook",
              workflow: workflowKey,
              code,
            }),
          ],
          { discard: true },
        ),
      );
      emitGatewayLog(
        error && !isSmithersError(error) ? "error" : "warning",
        "Gateway webhook rejected",
        {
          workflow: workflowKey,
          requestId,
          reason,
          errorCode: code,
          errorMessage: message,
          ...(error ? gatewayErrorAnnotations(error) : {}),
        },
        "gateway:webhook",
      );
      return respond(status, { ok: false, error: { code, message } });
    };
    this.recordMessageReceived("http", "webhook", { workflow: workflowKey });
    emitGatewayEffect(
      incrementMetric(gatewayWebhooksReceivedTotal, {
        workflow: workflowKey,
      }),
    );
    if (!this.workflows.has(workflowKey)) {
      await this.refreshWorkflowRegistryOnMiss(workflowKey);
    }
    const entry = this.workflows.get(workflowKey);
    if (!entry) {
      return reject(404, "NOT_FOUND", `Unknown workflow: ${workflowKey}`, "workflow_not_found");
    }
    const webhook = entry.webhook;
    if (!webhook) {
      return reject(404, "NOT_FOUND", `Webhook not configured for workflow: ${workflowKey}`, "not_configured");
    }
    const secret = webhook.secret.trim();
    if (!secret) {
      return reject(500, "SERVER_ERROR", "Webhook secret is not configured", "not_configured");
    }
    const signatureHeader = webhook.signatureHeader?.trim().toLowerCase() || "x-hub-signature-256";
    const signaturePrefix = webhook.signaturePrefix ?? "sha256=";
    const signalConfig = webhook.signal;
    const runConfig = webhook.run;
    const runEnabled = runConfig?.enabled !== false;
    if (!signalConfig?.name && !runEnabled) {
      return reject(
        400,
        "INVALID_REQUEST",
        "Webhook config must enable signal delivery or run creation",
        "misconfigured",
      );
    }
    try {
      const rawBody = await readRawBody(req, this.maxBodyBytes);
      const providedSignature = headerValue(req, signatureHeader);
      const expectedSignature = computeWebhookSignature(rawBody, secret, signaturePrefix);
      if (!isValidWebhookSignature(expectedSignature, providedSignature)) {
        return reject(401, "UNAUTHORIZED", "Webhook signature verification failed", "invalid_signature");
      }
      emitGatewayEffect(
        incrementMetric(gatewayWebhooksVerifiedTotal, {
          workflow: workflowKey,
        }),
      );
      const payload = parseJsonBuffer(rawBody, "Webhook payload");
      const adapter = this.adapterForWorkflow(entry.workflow);
      const explicitRunId = asWebhookString(readPathValue(payload, signalConfig?.runIdPath));
      const correlationId = normalizeCorrelationId(
        asWebhookString(readPathValue(payload, signalConfig?.correlationIdPath)) ?? null,
      );
      const signalPayload = readPathValue(payload, signalConfig?.payloadPath);
      const matchedRunIds = signalConfig?.name
        ? await this.findMatchingWebhookRuns(entry, signalConfig.name, correlationId, explicitRunId)
        : [];
      const triggeredBy = webhookTriggerUserId(workflowKey);
      const auth = {
        triggeredBy,
        scopes: ["*"],
        role: "system",
      };
      const delivered = [];
      for (const runId of matchedRunIds) {
        const { signalRun } = await loadEngineSignals();
        const signal = await Effect.runPromise(
          signalRun(adapter, runId, signalConfig.name, signalPayload, {
            correlationId,
            receivedBy: triggeredBy,
          }),
        );
        delivered.push({
          runId,
          seq: signal.seq,
          signalName: signal.signalName,
          correlationId: signal.correlationId ?? null,
          receivedAtMs: signal.receivedAtMs,
        });
        await this.resumeRunIfNeeded(runId, workflowKey, adapter, auth);
      }
      const started =
        delivered.length === 0 && runEnabled
          ? await this.startRun(
              workflowKey,
              normalizeWebhookRunInput(readPathValue(payload, runConfig?.inputPath)),
              auth,
            )
          : null;
      emitGatewayLog(
        "info",
        "Gateway webhook processed",
        {
          workflow: workflowKey,
          requestId,
          matchedRunCount: matchedRunIds.length,
          deliveredCount: delivered.length,
          ...(started ? { startedRunId: started.runId } : {}),
        },
        "gateway:webhook",
      );
      return respond(200, {
        ok: true,
        workflow: workflowKey,
        verified: true,
        delivered,
        matchedRunIds,
        started,
      });
    } catch (error) {
      if (isSmithersError(error)) {
        return reject(statusForRpcError(error.code), error.code, error.summary, "invalid_payload", error);
      }
      return reject(500, "SERVER_ERROR", error?.message ?? "Gateway webhook failed", "server_error", error);
    }
  }
  /**
   * Register a typed extension namespace exposing declarative resources,
   * actions, and streams. See `./GatewayExtensions.js` for the surface; this
   * shim exists so callers can keep their fluent `gateway.register(...).extend(...)`
   * chain on the Gateway instance instead of reaching into the registry.
   *
   * Namespace collisions throw, so two extensions cannot silently take over
   * the same name on hot-reload — the host must explicitly tear the previous
   * gateway down. See `.smithers/specs/gateway-extensions-sync-backplane.md`.
   *
   * @param {string} namespace
   * @param {import("./GatewayExtensions.js").GatewayExtensionDefinition} definition
   * @returns {this}
   */
  extend(namespace, definition) {
    this.extensions.register(namespace, definition);
    return this;
  }
  /**
   * Register a workflow under `key`. Wires up its DB tables, schedule, webhook
   * config, and embedded UI bundle. Returns `this` so callers can chain
   * `gateway.register(...).register(...).extend(...)` fluently.
   *
   * @param {string} key
   * @param {SmithersWorkflow} workflow
   * @param {GatewayRegisterOptions} [options]
   * @returns {this}
   */
  register(key, workflow, options) {
    ensureSmithersTables(workflow.db);
    const embeddedViews = discoverWorkflowViews(key, workflow, options?.entryFile);
    const ui =
      resolveGatewayUiConfig(options?.ui, `/workflows/${encodeURIComponent(key)}`) ??
      (embeddedViews.ui
        ? workflowViewToGatewayUiConfig(embeddedViews.ui, key, `/workflows/${encodeURIComponent(key)}`)
        : null);
    const tui = embeddedViews.tui ? workflowViewToTuiConfig(embeddedViews.tui) : null;
    this.workflows.set(key, {
      key,
      workflow,
      schedule: options?.schedule,
      webhook: options?.webhook,
      ui,
      tui,
      system: Boolean(options?.system),
      entryFile: options?.entryFile,
    });
    void this.queueApiInvalidation(["workflows"]);
    // Startup recovery: any audit row left in `in_progress` from a prior
    // crash is flipped to `partial` and the associated run is flagged as
    // `needs_attention`. Runs asynchronously; failures are logged and
    // never block registration.
    const adapter = new SmithersDb(workflow.db);
    recoverInProgressRewindAudits(adapter).catch((error) => {
      emitGatewayLog(
        "warning",
        "rewind audit recovery failed",
        {
          workflow: key,
          ...gatewayErrorAnnotations(error),
        },
        "gateway:startup-recovery",
      );
    });
    return this;
  }
  /**
   * Gate a `/v1/pty/hijack` websocket upgrade: authenticate the request (same
   * token/Host/Origin semantics as the HTTP API, token also accepted as a
   * `?token=` query param since browsers cannot set websocket headers), check
   * the hijack scope, validate the target run, then hand the socket to
   * `startPtyHijackSession`. The Origin/Host allow-list already ran in the
   * shared `upgrade` handler before this method is reached.
   *
   * @param {IncomingMessage} req
   * @param {import("node:stream").Duplex} socket
   * @param {Buffer} head
   * @param {WebSocketServer} wsServer
   * @param {URL} url
   */
  async handlePtyHijackUpgrade(req, socket, head, wsServer, url) {
    const token = url.searchParams.get("token") ?? bearerTokenFromHeaders(req);
    const authResult = await this.authenticateRequest(req, token);
    if (authResult.ok === false) {
      emitGatewayLog(
        "warning",
        "Gateway PTY hijack upgrade rejected: unauthorized",
        {
          remoteAddress: req.socket.remoteAddress ?? null,
          authCode: authResult.code,
        },
        "gateway:pty-hijack",
      );
      endUpgradeWithHttpError(socket, statusForRpcError(authResult.code), "Unauthorized", `${authResult.message}\n`);
      return;
    }
    if (!hasScope([...authResult.scopes], "hijackRun", this.extensions)) {
      endUpgradeWithHttpError(socket, 403, "Forbidden", "Missing scope for hijackRun\n");
      return;
    }
    if (!this.hijackPty) {
      endUpgradeWithHttpError(socket, 501, "Not Implemented", "PTY hijack is not configured on this gateway\n");
      return;
    }
    if (typeof Bun === "undefined" || typeof Bun.Terminal !== "function") {
      endUpgradeWithHttpError(socket, 501, "Not Implemented", "PTY hijack requires the gateway to run under Bun\n");
      return;
    }
    const runId = url.searchParams.get("runId")?.trim();
    if (!runId) {
      endUpgradeWithHttpError(socket, 400, "Bad Request", "runId query parameter is required\n");
      return;
    }
    const resolved = await this.resolveRun(runId);
    if (!resolved) {
      endUpgradeWithHttpError(socket, 404, "Not Found", `Run not found: ${runId}\n`);
      return;
    }
    const nodeId = url.searchParams.get("nodeId")?.trim() || undefined;
    const cols = clampPtyDimension(url.searchParams.get("cols"), 80);
    const rows = clampPtyDimension(url.searchParams.get("rows"), 24);
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      this.startPtyHijackSession(ws, { runId, nodeId, cols, rows });
    });
  }
  /**
   * Run the host-provided hijack command inside a real PTY and pipe it over an
   * accepted websocket. Mirrors the terminal transport smithers cloud UIs use:
   * binary frames are raw PTY bytes in both directions; text frames are JSON
   * control messages (client sends `{"type":"resize","cols","rows"}`, the
   * server sends `{"type":"exit","code"}` before a clean close).
   *
   * @param {import("ws").WebSocket} ws
   * @param {{ runId: string; nodeId?: string; cols: number; rows: number }} params
   */
  startPtyHijackSession(ws, params) {
    /** @type {(message: string) => void} */
    const failClose = (message) => {
      try {
        ws.send(JSON.stringify({ type: "error", message }));
      } catch {}
      try {
        ws.close(1011, "pty launch failed");
      } catch {}
    };
    let spec;
    try {
      spec = this.hijackPty?.({ runId: params.runId, ...(params.nodeId ? { nodeId: params.nodeId } : {}) });
    } catch (error) {
      failClose(`PTY hijack launcher failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const command = spec && Array.isArray(spec.command) ? spec.command.filter((part) => typeof part === "string") : [];
    if (command.length === 0) {
      failClose("PTY hijack launcher returned no command");
      return;
    }
    const terminal = new Bun.Terminal({
      cols: params.cols,
      rows: params.rows,
      data: (_terminal, chunk) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(chunk);
        }
      },
    });
    let proc;
    try {
      proc = Bun.spawn(command, {
        terminal,
        cwd: spec?.cwd ?? process.cwd(),
        env: spec?.env ?? process.env,
      });
    } catch (error) {
      try {
        terminal.close();
      } catch {}
      failClose(`PTY hijack spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const session = {
      dispose: () => {
        try {
          proc.kill();
        } catch {}
        try {
          terminal.close();
        } catch {}
      },
    };
    this.ptySessions.add(session);
    emitGatewayLog(
      "info",
      "Gateway PTY hijack session started",
      {
        runId: params.runId,
        nodeId: params.nodeId ?? null,
        pid: proc.pid,
      },
      "gateway:pty-hijack",
    );
    void proc.exited.then((code) => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "exit", code }));
        } catch {}
        try {
          ws.close(1000, "process exited");
        } catch {}
      }
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        terminal.write(new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(/** @type {ArrayBuffer} */ (data))));
        return;
      }
      // Text frames are JSON control messages; unknown types are ignored
      // for forward compatibility (mirrors the cloud terminal client).
      try {
        const message = JSON.parse(String(data));
        if (message && message.type === "resize") {
          const cols = clampPtyDimension(String(message.cols), 0);
          const rows = clampPtyDimension(String(message.rows), 0);
          if (cols >= PTY_MIN_DIMENSION && rows >= PTY_MIN_DIMENSION) {
            terminal.resize(cols, rows);
          }
        }
      } catch {}
    });
    const teardown = () => {
      if (!this.ptySessions.has(session)) {
        return;
      }
      this.ptySessions.delete(session);
      session.dispose();
    };
    ws.on("close", teardown);
    ws.on("error", teardown);
  }
  /**
   * @param {{ port?: number; host?: string; path?: string }} [options]
   */
  async listen(options = {}) {
    if (this.server) {
      return this.server;
    }
    const wsServer = new WebSocketServer({
      noServer: true,
      maxPayload: this.maxPayload,
    });
    wsServer.on("headers", (headers) => {
      headers.push(`X-Smithers-API-Version: ${SMITHERS_API_VERSION}`);
    });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const webhookMatch = url.pathname.match(/^\/webhooks\/([^/]+)$/);
      const rpcMatch = url.pathname.match(/^\/v1\/rpc\/([^/]+)$/);
      if ((req.method ?? "GET") === "GET" && (req.url ?? "/") === "/health") {
        return sendJson(res, 200, {
          ok: true,
          protocol: this.protocol,
          features: this.features,
          stateVersion: this.stateVersion,
          identity: this.buildIdentity(),
          ...this.workflowRegistryProgress(),
        });
      }
      if ((req.method ?? "GET") === "GET" && (req.url ?? "/") === "/metrics") {
        return sendText(res, 200, renderPrometheusMetrics(), prometheusContentType);
      }
      if ((req.method ?? "GET") === "GET" && (req.url ?? "/") === "/workflows") {
        await this.awaitWorkflowRegistryReady();
        return sendJson(res, 200, {
          workflows: this.listWorkflowSummaries(undefined),
        });
      }
      if ((req.method ?? "GET") === "GET" && url.pathname === "/v1/auth/session") {
        return this.handleAuthSession(req, res);
      }
      if ((req.method ?? "GET") === "POST" && webhookMatch) {
        return this.handleWebhook(req, res, decodeURIComponent(webhookMatch[1]));
      }
      if ((req.method ?? "GET") === "GET" && url.pathname === "/v1/api/stream") {
        return this.handleApiStream(req, res);
      }
      if (url.pathname === "/v1/api" || url.pathname.startsWith("/v1/api/")) {
        return this.handleHttpApi(req, res);
      }
      if ((req.method ?? "GET") === "POST" && rpcMatch) {
        return this.handleHttpRpc(req, res, decodeURIComponent(rpcMatch[1]));
      }
      if ((req.method ?? "GET") === "POST" && url.pathname === "/v1/electric/write") {
        return this.handleElectricWrite(req, res);
      }
      if ((req.method ?? "GET") === "POST" && (req.url ?? "/") === "/rpc") {
        return this.handleHttpRpc(req, res);
      }
      if (await this.handleUiHttp(req, res)) {
        return;
      }
      if (this.routes && (await this.routes(req, res, { gateway: this, url }))) {
        return;
      }
      if ((req.method ?? "GET") === "GET" && url.pathname === "/") {
        return this.handleRootRequest(req, res);
      }
      return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    });
    server.headersTimeout = this.headersTimeout;
    server.requestTimeout = this.requestTimeout;
    server.on("upgrade", (req, socket, head) => {
      // Pre-auth sockets are accounted separately from authenticated
      // connections (#1008): a new upgrade needs a free slot in the
      // bounded pre-auth pool, and is turned away early when the
      // authenticated pool is already full (its `connect` could never
      // be promoted anyway).
      const authenticatedFull = this.authenticatedConnectionCount() >= this.maxConnections;
      if (authenticatedFull || this.preAuthConnections.size >= this.maxPreAuthConnections) {
        emitGatewayEffect(
          incrementMetric(gatewayErrorsTotal, {
            kind: authenticatedFull ? "connection_limit" : "preauth_connection_limit",
            transport: "ws",
          }),
        );
        emitGatewayLog(
          "warning",
          "Gateway connection rejected",
          {
            transport: "ws",
            remoteAddress: req.socket.remoteAddress ?? null,
            maxConnections: this.maxConnections,
            maxPreAuthConnections: this.maxPreAuthConnections,
            preAuthConnections: this.preAuthConnections.size,
          },
          "gateway:connect",
        );
        const body = "Gateway connection limit reached\n";
        socket.end(
          "HTTP/1.1 503 Service Unavailable\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            `X-Smithers-API-Version: ${SMITHERS_API_VERSION}\r\n` +
            `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
            "\r\n" +
            body,
        );
        return;
      }
      // Reject a disallowed browser Origin at the upgrade itself, before
      // `handleUpgrade` opens the socket — otherwise a drive-by page could
      // open and hold connections (consuming maxConnections) by never
      // sending the `connect` RPC. (#446)
      // The ambient session cookie is SameSite=Lax, so a same-site sibling
      // origin's page can drive this upgrade with the browser attaching the
      // cookie; reject a cross-origin cookie-only upgrade even when the
      // allow-list is empty. Explicit-token WS clients are unaffected.
      const cookieOriginRejected = !!this.auth && requestUsesAmbientCookieAuth(req) && !this.isCookieOriginTrusted(req);
      if (!this.isRequestOriginAllowed(req) || !this.isHostAllowed(req) || cookieOriginRejected) {
        emitGatewayEffect(
          incrementMetric(gatewayErrorsTotal, {
            kind: "auth",
            transport: "ws",
          }),
        );
        emitGatewayLog(
          "warning",
          "Gateway WS upgrade rejected: origin or host not allowed",
          {
            transport: "ws",
            remoteAddress: req.socket.remoteAddress ?? null,
            origin: asString(req.headers.origin) ?? null,
            host: asString(req.headers.host) ?? null,
          },
          "gateway:connect",
        );
        const body = "Origin or host is not allowed\n";
        // end() (not write()+destroy()) so the response is flushed to the
        // peer before the socket closes — a bare destroy can RST away the
        // unsent bytes, leaving the client with no status.
        socket.end(
          "HTTP/1.1 403 Forbidden\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            `X-Smithers-API-Version: ${SMITHERS_API_VERSION}\r\n` +
            `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
            "\r\n" +
            body,
        );
        return;
      }
      // PTY hijack channel: same listener, same Origin/Host rejection as
      // the RPC websocket above (a drive-by page must never reach a
      // shell), then its own auth + spawn path instead of the RPC loop.
      const upgradeUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (upgradeUrl.pathname === PTY_HIJACK_PATH) {
        void this.handlePtyHijackUpgrade(req, socket, head, wsServer, upgradeUrl).catch((error) => {
          emitGatewayLog(
            "warning",
            "Gateway PTY hijack upgrade failed",
            {
              ...gatewayErrorAnnotations(error),
            },
            "gateway:pty-hijack",
          );
          try {
            socket.destroy();
          } catch {}
        });
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        this.handleSocket(ws, req);
      });
    });
    await new Promise((resolve, reject) => {
      // Without this, EADDRINUSE (and any other bind failure) surfaces as
      // an unhandled 'error' event that crashes the process; callers must
      // be able to catch it and retry on another port.
      const onError = (error) => reject(error);
      server.once("error", onError);
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(undefined);
      };
      if (options.path !== undefined) {
        server.listen(options.path, onListening);
        return;
      }
      if (options.host === undefined) {
        server.listen(options.port ?? 7331, onListening);
        return;
      }
      server.listen(options.port ?? 7331, options.host, onListening);
    });
    // Post-listen socket errors must not crash the daemon either.
    server.on("error", (error) => {
      console.warn(`[gateway] http server error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.server = server;
    this.wsServer = wsServer;
    await this.syncRegisteredSchedules();
    this.startScheduler();
    this.startOutOfProcessEventBridge();
    this.lastActivityMs = nowMs();
    this.startIdleMonitor();
    // Durability seam: when a tickets directory is configured, watch its
    // `*.md` docs and upsert them into `_smithers_docs` (file → DB,
    // last-write-wins). A hiccup here never fails `listen()`.
    const ticketsDir = process.env.SMITHERS_TICKETS_DIR;
    if (ticketsDir) {
      try {
        this.watchTicketsDirectory(ticketsDir);
      } catch (error) {
        console.warn(
          `[gateway] tickets watcher (${ticketsDir}) failed to start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return server;
  }
  async close() {
    this.stopIdleMonitor();
    for (const session of this.ptySessions) {
      session.dispose();
    }
    this.ptySessions.clear();
    const activeRuns = [...this.activeRuns.values()];
    for (const activeRun of activeRuns) {
      activeRun.abort.abort();
    }
    const inflightRuns = [...this.inflightRuns.values()];
    if (inflightRuns.length > 0) {
      await Promise.allSettled(inflightRuns);
    }
    for (const connection of this.connections) {
      // Fence any subscribe handler still awaiting resolveRun(), then
      // synchronously release every run-event cap slot before closing the
      // socket. The later WS close callback is idempotent.
      connection.closed = true;
      if (connection.heartbeatTimer) {
        clearInterval(connection.heartbeatTimer);
      }
      this.cleanupRunEventSubscribers(connection);
      if (connection.authDeadlineTimer) {
        clearTimeout(connection.authDeadlineTimer);
        connection.authDeadlineTimer = null;
      }
      try {
        connection.ws.close();
      } catch {}
    }
    this.connections.clear();
    this.preAuthConnections.clear();
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    for (const timer of this.terminalRunEventWindowTimers.values()) {
      clearTimeout(timer);
    }
    this.terminalRunEventWindowTimers.clear();
    if (this.apiStreamFlushTimer) {
      clearTimeout(this.apiStreamFlushTimer);
      this.apiStreamFlushTimer = null;
    }
    if (this.apiStreamHeartbeatTimer) {
      clearInterval(this.apiStreamHeartbeatTimer);
      this.apiStreamHeartbeatTimer = null;
    }
    for (const subscriber of this.apiStreamSubscribers) {
      subscriber.closed = true;
      try {
        subscriber.res.end();
      } catch {}
    }
    this.apiStreamSubscribers.clear();
    this.apiStreamSubscribersByUser.clear();
    this.apiStreamSubscribersByConnection.clear();
    // Durability seam teardown: close every `_smithers_docs` file-watcher
    // (`fs.watch` handles) started via `watchTicketsDirectory`, so a closed
    // gateway never leaks watchers (e.g. across e2e boots or test runs).
    if (this.ticketWatchers) {
      for (const watcher of this.ticketWatchers.values()) {
        try {
          watcher.close();
        } catch {}
      }
      this.ticketWatchers.clear();
      this.ticketWatchers = null;
    }
    this.stopOutOfProcessEventBridge();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };
        const timeout = setTimeout(done, 250);
        timeout.unref?.();
        server.close(() => {
          clearTimeout(timeout);
          done();
        });
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
    }
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }
    await this.browser.shutdown?.();
  }
  startScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
    }
    const intervalMs = Math.max(1_000, Math.min(this.heartbeatMs, 15_000));
    this.schedulerTimer = setInterval(() => {
      void this.processDueCrons();
      void this.processDueTimers();
    }, intervalMs);
  }
  /**
   * Record client activity for idle spin-down (spec decision 14). Called on
   * every RPC (HTTP + WS) and on each new WS connection. If the daemon had
   * already fired onIdle but a client came back, re-arm the monitor.
   */
  markActivity() {
    this.lastActivityMs = nowMs();
    if (this.idleFired) {
      this.idleFired = false;
      this.startIdleMonitor();
    }
  }
  /**
   * Whether the daemon has nothing to do: no attached WS clients, no in-flight
   * runs, and no registered crons or pending durable timers. Schedules count as
   * "busy" so an autostarted daemon that owns a schedule does not idle-exit and
   * silently stop firing it.
   * @returns {boolean}
   */
  isIdle() {
    return (
      this.connections.size === 0 &&
      this.activeRuns.size === 0 &&
      this.inflightRuns.size === 0 &&
      !this.hasActiveCrons &&
      !this.hasPendingTimers
    );
  }
  startIdleMonitor() {
    this.stopIdleMonitor();
    if (!(this.idleTimeoutMs > 0) || typeof this.onIdle !== "function") {
      return;
    }
    const checkMs = Math.max(1_000, Math.min(this.idleTimeoutMs, 30_000));
    this.idleTimer = setInterval(() => {
      void this.checkIdle();
    }, checkMs);
    this.idleTimer.unref?.();
  }
  stopIdleMonitor() {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }
  async checkIdle() {
    if (!(this.idleTimeoutMs > 0) || typeof this.onIdle !== "function") {
      return;
    }
    if (this.idleFired || !this.isIdle()) {
      return;
    }
    if (nowMs() - this.lastActivityMs < this.idleTimeoutMs) {
      return;
    }
    // Final synchronous re-check right before firing so a client that
    // attached between the interval tick and here is not stranded.
    if (!this.isIdle()) {
      return;
    }
    this.idleFired = true;
    this.stopIdleMonitor();
    try {
      await this.onIdle?.();
    } catch (error) {
      emitGatewayLog("warning", "Gateway onIdle handler failed", { error: errorToJson(error) }, "gateway:idle");
    }
  }
  startOutOfProcessEventBridge() {
    this.stopOutOfProcessEventBridge();
    if (!this.outOfProcessEventBridge) {
      return;
    }
    this.outOfProcessEventBridgeStopped = false;
    const loop = () => {
      if (this.outOfProcessEventBridgeStopped) {
        return;
      }
      void this.pollOutOfProcessRunEvents()
        .catch((error) => {
          emitGatewayLog(
            "warning",
            "Out-of-process event bridge poll failed",
            {
              error: errorToJson(error),
            },
            "gateway:events",
          );
        })
        .finally(() => {
          if (!this.outOfProcessEventBridgeStopped) {
            this.outOfProcessEventBridgeTimer = setTimeout(loop, this.outOfProcessEventBridgePollMs);
            this.outOfProcessEventBridgeTimer.unref?.();
          }
        });
    };
    loop();
  }
  stopOutOfProcessEventBridge() {
    this.outOfProcessEventBridgeStopped = true;
    if (this.outOfProcessEventBridgeTimer) {
      clearTimeout(this.outOfProcessEventBridgeTimer);
      this.outOfProcessEventBridgeTimer = null;
    }
    this.outOfProcessEventBridgeLastFedSeq.clear();
    this.outOfProcessEventBridgeDrainedRuns.clear();
  }
  async pollOutOfProcessRunEvents() {
    const seenAdapters = new Set();
    const liveRunIds = new Set();
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      if (seenAdapters.has(adapter)) {
        continue;
      }
      seenAdapters.add(adapter);
      const runs = await adapter.listRuns(1_000);
      for (const run of runs) {
        const runId = asString(run.runId);
        if (!runId) {
          continue;
        }
        liveRunIds.add(runId);
        if (this.outOfProcessEventBridgeDrainedRuns.has(runId)) {
          continue;
        }
        const terminal = TERMINAL_RUN_STATUSES.has(asString(run.status) ?? "");
        await this.feedOutOfProcessRunEvents(adapter, runId, terminal);
      }
    }
    for (const runId of [...this.outOfProcessEventBridgeDrainedRuns]) {
      if (!liveRunIds.has(runId)) {
        this.outOfProcessEventBridgeDrainedRuns.delete(runId);
      }
    }
    for (const runId of [...this.outOfProcessEventBridgeLastFedSeq.keys()]) {
      if (!liveRunIds.has(runId)) {
        this.outOfProcessEventBridgeLastFedSeq.delete(runId);
      }
    }
  }
  async feedOutOfProcessRunEvents(adapter, runId, terminal) {
    if (this.runRegistry.has(runId)) {
      this.outOfProcessEventBridgeDrainedRuns.add(runId);
      this.outOfProcessEventBridgeLastFedSeq.delete(runId);
      return;
    }
    let afterSeq = this.outOfProcessEventBridgeLastFedSeq.get(runId) ?? -1;
    for (;;) {
      const rows = await adapter.listEventHistory(runId, {
        afterSeq,
        limit: OUT_OF_PROCESS_EVENT_BRIDGE_PAGE_LIMIT,
      });
      let maxSeq = afterSeq;
      for (const row of rows) {
        const seq = typeof row.seq === "number" ? row.seq : Number(row.seq);
        if (Number.isFinite(seq) && seq > maxSeq) {
          maxSeq = seq;
        }
        const payloadJson =
          typeof row.payloadJson === "string"
            ? row.payloadJson
            : typeof row.payload_json === "string"
              ? row.payload_json
              : undefined;
        if (!payloadJson) {
          continue;
        }
        try {
          this.handleSmithersEvent(JSON.parse(payloadJson));
        } catch {
          continue;
        }
      }
      const advanced = maxSeq > afterSeq;
      if (advanced) {
        afterSeq = maxSeq;
        this.outOfProcessEventBridgeLastFedSeq.set(runId, maxSeq);
      }
      if (!terminal || rows.length < OUT_OF_PROCESS_EVENT_BRIDGE_PAGE_LIMIT || !advanced) {
        break;
      }
    }
    if (terminal) {
      this.outOfProcessEventBridgeDrainedRuns.add(runId);
      this.markRunEventWindowTerminal(runId);
    }
  }
  async syncRegisteredSchedules() {
    for (const entry of this.workflows.values()) {
      if (!entry.schedule) {
        continue;
      }
      const adapter = this.adapterForWorkflow(entry.workflow);
      await adapter.upsertCron({
        cronId: `gateway:${entry.key}`,
        pattern: entry.schedule,
        workflowPath: cronWorkflowPath(entry.key),
        enabled: true,
        createdAtMs: nowMs(),
        lastRunAtMs: null,
        nextRunAtMs: nextCronRunAtMs(entry.schedule),
        errorJson: null,
      });
    }
  }
  async processDueCrons() {
    if (this.cronSweepInFlight) {
      return;
    }
    this.cronSweepInFlight = true;
    try {
      const now = nowMs();
      // Refresh the idle-spin-down keep-alive signal every tick (decision 14):
      // a daemon that owns any cron must not idle-exit and stop firing it.
      this.hasActiveCrons = false;
      emitGatewayLog(
        "debug",
        "Gateway cron evaluation tick",
        {
          workflowCount: this.workflows.size,
        },
        "gateway:cron",
      );
      for (const entry of this.workflows.values()) {
        const adapter = this.adapterForWorkflow(entry.workflow);
        const crons = await adapter.listCrons(true);
        if (crons.length > 0) {
          this.hasActiveCrons = true;
        }
        for (const cron of crons) {
          const workflowKey = workflowKeyFromCronPath(cron.workflowPath);
          if (!workflowKey || workflowKey !== entry.key) {
            continue;
          }
          if (typeof cron.nextRunAtMs === "number" && cron.nextRunAtMs > now) {
            emitGatewayLog(
              "debug",
              "Gateway cron skipped",
              {
                cronId: cron.cronId,
                workflow: workflowKey,
                nextRunAtMs: cron.nextRunAtMs,
              },
              "gateway:cron",
            );
            continue;
          }
          try {
            // Parse before any side effect: an invalid pattern must
            // never start a run, and persisting the advanced
            // schedule before startRun keeps a concurrent scheduler
            // sharing this DB from firing the same cron twice.
            const nextRunAtMs = nextCronRunAtMs(cron.pattern);
            const claimed = await adapter.claimCronRun(cron.cronId, cron.nextRunAtMs ?? null, now, nextRunAtMs);
            if (!claimed) {
              emitGatewayLog(
                "debug",
                "Gateway cron already claimed",
                {
                  cronId: cron.cronId,
                  workflow: workflowKey,
                },
                "gateway:cron",
              );
              continue;
            }
            const run = await this.startRun(
              workflowKey,
              {},
              {
                triggeredBy: "cron:gateway",
                scopes: ["*"],
                role: "system",
              },
            );
            emitGatewayEffect(
              incrementMetric(gatewayCronTriggersTotal, {
                source: "scheduled",
              }),
            );
            emitGatewayLog(
              "info",
              "Gateway cron triggered",
              {
                cronId: cron.cronId,
                workflow: workflowKey,
                runId: run.runId,
              },
              "gateway:cron",
            );
            this.broadcastEvent("cron.triggered", {
              cronId: cron.cronId,
              workflow: workflowKey,
              runId: run.runId,
            });
          } catch (error) {
            emitGatewayEffect(
              incrementMetric(gatewayErrorsTotal, {
                kind: "cron",
                code: gatewayErrorCode(error),
              }),
            );
            emitGatewayLog(
              "error",
              "Gateway cron trigger failed",
              {
                cronId: cron.cronId,
                workflow: workflowKey,
                ...gatewayErrorAnnotations(error),
              },
              "gateway:cron",
            );
            // Always park the retry in the future; re-persisting a
            // stale past nextRunAtMs re-fires the broken cron on
            // every sweep.
            await adapter.updateCronRunTime(cron.cronId, now, now + 60_000, error?.message ?? "cron trigger failed");
          }
        }
      }
    } finally {
      this.cronSweepInFlight = false;
    }
  }
  /**
   * Earliest fire time across a run's still-pending timer nodes, or null when the
   * run has no timer waiting to fire. Lets the scheduler tick decide when a
   * torn-down `waiting-timer` run is due to resume without re-driving it blindly.
   * @param {SmithersDb} adapter
   * @param {string} runId
   * @returns {Promise<number | null>}
   */
  async runTimerDueAtMs(adapter, runId) {
    const nodes = await adapter.listNodes(runId);
    let earliest = null;
    for (const node of nodes) {
      if (node.state !== "waiting-timer") {
        continue;
      }
      const iteration = node.iteration ?? 0;
      const attempts = await runPromise(adapter.listAttempts(runId, node.nodeId, iteration));
      const waitingAttempt = attempts.find((attempt) => attempt.state === "waiting-timer") ?? attempts[0];
      const firesAtMs = parseTimerFiresAtMs(waitingAttempt?.metaJson);
      if (firesAtMs === null) {
        continue;
      }
      if (earliest === null || firesAtMs < earliest) {
        earliest = firesAtMs;
      }
    }
    return earliest;
  }
  /**
   * Wake suspended timer runs whose fire time has passed. The engine releases the
   * worker when a `<Timer>` starts waiting, persisting only the fire time, so this
   * sweep is what resumes the run on its own without a live process holding CPU.
   * Mirrors `processDueCrons`: one pass per shared DB, attribute each run to its
   * true workflow key, and let `resumeRunIfNeeded` re-acquire the durable lease.
   * @returns {Promise<void>}
   */
  async processDueTimers() {
    if (this.timerSweepInFlight) {
      return;
    }
    this.timerSweepInFlight = true;
    try {
      const now = nowMs();
      // Refresh the idle keep-alive signal: a pending durable timer must
      // keep an autostarted daemon alive so the sweep can resume it.
      this.hasPendingTimers = false;
      const registeredKeys = new Set(this.workflows.keys());
      const seenAdapters = new Set();
      for (const entry of this.workflows.values()) {
        const adapter = this.adapterForWorkflow(entry.workflow);
        // Shared-DB workflows share an adapter; sweep each DB exactly once.
        if (seenAdapters.has(adapter)) {
          continue;
        }
        seenAdapters.add(adapter);
        let waitingRuns;
        try {
          const waitingRunsById = new Map();
          for (const status of ["waiting-timer", "waiting-approval", "waiting-event"]) {
            for (const run of await adapter.listRuns(1_000, status)) {
              if (!waitingRunsById.has(run.runId)) {
                waitingRunsById.set(run.runId, run);
              }
            }
          }
          waitingRuns = [...waitingRunsById.values()];
        } catch (error) {
          emitGatewayLog(
            "error",
            "Gateway timer sweep failed to list runs",
            {
              ...gatewayErrorAnnotations(error),
            },
            "gateway:timer",
          );
          continue;
        }
        for (const run of waitingRuns) {
          const workflowKey = this.resolveRunWorkflowKey(run, registeredKeys, entry.key);
          try {
            const dueAtMs = await this.runTimerDueAtMs(adapter, run.runId);
            if (dueAtMs === null) {
              continue;
            }
            this.hasPendingTimers = true;
            if (this.activeRuns.has(run.runId) || dueAtMs > now) {
              continue;
            }
            await this.resumeRunIfNeeded(run.runId, workflowKey, adapter, {
              triggeredBy: "timer:gateway",
              scopes: ["*"],
              role: "system",
            });
            emitGatewayLog(
              "info",
              "Gateway timer resumed run",
              {
                runId: run.runId,
                workflow: workflowKey,
                dueAtMs,
              },
              "gateway:timer",
            );
          } catch (error) {
            emitGatewayEffect(
              incrementMetric(gatewayErrorsTotal, {
                kind: "timer",
                code: gatewayErrorCode(error),
              }),
            );
            emitGatewayLog(
              "error",
              "Gateway timer resume failed",
              {
                runId: run.runId,
                workflow: workflowKey,
                ...gatewayErrorAnnotations(error),
              },
              "gateway:timer",
            );
          }
        }
        // Quota-blocked runs (a provider usage/session limit) park as
        // `waiting-quota` with the reset time on their errorJson. Resume
        // them the same way once the limit window has elapsed. Runs
        // without a known reset (credit exhaustion) are left for a human.
        let quotaRuns;
        try {
          quotaRuns = await adapter.listRuns(1_000, "waiting-quota");
          // Only finite-reset quota runs will ever be auto-resumed;
          // no-reset runs (credit exhaustion) are left for a human, so
          // keeping the daemon awake for them pins an autostarted
          // daemon alive forever and defeats idle spin-down.
          if (quotaRuns.some((run) => parseQuotaResetAtMs(run.errorJson) !== null)) {
            this.hasPendingTimers = true;
          }
        } catch (error) {
          emitGatewayLog(
            "error",
            "Gateway quota sweep failed to list runs",
            {
              ...gatewayErrorAnnotations(error),
            },
            "gateway:timer",
          );
          continue;
        }
        for (const run of quotaRuns) {
          if (this.activeRuns.has(run.runId)) {
            continue;
          }
          const resetAtMs = parseQuotaResetAtMs(run.errorJson);
          if (resetAtMs === null || resetAtMs > now) {
            continue;
          }
          const workflowKey = this.resolveRunWorkflowKey(run, registeredKeys, entry.key);
          try {
            await this.resumeRunIfNeeded(run.runId, workflowKey, adapter, {
              triggeredBy: "timer:gateway",
              scopes: ["*"],
              role: "system",
            });
            emitGatewayLog(
              "info",
              "Gateway quota reset resumed run",
              {
                runId: run.runId,
                workflow: workflowKey,
                resetAtMs,
              },
              "gateway:timer",
            );
          } catch (error) {
            emitGatewayEffect(
              incrementMetric(gatewayErrorsTotal, {
                kind: "timer",
                code: gatewayErrorCode(error),
              }),
            );
            emitGatewayLog(
              "error",
              "Gateway quota resume failed",
              {
                runId: run.runId,
                workflow: workflowKey,
                ...gatewayErrorAnnotations(error),
              },
              "gateway:timer",
            );
          }
        }
      }
    } finally {
      this.timerSweepInFlight = false;
    }
  }
  /**
   * @param {string} workflowKey
   * @param {Record<string, unknown>} input
   * @param {RunStartAuthContext} auth
   * @param {string} [runId]
   * @param {{ resume?: boolean; maxConcurrency?: number; allowNetwork?: boolean; maxOutputBytes?: number; toolTimeoutMs?: number; startedBy?: import("@smithers-orchestrator/driver/RunStartedBy").RunStartedBy }} [options]
   */
  async startRun(workflowKey, input, auth, runId = crypto.randomUUID(), options) {
    const entry = this.workflows.get(workflowKey);
    if (!entry) {
      throw new Error(`Unknown workflow: ${workflowKey}`);
    }
    // Idempotency guard: `launchRun` lets a client supply `params.runId`, so
    // refuse to start a NEW run over one already live. Reusing an active id
    // would overwrite its in-memory record in `runRegistry`/`activeRuns` and
    // orphan the still-running run — its AbortController becomes unreachable,
    // so it can no longer be cancelled or tracked. Resume intentionally
    // re-targets an existing run and is exempt.
    if (!options?.resume && this.activeRuns.has(runId)) {
      throw new SmithersError("CONFLICT", `Run ${runId} is already active`, {
        runId,
        workflow: workflowKey,
      });
    }
    // New-run admission remains synchronous through the in-memory reservation
    // below, preserving the duplicate-id race guard. Resume may read the
    // durable stamp because concurrent resumes are serialized by
    // `resumeRunIfNeeded` before they reach this method.
    const storedRun = options?.resume ? await this.adapterForWorkflow(entry.workflow).getRun(runId) : undefined;
    const system = options?.resume ? runSystemFromRow(storedRun) : Boolean(entry.system);
    const abort = new AbortController();
    const record = {
      workflowKey,
      workflow: entry.workflow,
      abort,
      input,
    };
    this.runRegistry.set(runId, record);
    this.activeRuns.set(runId, record);
    emitGatewayEffect(
      Effect.all(
        [
          incrementMetric(gatewayRunsStartedTotal, {
            workflow: workflowKey,
            source: gatewayTriggerSource(auth.triggeredBy),
            resume: options?.resume ? "true" : "false",
          }),
          Effect.logInfo("Gateway run started").pipe(
            Effect.annotateLogs({
              workflow: workflowKey,
              runId,
              triggeredBy: auth.triggeredBy,
              source: gatewayTriggerSource(auth.triggeredBy),
              resume: options?.resume ?? false,
              ...(auth.tokenId ? { tokenId: auth.tokenId } : {}),
              ...(auth.subscribeConnection ? gatewayContextAnnotations(auth.subscribeConnection) : {}),
            }),
            Effect.withLogSpan("gateway:run"),
          ),
        ],
        { discard: true },
      ),
    );
    if (auth.subscribeConnection) {
      if (!auth.subscribeConnection.subscribedRuns) {
        auth.subscribeConnection.subscribedRuns = new Set();
      }
      auth.subscribeConnection.subscribedRuns.add(runId);
    }
    const { runWorkflow } = await loadEngineRuntime();
    const runPromise = Effect.runPromise(
      runWorkflow(entry.workflow, {
        runId,
        input,
        resume: options?.resume,
        // The registered entry's source file. On resume this is what lets
        // the engine recompute the durability hashes and match the run's
        // recorded metadata — without it a gateway-driven resume (approval
        // decided from a monitor while the detached engine is parked) fails
        // RESUME_METADATA_MISMATCH ("module graph unavailable") and the run
        // stays waiting forever.
        ...(entry.entryFile ? { workflowPath: entry.entryFile } : {}),
        maxConcurrency: options?.maxConcurrency,
        allowNetwork: options?.allowNetwork,
        maxOutputBytes: options?.maxOutputBytes,
        toolTimeoutMs: options?.toolTimeoutMs,
        startedBy: options?.startedBy,
        signal: abort.signal,
        onProgress: (event) => this.handleSmithersEvent(event),
        cliAgentToolsDefault: this.defaults?.cliAgentTools,
        config: {
          gatewayWorkflowKey: workflowKey,
          gatewayTriggeredBy: auth.triggeredBy,
          // Resume deliberately omits the field: the engine merges the stored
          // config first, preserving the creation-time value across manifest
          // reclassification. Historical unstamped runs remain unstamped and
          // therefore fail closed in listings.
          ...(!options?.resume ? { gatewaySystem: system } : {}),
        },
        auth: {
          triggeredBy: auth.triggeredBy,
          scopes: [...auth.scopes],
          role: auth.role,
          tokenId: auth.tokenId ?? null,
          createdAt: new Date().toISOString(),
        },
      }),
    )
      .catch((error) => {
        emitGatewayEffect(
          Effect.all(
            [
              incrementMetric(gatewayErrorsTotal, {
                kind: "run",
                workflow: workflowKey,
                code: gatewayErrorCode(error),
              }),
              incrementMetric(gatewayRunsCompletedTotal, {
                workflow: workflowKey,
                status: "failed",
              }),
              Effect.logError("Gateway run failed").pipe(
                Effect.annotateLogs({
                  workflow: workflowKey,
                  runId,
                  source: gatewayTriggerSource(auth.triggeredBy),
                  ...gatewayErrorAnnotations(error),
                }),
                Effect.withLogSpan("gateway:run"),
              ),
            ],
            { discard: true },
          ),
        );
        this.broadcastEvent("run.completed", {
          runId,
          status: "failed",
          error: errorToJson(error),
        });
        throw error;
      })
      .then((result) => {
        if (result.status === "finished" || result.status === "failed" || result.status === "cancelled") {
          emitGatewayEffect(
            Effect.all(
              [
                incrementMetric(gatewayRunsCompletedTotal, {
                  workflow: workflowKey,
                  status: result.status,
                }),
                Effect.logInfo("Gateway run completed").pipe(
                  Effect.annotateLogs({
                    workflow: workflowKey,
                    runId,
                    status: result.status,
                    source: gatewayTriggerSource(auth.triggeredBy),
                    ...(result.error ? { error: result.error } : {}),
                  }),
                  Effect.withLogSpan("gateway:run"),
                ),
              ],
              { discard: true },
            ),
          );
          this.broadcastEvent("run.completed", {
            runId,
            status: result.status,
            error: result.error,
            ...(result.failedChildren > 0
              ? {
                  failedChildren: result.failedChildren,
                  failedChildKeys: Array.isArray(result.failedChildKeys) ? result.failedChildKeys : [],
                }
              : {}),
          });
        }
      });
    const cleanupOwnedRun = () => {
      if (this.runRegistry.get(runId) === record) {
        this.runRegistry.delete(runId);
      }
      if (this.activeRuns.get(runId) === record) {
        this.activeRuns.delete(runId);
      }
      if (this.inflightRuns.get(runId) === inflightPromise) {
        this.inflightRuns.delete(runId);
      }
    };
    const inflightPromise = runPromise.then(cleanupOwnedRun, cleanupOwnedRun);
    this.inflightRuns.set(runId, inflightPromise);
    return { runId, workflow: workflowKey, system };
  }
  /**
   * @param {string} runId
   * @param {string} workflowKey
   * @param {SmithersDb} adapter
   * @param {RunStartAuthContext} auth
   */
  async resumeRunIfNeeded(runId, workflowKey, adapter, auth) {
    const existingResume = this.inflightResumes.get(runId);
    if (existingResume) {
      await existingResume;
      return;
    }
    const resumePromise = (async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (this.activeRuns.has(runId)) {
          await delay(25);
          continue;
        }
        const run = await adapter.getRun(runId);
        if (!run) {
          return;
        }
        if (run.status === "finished" || run.status === "failed" || run.status === "cancelled") {
          return;
        }
        await this.startRun(workflowKey, {}, auth, runId, { resume: true });
        return;
      }
    })();
    this.inflightResumes.set(runId, resumePromise);
    try {
      await resumePromise;
    } finally {
      if (this.inflightResumes.get(runId) === resumePromise) {
        this.inflightResumes.delete(runId);
      }
    }
  }
  /**
   * @param {string} runId
   * @param {string} workflowKey
   * @param {SmithersDb} adapter
   * @param {RunStartAuthContext} auth
   */
  resumeRunInBackground(runId, workflowKey, adapter, auth) {
    void this.resumeRunIfNeeded(runId, workflowKey, adapter, auth).catch((error) => {
      emitGatewayEffect(
        Effect.all(
          [
            incrementMetric(gatewayErrorsTotal, {
              kind: "run",
              workflow: workflowKey,
              code: gatewayErrorCode(error),
            }),
            Effect.logError("Gateway background resume failed").pipe(
              Effect.annotateLogs({
                workflow: workflowKey,
                runId,
                source: gatewayTriggerSource(auth.triggeredBy),
                ...gatewayErrorAnnotations(error),
              }),
              Effect.withLogSpan("gateway:run"),
            ),
          ],
          { discard: true },
        ),
      );
    });
  }
  /**
   * Authenticated WS connection count. `connections` holds every open RPC
   * websocket while `preAuthConnections` tracks the subset still awaiting a
   * successful `connect`, so the difference is the authenticated pool that
   * `maxConnections` bounds (#1008).
   * @returns {number}
   */
  authenticatedConnectionCount() {
    return this.connections.size - this.preAuthConnections.size;
  }
  /**
   * @param {WebSocket} ws
   * @param {IncomingMessage} req
   */
  handleSocket(ws, req) {
    const connection = {
      connectionId: randomUUID(),
      transport: "ws",
      ws,
      seq: 0,
      closed: false,
      authenticated: false,
      sessionToken: null,
      role: null,
      scopes: [],
      userId: null,
      tokenId: null,
      subscribedRuns: null,
      devtoolsStreams: new Map(),
      heartbeatTimer: null,
      runEventHeartbeatTimer: null,
      authDeadlineTimer: null,
      eventWriter: null,
    };
    this.connections.add(connection);
    // A fresh socket occupies a bounded pre-auth slot until a successful
    // `connect` promotes it into authenticated capacity (#1008).
    this.preAuthConnections.add(connection);
    this.markActivity();
    emitGatewayEffect(
      Effect.all(
        [
          incrementMetric(gatewayConnectionsTotal, { transport: "ws" }),
          updateMetric(gatewayConnectionsActive, 1, { transport: "ws" }),
        ],
        { discard: true },
      ),
    );
    emitGatewayLog(
      "info",
      "Gateway connection opened",
      {
        ...gatewayContextAnnotations(connection),
        remoteAddress: req.socket.remoteAddress ?? null,
        activeConnections: this.connections.size,
      },
      "gateway:connect",
    );
    this.sendEvent(connection, "connect.challenge", {
      nonce: randomUUID(),
      ts: nowMs(),
    });
    // Authentication deadline: the socket holds a `maxConnections` slot
    // from the moment of upgrade, but auth only happens on the `connect`
    // RPC — a silent client could otherwise pin its slot indefinitely.
    // terminate() (not close()) because a peer that never sent `connect`
    // cannot be trusted to finish a close handshake either; terminate
    // destroys the socket immediately, firing the 'close' cleanup that
    // releases the slot. (#1007)
    connection.authDeadlineTimer = setTimeout(() => {
      connection.authDeadlineTimer = null;
      if (connection.authenticated) {
        return;
      }
      emitGatewayEffect(
        incrementMetric(gatewayErrorsTotal, {
          kind: "auth_deadline",
          transport: "ws",
        }),
      );
      emitGatewayLog(
        "warning",
        "Gateway connection closed: authentication deadline exceeded",
        {
          ...gatewayContextAnnotations(connection),
          remoteAddress: req.socket.remoteAddress ?? null,
          authDeadlineMs: this.authDeadlineMs,
        },
        "gateway:connect",
      );
      try {
        ws.terminate();
      } catch {}
    }, this.authDeadlineMs);
    ws.on("message", async (raw) => {
      this.recordMessageReceived("ws", "request");
      /** @type {RequestFrame | undefined} */ let frame;
      try {
        frame = parseGatewayRequestFrame(raw, this.maxPayload);
        const response = await this.executeRpc(connection, frame, async () => {
          if (!connection.authenticated && frame.method !== "connect") {
            return responseError(frame.id, "UNAUTHORIZED", "Connect first");
          }
          if (frame.method === "connect") {
            return this.handleConnect(connection, req, frame.id, frame.params);
          }
          if (!hasScope(connection.scopes, frame.method, this.extensions)) {
            return responseForbidden(frame.id, frame.method, this.extensions);
          }
          return this.routeRequest(connection, frame);
        });
        this.sendResponse(connection, response);
      } catch (error) {
        emitGatewayEffect(
          incrementMetric(gatewayErrorsTotal, {
            kind: "frame",
            transport: "ws",
            code: gatewayErrorCode(error),
          }),
        );
        emitGatewayLog(
          isSmithersError(error) ? "warning" : "error",
          "Gateway websocket frame failed",
          {
            ...gatewayContextAnnotations(connection),
            ...gatewayErrorAnnotations(error),
          },
          "gateway:rpc:invalid",
        );
        if (isSmithersError(error)) {
          this.sendResponse(connection, responseError(frame?.id ?? "invalid", error.code, error.summary));
          return;
        }
        this.sendResponse(
          connection,
          responseError(frame?.id ?? "server", "SERVER_ERROR", error?.message ?? "Gateway request failed"),
        );
      }
    });
    let cleanedUp = false;
    /**
     * @param {"close" | "error"} reason
     * @param {Record<string, unknown>} [details]
     */
    const cleanup = (reason, details = {}) => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      // Set before the cleanup calls below run, so any subscribe handler
      // resuming from an in-flight await after this point can observe
      // that the connection is gone and skip registering onto it (#553).
      connection.closed = true;
      if (connection.heartbeatTimer) {
        clearInterval(connection.heartbeatTimer);
      }
      if (connection.authDeadlineTimer) {
        clearTimeout(connection.authDeadlineTimer);
        connection.authDeadlineTimer = null;
      }
      this.connections.delete(connection);
      // Release whichever accounting the socket holds — the pre-auth
      // slot for a socket that never authenticated, or the
      // authenticated slot otherwise (#1008).
      this.preAuthConnections.delete(connection);
      for (const sessionId of connection.subscribedBrowserSessions ?? []) {
        this.browser.setFrameSubscribers?.(sessionId, this.browserSubscriberCount(sessionId));
      }
      this.cleanupDevToolsSubscribers(connection);
      this.cleanupRunEventSubscribers(connection);
      // Async cleanup runs detached: a malicious or buggy extension
      // cleanup that hangs cannot block the gateway's disconnect path.
      void this.cleanupExtensionSubscriptions(connection);
      emitGatewayEffect(
        Effect.all(
          [
            updateMetric(gatewayConnectionsActive, -1, { transport: "ws" }),
            incrementMetric(gatewayConnectionsClosedTotal, {
              transport: "ws",
              reason,
            }),
            ...(reason === "error"
              ? [
                  incrementMetric(gatewayErrorsTotal, {
                    kind: "socket",
                    transport: "ws",
                  }),
                ]
              : []),
          ],
          { discard: true },
        ),
      );
      emitGatewayLog(
        reason === "error" ? "warning" : "info",
        "Gateway connection closed",
        {
          ...gatewayContextAnnotations(connection),
          activeConnections: this.connections.size,
          closeReason: reason,
          ...details,
        },
        "gateway:connect",
      );
    };
    ws.on("close", (code, reason) => {
      cleanup("close", {
        closeCode: code,
        closeMessage: rawDataToUtf8(reason),
      });
    });
    ws.on("error", (error) => {
      cleanup("error", gatewayErrorAnnotations(error));
    });
  }
  /**
   * @param {ConnectionState} connection
   */
  startHeartbeat(connection) {
    if (connection.heartbeatTimer) {
      clearInterval(connection.heartbeatTimer);
    }
    connection.heartbeatTimer = setInterval(() => {
      emitGatewayEffect(incrementMetric(gatewayHeartbeatTicksTotal));
      this.sendEvent(connection, "tick", {
        ts: nowMs(),
      });
    }, this.heartbeatMs);
  }
  /**
   * @param {ConnectionState} connection
   * @param {IncomingMessage} req
   * @param {string} id
   * @param {unknown} params
   * @returns {Promise<ResponseFrame>}
   */
  async handleConnect(connection, req, id, params) {
    const request = asObject(params);
    if (!request) {
      return responseError(id, "INVALID_REQUEST", "Connect params must be an object");
    }
    if (typeof request.minProtocol !== "number" || typeof request.maxProtocol !== "number" || !request.client) {
      return responseError(id, "INVALID_REQUEST", "Connect request is missing protocol negotiation fields");
    }
    try {
      assertPositiveFiniteInteger("minProtocol", request.minProtocol);
      assertPositiveFiniteInteger("maxProtocol", request.maxProtocol);
    } catch (error) {
      if (error instanceof SmithersError) {
        return responseError(id, error.code, error.summary);
      }
      throw error;
    }
    if (request.minProtocol > this.protocol || request.maxProtocol < this.protocol) {
      return responseError(
        id,
        "PROTOCOL_UNSUPPORTED",
        `Gateway protocol ${this.protocol} is not supported by the client`,
      );
    }
    const authResult = await this.authenticate(req, request);
    if (authResult.ok === false) {
      this.recordAuthEvent("ws", "failure", connection, {
        clientId: request.client.id,
        clientVersion: request.client.version,
        authCode: authResult.code,
        authMessage: authResult.message,
      });
      // Failed authentication releases the pre-auth slot (#1008): close
      // the socket once the error response has flushed instead of
      // letting the client camp on bounded pre-auth capacity and retry
      // indefinitely. setImmediate runs after the microtask that sends
      // the response frame, and ws queues the close frame behind it.
      if (!connection.authenticated) {
        setImmediate(() => {
          try {
            connection.ws.close(1008, "authentication failed");
          } catch {}
        });
      }
      return responseError(id, authResult.code, authResult.message, authResult.details);
    }
    if (connection.authDeadlineTimer) {
      clearTimeout(connection.authDeadlineTimer);
      connection.authDeadlineTimer = null;
    }
    // Promotion (#1008): a successful connect moves this socket from the
    // bounded pre-auth pool into authenticated `maxConnections` capacity.
    // Refuse when the authenticated pool is already full — closing the
    // socket frees the pre-auth slot immediately instead of parking an
    // unbounded queue against authenticated capacity.
    if (this.preAuthConnections.has(connection) && this.authenticatedConnectionCount() >= this.maxConnections) {
      emitGatewayEffect(
        incrementMetric(gatewayErrorsTotal, {
          kind: "connection_limit",
          transport: "ws",
        }),
      );
      emitGatewayLog(
        "warning",
        "Gateway connect rejected: connection limit reached",
        {
          ...gatewayContextAnnotations(connection),
          maxConnections: this.maxConnections,
        },
        "gateway:connect",
      );
      setImmediate(() => {
        try {
          connection.ws.close(1013, "connection limit reached");
        } catch {}
      });
      return responseError(id, "CONNECTION_LIMIT", "Gateway connection limit reached");
    }
    this.preAuthConnections.delete(connection);
    connection.authenticated = true;
    connection.sessionToken = randomUUID();
    connection.role = authResult.role;
    connection.scopes = [...authResult.scopes];
    connection.userId = authResult.userId ?? null;
    connection.tokenId = authResult.tokenId ?? null;
    const previousBrowserSessions = connection.subscribedBrowserSessions ?? new Set();
    connection.subscribedRuns = Array.isArray(request.subscribe)
      ? new Set(request.subscribe.filter((value) => typeof value === "string"))
      : null;
    connection.subscribedBrowserSessions = new Set(
      Array.isArray(request.subscribe)
        ? request.subscribe
            .filter((value) => typeof value === "string" && value.startsWith("browser:"))
            .map((value) => value.slice(8))
        : [],
    );
    for (const sessionId of new Set([...previousBrowserSessions, ...connection.subscribedBrowserSessions])) {
      void this.browser.setFrameSubscribers?.(sessionId, this.browserSubscriberCount(sessionId));
    }
    for (const sessionId of connection.subscribedBrowserSessions) {
      this.browser.setFrameSubscribers?.(sessionId, this.browserSubscriberCount(sessionId));
    }
    this.startHeartbeat(connection);
    this.recordAuthEvent("ws", "success", connection, {
      clientId: request.client.id,
      clientVersion: request.client.version,
      scopeCount: connection.scopes.length,
    });
    const hello = {
      protocol: this.protocol,
      features: this.features,
      identity: this.buildIdentity(),
      policy: { heartbeatMs: this.heartbeatMs },
      auth: {
        sessionToken: connection.sessionToken,
        role: authResult.role,
        scopes: authResult.scopes,
        userId: authResult.userId ?? null,
        tokenId: authResult.tokenId ?? null,
      },
      snapshot: await this.buildSnapshot(),
    };
    return responseOk(id, hello);
  }
  /**
   * @param {IncomingMessage} req
   * @param {ConnectRequest} request
   * @returns {Promise< | { ok: true; role: string; scopes: string[]; userId?: string } | { ok: false; code: string; message: string } >}
   */
  async authenticate(req, request) {
    const tokenFromRequest = "token" in (request.auth ?? {}) ? request.auth.token : null;
    // Browser WebSocket clients cannot set headers and (after the session
    // handoff) carry no explicit token: fall back to the Authorization header
    // or the HttpOnly session cookie the upgrade request already sent.
    const token = typeof tokenFromRequest === "string" ? tokenFromRequest : bearerTokenFromHeaders(req);
    return this.authenticateRequest(req, token);
  }
  /**
   * Whether `req`'s browser `Origin` is permitted by the configured auth-mode
   * Origin allow-list. No auth, an empty/unset `allowedOrigins`, or a missing
   * `Origin` header (server-to-server / CLI) are always allowed; a present
   * `Origin` must be on the list. Enforced for both the HTTP RPC path (via
   * `authenticateRequest`) and the WS `upgrade` handler (#446).
   * @param {IncomingMessage} req
   * @returns {boolean}
   */
  isOriginAllowed(req) {
    const allowedOrigins = this.auth?.allowedOrigins ?? [];
    if (allowedOrigins.length === 0) {
      return true;
    }
    const origin = asString(req.headers.origin);
    return !origin || allowedOrigins.includes(origin);
  }
  /**
   * Origin gate that adapts to auth mode.
   *
   * With auth configured the token is the gate, so an empty allow-list is
   * permissive (delegates to `isOriginAllowed`). With NO auth every request is
   * an implicit operator, so a cross-origin browser page must be rejected even
   * though `Host` is loopback: the page points a `fetch`/`WebSocket` straight at
   * `http://127.0.0.1:<port>` — no DNS rebinding, so the Host gate can't see it —
   * and would otherwise drive `launchRun` (real compute/shell) as operator. Only
   * an absent, `"null"`, or loopback Origin may drive an unauthenticated daemon.
   * `--insecure` / `SMITHERS_GATEWAY_TRUST_ANY_HOST` opts out, mirroring the Host
   * gate for an explicit remote bind. (#446)
   * @param {IncomingMessage} req
   * @returns {boolean}
   */
  isRequestOriginAllowed(req) {
    if (this.auth) {
      return this.isOriginAllowed(req);
    }
    if (this.trustAnyHost) {
      return true;
    }
    const trustAnyHost = process.env.SMITHERS_GATEWAY_TRUST_ANY_HOST;
    if (trustAnyHost === "1" || trustAnyHost === "true") {
      return true;
    }
    const origin = asString(req.headers.origin);
    if (origin === undefined || origin === "" || origin === "null") {
      return true;
    }
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    return host !== "" && isLoopbackHost(host);
  }
  /**
   * For cookie-authenticated requests, whether the browser `Origin` is trusted:
   * absent/"null" (non-browser), on the configured allow-list, or same-host as
   * the request `Host` (the gateway's own origin). Cross-origin cookie auth is
   * refused even with an empty allow-list, because the SameSite=Lax cookie is
   * an ambient credential a sibling same-site origin can trigger.
   * @param {IncomingMessage} req
   * @returns {boolean}
   */
  isCookieOriginTrusted(req) {
    const origin = asString(req.headers.origin);
    if (origin === undefined || origin === "" || origin === "null") {
      return true;
    }
    const allowedOrigins = this.auth?.allowedOrigins ?? [];
    if (allowedOrigins.includes(origin)) {
      return true;
    }
    const host = asString(req.headers.host);
    try {
      return host !== undefined && host !== "" && new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  /**
   * DNS-rebinding defense (spec decision 16a). An unauthenticated daemon grants
   * operator scope to every request, so a browser page at a name rebound to
   * 127.0.0.1 could drive `launchRun` (real compute/shell). Browsers send the
   * rebound name in `Host`, so requiring a loopback `Host` closes the hole even
   * when the Origin allow-list is empty (permissive). Only the unauthenticated
   * path is gated: with auth configured the token is the gate and a remote
   * client legitimately sends a non-loopback Host. `SMITHERS_GATEWAY_TRUST_ANY_HOST=1`
   * opts out for an explicit `--insecure` remote bind. A missing/empty Host
   * (non-browser CLI, HTTP/1.0) is not a rebinding vector and is allowed.
   * @param {IncomingMessage} req
   * @returns {boolean}
   */
  isHostAllowed(req) {
    if (this.auth) {
      return true;
    }
    if (this.trustAnyHost) {
      return true;
    }
    const trustAnyHost = process.env.SMITHERS_GATEWAY_TRUST_ANY_HOST;
    if (trustAnyHost === "1" || trustAnyHost === "true") {
      return true;
    }
    const host = asString(req.headers.host);
    if (host === undefined || host === "") {
      return true;
    }
    return isLoopbackHost(host);
  }
  /**
   * @param {IncomingMessage} req
   * @param {string | null} token
   * @returns {Promise< | { ok: true; role: string; scopes: string[]; userId?: string } | { ok: false; code: string; message: string } >}
   */
  async authenticateRequest(req, token) {
    // DNS-rebinding defense (spec decision 16a), enforced BEFORE the
    // unauthenticated operator grant below — otherwise a rebound browser
    // page reaches an unauthenticated daemon as an implicit operator.
    if (!this.isHostAllowed(req)) {
      return {
        ok: false,
        code: "UNAUTHORIZED",
        message: "Host is not allowed",
      };
    }
    // Defense-in-depth Origin gate, enforced BEFORE the unauthenticated
    // operator grant below. Auth-mode-aware (isRequestOriginAllowed): the
    // token-gated paths keep allow-list semantics, while an unauthenticated
    // daemon rejects any present cross-origin Origin so a drive-by browser
    // page can't drive `launchRun` as an implicit operator. WS upgrades are
    // also rejected earlier in the `upgrade` handler; this backstops the
    // WS `connect` RPC and covers the HTTP RPC path (#446).
    if (!this.isRequestOriginAllowed(req)) {
      return {
        ok: false,
        code: "UNAUTHORIZED",
        message: "Origin is not allowed",
      };
    }
    // Ambient-cookie CSRF gate. The session cookie is SameSite=Lax, so a
    // same-site but cross-ORIGIN page (evil.example.com vs the gateway's
    // smithers.example.com) still has the browser attach it to a GET/WS
    // handshake. Unlike an explicit Authorization/x-smithers-key header,
    // that credential is ambient, so a permissive (empty) allow-list must
    // NOT trust it: when the request authenticates ONLY via the cookie,
    // require a same-host or allow-listed Origin. Header/token clients
    // (CLI, server-to-server) are unaffected.
    if (this.auth && requestUsesAmbientCookieAuth(req) && !this.isCookieOriginTrusted(req)) {
      return {
        ok: false,
        code: "UNAUTHORIZED",
        message: "Origin is not allowed for cookie-authenticated requests",
      };
    }
    if (!this.auth) {
      return {
        ok: true,
        role: "operator",
        scopes: ["*"],
      };
    }
    if (this.auth.mode === "token") {
      if (!token || typeof token !== "string") {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "A bearer token is required",
        };
      }
      const grant = Object.hasOwn(this.auth.tokens, token) ? this.auth.tokens[token] : undefined;
      if (!grant) {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "Invalid token",
        };
      }
      if (typeof grant.revokedAtMs === "number" && grant.revokedAtMs <= Date.now()) {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "Token has been revoked",
          details: {
            refresh: "smithers token issue",
          },
        };
      }
      if (typeof grant.expiresAtMs === "number" && grant.expiresAtMs <= Date.now()) {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "Token expired; issue a refreshed token.",
          details: {
            refresh: "smithers token issue",
          },
        };
      }
      return {
        ok: true,
        role: grant.role,
        scopes: grant.scopes,
        userId: grant.userId,
        tokenId: grant.tokenId ?? createHash("sha256").update(token).digest("hex").slice(0, 16),
      };
    }
    if (this.auth.mode === "jwt") {
      if (!token || typeof token !== "string") {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "A bearer token is required",
        };
      }
      const verified = verifyJwtToken(token, this.auth);
      if (verified.ok === false) {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: verified.message,
          details: verified.message.includes("expired") ? { refresh: "smithers token issue" } : undefined,
        };
      }
      const scopes = parseJwtScopes(verified.payload[this.auth.scopesClaim ?? "scope"]);
      const role = asString(verified.payload[this.auth.roleClaim ?? "role"]) ?? this.auth.defaultRole ?? "operator";
      const userId = asString(verified.payload[this.auth.userClaim ?? "sub"]);
      return {
        ok: true,
        role,
        scopes: scopes.length > 0 ? scopes : [...(this.auth.defaultScopes ?? [])],
        userId: userId ?? undefined,
        tokenId: createHash("sha256").update(token).digest("hex").slice(0, 16),
      };
    }
    if (this.auth.mode === "trusted-proxy") {
      // Origin allow-list is enforced uniformly above (#446).
      const [userHeader = "x-user-id", scopesHeader = "x-user-scopes", roleHeader = "x-user-role"] = (
        this.auth.trustedHeaders ?? []
      ).map((value) => value.toLowerCase());
      const userId = asString(req.headers[userHeader]);
      const scopesValue = asString(req.headers[scopesHeader]);
      const role = asString(req.headers[roleHeader]) ?? this.auth.defaultRole ?? "operator";
      // Fail CLOSED when the trusted proxy omits the scopes header: falling
      // back to a hard-coded ["*"] would silently grant full operator scope
      // to any request that reaches the gateway without the header (e.g. a
      // request that bypassed the proxy, or a misconfigured proxy). An
      // explicitly-configured `defaultScopes` is the operator's own choice
      // and is honored; the implicit "*" is not.
      if (!scopesValue && this.auth.defaultScopes === undefined) {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "trusted-proxy request is missing the user scopes header and no defaultScopes is configured",
        };
      }
      const scopes = scopesValue
        ? scopesValue
            .split(/[,\s]+/)
            .map((value) => value.trim())
            .filter(Boolean)
        : [...(this.auth.defaultScopes ?? [])];
      return {
        ok: true,
        role,
        scopes,
        userId: userId ?? undefined,
        tokenId: asString(req.headers["x-smithers-token-id"]) ?? undefined,
      };
    }
    return {
      ok: false,
      code: "UNAUTHORIZED",
      message: "Unsupported auth mode",
    };
  }
  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  async handleElectricWrite(req, res) {
    const requestId = headerValue(req, "x-request-id") ?? randomUUID();
    const baseContext = {
      connectionId: `electric-write:${requestId}`,
      transport: "http",
      role: null,
      scopes: [],
      userId: null,
      tokenId: null,
      subscribedRuns: null,
      devtoolsStreams: null,
    };
    let context = baseContext;
    try {
      const authResult = await this.authenticateRequest(req, bearerTokenFromHeaders(req));
      if (authResult.ok === false) {
        return sendJson(res, statusForRpcError(authResult.code), {
          ok: false,
          code: authResult.code,
          message: authResult.message,
          details: authResult.details,
        });
      }
      context = {
        ...baseContext,
        role: authResult.role,
        scopes: [...authResult.scopes],
        userId: authResult.userId ?? null,
        tokenId: authResult.tokenId ?? null,
      };
      const body = asObject(await readBody(req, this.maxBodyBytes));
      if (!body) {
        return sendJson(res, 400, {
          ok: false,
          code: "INVALID_REQUEST",
          message: "Electric write body must be a JSON object",
        });
      }
      assertJsonPayloadWithinBounds("gateway frame", body, {
        maxArrayLength: GATEWAY_RPC_MAX_ARRAY_LENGTH,
        maxDepth: GATEWAY_RPC_MAX_DEPTH,
        maxStringLength: GATEWAY_RPC_MAX_STRING_LENGTH,
      });
      const method = validateGatewayMethodName(asString(body.method));
      const params = body.params ?? body.vars ?? {};
      if (!hasScope(context.scopes, method, this.extensions)) {
        const forbidden = responseForbidden(requestId, method, this.extensions);
        return sendJson(res, statusForRpcError(forbidden.error?.code), {
          ok: false,
          code: forbidden.error?.code,
          message: forbidden.error?.message,
          requiredScope: forbidden.error?.requiredScope,
        });
      }
      // Writes always flow through the gateway RPC path, NOT through Electric
      // shapes (§5.5). The previous implementation opened a raw BEGIN/COMMIT
      // directly on every workflow's shared Postgres connection to grab a
      // txid. That bypassed the single-permit semaphore that serializes ALL
      // access to that one physical connection (SqlMessageStorage), so the
      // ~1s event-bridge tail, heartbeats, and any concurrent run sharing the
      // DB interleaved their statements into the manually-opened transaction
      // — an RPC-failure ROLLBACK could discard unrelated committed-intended
      // work, and two concurrent electric writes collided on a nested BEGIN.
      // It also fired on embedded PGlite (dialect "postgres", single
      // connection), which is never an Electric source. The endpoint now runs
      // the RPC exactly like any other and lets the engine's own serialized
      // transactions commit the synced rows.
      const frame = {
        type: "req",
        id: requestId,
        method,
        params,
      };
      const response = await this.executeRpc(context, frame, () => this.routeRequest(context, frame));
      if (!response.ok) {
        return sendJson(res, statusForRpcError(response.error?.code), {
          ok: false,
          code: response.error?.code,
          message: response.error?.message,
          details: response.error,
        });
      }
      // Optimistic txid matching needs the txid of the transaction that
      // actually writes the synced row. For detached RPCs (launchRun
      // enqueues; run/event/node rows commit later in the engine's own
      // serialized transactions) the gateway cannot observe that txid
      // without the engine surfacing it, so it returns null rather than a
      // fabricated post-hoc txid that would hang awaitTxId until timeout.
      // The Electric collection reconciles optimistic state when the row
      // arrives in the shape stream; threading the engine write txid for
      // tight no-flicker matching is a documented follow-up (§5.5).
      emitGatewayLog(
        "info",
        "Gateway Electric write committed",
        {
          ...gatewayContextAnnotations(context),
          requestId,
          method,
        },
        "gateway:electric-write",
      );
      return sendJson(res, 200, {
        ok: true,
        payload: response.payload,
        txid: null,
      });
    } catch (error) {
      emitGatewayLog(
        isSmithersError(error) ? "warning" : "error",
        "Gateway Electric write failed",
        {
          ...gatewayContextAnnotations(context),
          requestId,
          ...gatewayErrorAnnotations(error),
        },
        "gateway:electric-write",
      );
      const message = error?.message ?? "Electric write failed";
      const isPayloadBoundsError =
        isSmithersError(error) &&
        error.code === "INVALID_INPUT" &&
        (error.details?.maxDepth !== undefined || error.details?.maxLength !== undefined);
      const status = message.includes("valid JSON")
        ? 400
        : isPayloadBoundsError || message.includes("exceeds")
          ? 413
          : 500;
      return sendJson(res, status, {
        ok: false,
        code: status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "INVALID_JSON" : "SERVER_ERROR",
        message,
      });
    }
  }
  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {string} [forcedMethod]
   */
  async handleHttpRpc(req, res, forcedMethod) {
    const requestId = headerValue(req, "x-request-id") ?? randomUUID();
    const baseContext = {
      connectionId: `http:${requestId}`,
      transport: "http",
      role: null,
      scopes: [],
      userId: null,
      tokenId: null,
      subscribedRuns: null,
      devtoolsStreams: null,
    };
    let context = baseContext;
    this.recordMessageReceived("http", "request");
    try {
      const authResult = await this.authenticateRequest(req, bearerTokenFromHeaders(req));
      if (authResult.ok === false) {
        emitGatewayEffect(
          incrementMetric(gatewayErrorsTotal, {
            kind: "auth",
            transport: "http",
            code: authResult.code,
          }),
        );
        this.recordAuthEvent(
          "http",
          "failure",
          context,
          {
            requestId,
            authCode: authResult.code,
            authMessage: authResult.message,
          },
          "warning",
        );
        const response = responseError(requestId, authResult.code, authResult.message, authResult.details);
        return this.sendHttpRpcResponse(res, statusForRpcError(authResult.code), response);
      }
      context = {
        ...baseContext,
        role: authResult.role,
        scopes: [...authResult.scopes],
        userId: authResult.userId ?? null,
        tokenId: authResult.tokenId ?? null,
      };
      this.recordAuthEvent(
        "http",
        "success",
        context,
        {
          requestId,
          scopeCount: authResult.scopes.length,
        },
        "debug",
      );
      const body = asObject(await readBody(req, this.maxBodyBytes));
      if (!body) {
        emitGatewayEffect(
          incrementMetric(gatewayErrorsTotal, {
            kind: "http",
            transport: "http",
            code: "INVALID_REQUEST",
          }),
        );
        emitGatewayLog(
          "warning",
          "Gateway HTTP RPC rejected",
          {
            ...gatewayContextAnnotations(context),
            requestId,
            errorCode: "INVALID_REQUEST",
            errorMessage: "RPC body must be a JSON object",
          },
          "gateway:http-rpc",
        );
        return this.sendHttpRpcResponse(
          res,
          400,
          responseError(requestId, "INVALID_REQUEST", "RPC body must be a JSON object"),
        );
      }
      // Both frame shapes: body.params (RPC envelope) and body itself
      // (forcedMethod routes treat the body as the params object).
      clampFrameStartedByPrompt(body.params);
      clampFrameStartedByPrompt(body);
      assertJsonPayloadWithinBounds("gateway frame", body, {
        maxArrayLength: GATEWAY_RPC_MAX_ARRAY_LENGTH,
        maxDepth: GATEWAY_RPC_MAX_DEPTH,
        maxStringLength: GATEWAY_RPC_MAX_STRING_LENGTH,
      });
      const method = validateGatewayMethodName(forcedMethod ?? body.method);
      const bodyId = asString(body.id) ?? requestId;
      assertOptionalStringMaxLength("id", bodyId, GATEWAY_FRAME_ID_MAX_LENGTH);
      const frame = {
        type: "req",
        id: bodyId,
        method,
        params: forcedMethod && body.method === undefined ? body : body.params,
      };
      const response = await this.executeRpc(context, frame, async () => {
        if (!hasScope(context.scopes, method, this.extensions)) {
          return responseForbidden(bodyId, method, this.extensions);
        }
        return this.routeRequest(context, frame);
      });
      return this.sendHttpRpcResponse(res, response.ok ? 200 : statusForRpcError(response.error?.code), response);
    } catch (error) {
      emitGatewayEffect(
        incrementMetric(gatewayErrorsTotal, {
          kind: "http",
          transport: "http",
          code: gatewayErrorCode(error),
        }),
      );
      emitGatewayLog(
        isSmithersError(error) ? "warning" : "error",
        "Gateway HTTP RPC failed",
        {
          ...gatewayContextAnnotations(context),
          requestId,
          ...gatewayErrorAnnotations(error),
        },
        "gateway:http-rpc",
      );
      if (isSmithersError(error)) {
        return this.sendHttpRpcResponse(
          res,
          statusForRpcError(error.code),
          responseError(requestId, error.code, error.summary),
        );
      }
      const message = error?.message ?? "Gateway request failed";
      const status = message.includes("valid JSON") ? 400 : message.includes("exceeds") ? 413 : 500;
      return this.sendHttpRpcResponse(
        res,
        status,
        responseError(
          requestId,
          status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "INVALID_JSON" : "SERVER_ERROR",
          message,
        ),
      );
    }
  }
  /**
   * @param {ConnectionState} connection
   * @param {ResponseFrame} frame
   */
  sendResponse(connection, frame) {
    if (connection.ws.readyState !== connection.ws.OPEN) {
      return;
    }
    const writer = this.getConnectionEventWriter(connection);
    if (writer.disconnected) {
      return;
    }
    this.writeConnectionEventFrame(
      connection,
      writer,
      JSON.stringify(frame),
      frame.ok ? CONNECTION_RESPONSE_OK : CONNECTION_RESPONSE_ERROR,
    );
  }
  /**
   * @param {ConnectionState} connection
   * @param {string} event
   * @param {unknown} [payload]
   */
  sendEvent(connection, event, payload, stateVersion = this.stateVersion) {
    if (connection.ws.readyState !== connection.ws.OPEN) {
      return;
    }
    const writer = this.getConnectionEventWriter(connection);
    if (writer.disconnected) {
      return;
    }
    connection.seq += 1;
    const frame = {
      type: "event",
      event,
      payload,
      seq: connection.seq,
      stateVersion,
      apiVersion: SMITHERS_API_VERSION,
    };
    this.writeConnectionEventFrame(connection, writer, JSON.stringify(frame), event);
  }
  /**
   * @param {ConnectionState} connection
   * @returns {ConnectionEventWriterState}
   */
  getConnectionEventWriter(connection) {
    let writer = connection.eventWriter;
    if (!writer) {
      writer = { queue: [], queuedBytes: 0, flushPending: false, disconnected: false };
      connection.eventWriter = writer;
    }
    return writer;
  }
  /**
   * Observable buffered event bytes for a connection: what the socket itself
   * reports (bufferedAmount) plus what the bounded writer is still holding.
   * @param {ConnectionState} connection
   * @returns {number}
   */
  getConnectionBufferedEventBytes(connection) {
    const socketBuffered = typeof connection.ws?.bufferedAmount === "number" ? connection.ws.bufferedAmount : 0;
    return socketBuffered + (connection.eventWriter?.queuedBytes ?? 0);
  }
  /**
   * The single byte-bounded writer every event frame for a connection goes
   * through. On a healthy socket frames are written straight through; once
   * the socket's observable bufferedAmount crosses the high-water mark frames
   * queue here — bounded by bytes — and drain when the socket recovers.
   * Overflow disconnects the connection.
   * @param {ConnectionState} connection
   * @param {ConnectionEventWriterState} writer
   * @param {string} data
   * @param {string} event
   */
  writeConnectionEventFrame(connection, writer, data, event) {
    const ws = connection.ws;
    const bytes = Buffer.byteLength(data, "utf8");
    const socketCongested =
      typeof ws.bufferedAmount === "number" && ws.bufferedAmount > CONNECTION_EVENT_WS_BUFFERED_HIGH_WATER_BYTES;
    if (writer.queue.length === 0 && !socketCongested) {
      ws.send(data);
      if (event === CONNECTION_RESPONSE_OK || event === CONNECTION_RESPONSE_ERROR) {
        this.recordMessageSent("ws", "response", {
          outcome: event === CONNECTION_RESPONSE_OK ? "ok" : "error",
        });
      } else {
        this.recordMessageSent("ws", "event", { event });
      }
      return;
    }
    if (writer.queuedBytes + bytes > CONNECTION_EVENT_QUEUE_MAX_BYTES) {
      this.disconnectConnectionForEventBackpressure(connection, writer, event);
      return;
    }
    writer.queue.push({ data, bytes, event });
    writer.queuedBytes += bytes;
    this.drainConnectionEventWriter(connection, writer);
  }
  /**
   * Drain the connection writer's queue against the socket's buffered bytes.
   * Mirrors drainRunEventStream: a congested socket re-arms a short retry
   * instead of dropping frames; the byte cap (enforced at enqueue time) is
   * what bounds memory and trips the per-connection disconnect.
   * @param {ConnectionState} connection
   * @param {ConnectionEventWriterState} writer
   */
  drainConnectionEventWriter(connection, writer) {
    if (writer.flushPending || writer.disconnected) {
      return;
    }
    writer.flushPending = true;
    let retryScheduled = false;
    try {
      while (writer.queue.length > 0 && !writer.disconnected && connection.ws.readyState === connection.ws.OPEN) {
        const ws = connection.ws;
        if (
          typeof ws.bufferedAmount === "number" &&
          ws.bufferedAmount > CONNECTION_EVENT_WS_BUFFERED_HIGH_WATER_BYTES
        ) {
          retryScheduled = true;
          setTimeout(() => {
            writer.flushPending = false;
            this.drainConnectionEventWriter(connection, writer);
          }, CONNECTION_EVENT_DRAIN_RETRY_MS);
          return;
        }
        const entry = writer.queue.shift();
        if (!entry) {
          continue;
        }
        writer.queuedBytes -= entry.bytes;
        ws.send(entry.data);
        if (entry.event === CONNECTION_RESPONSE_OK || entry.event === CONNECTION_RESPONSE_ERROR) {
          this.recordMessageSent("ws", "response", {
            outcome: entry.event === CONNECTION_RESPONSE_OK ? "ok" : "error",
          });
        } else {
          this.recordMessageSent("ws", "event", { event: entry.event });
        }
      }
    } finally {
      if (!retryScheduled) {
        writer.flushPending = false;
      }
    }
  }
  /**
   * Per-connection overflow behavior: a consumer that stays congested past the
   * socket high-water mark AND fills the byte-bounded queue is disconnected
   * outright (close 1013 Try Again Later) — the socket's close handler tears
   * down every stream on the connection, and nothing further buffers for it.
   * @param {ConnectionState} connection
   * @param {ConnectionEventWriterState} writer
   * @param {string} event
   */
  disconnectConnectionForEventBackpressure(connection, writer, event) {
    if (writer.disconnected) {
      return;
    }
    writer.disconnected = true;
    writer.queue.length = 0;
    writer.queuedBytes = 0;
    emitGatewayEffect(Metric.update(gatewayRunEventBackpressureDisconnectTotal, 1));
    emitGatewayLog(
      "warning",
      "Gateway connection disconnected for event backpressure",
      {
        ...gatewayContextAnnotations(connection),
        event: event === CONNECTION_RESPONSE_OK || event === CONNECTION_RESPONSE_ERROR ? null : event,
        wsBufferedAmount: typeof connection.ws?.bufferedAmount === "number" ? connection.ws.bufferedAmount : null,
        queueMaxBytes: CONNECTION_EVENT_QUEUE_MAX_BYTES,
        wsBufferedHighWaterBytes: CONNECTION_EVENT_WS_BUFFERED_HIGH_WATER_BYTES,
      },
      "gateway:broadcast",
    );
    try {
      connection.ws.close(CONNECTION_EVENT_BACKPRESSURE_CLOSE_CODE, "event backpressure");
    } catch {}
  }
  /**
   * @param {string} event
   * @param {unknown} [payload]
   */
  browserSubscriberCount(sessionId) {
    let count = 0;
    for (const connection of this.connections) {
      if (connection.authenticated && !connection.closed && connection.subscribedBrowserSessions?.has(sessionId))
        count += 1;
    }
    return count;
  }
  broadcastEvent(event, payload) {
    const runId = eventRunId(payload);
    const browserSessionId = eventBrowserSessionId(event, payload);
    this.stateVersion += 1;
    const runFrame = this.appendRunEventWindow(event, payload, this.stateVersion);
    void this.queueApiInvalidation(apiCollectionsForGatewayEvent(event));
    let recipientCount = 0;
    for (const connection of this.connections) {
      if (!connection.authenticated || !shouldDeliverEvent(connection, runId)) {
        continue;
      }
      if (browserSessionId && !connection.subscribedBrowserSessions?.has(browserSessionId)) {
        continue;
      }
      recipientCount += 1;
      let deliveredToRunStream = false;
      if (runFrame && connection.runEventStreams) {
        for (const [streamId, stream] of connection.runEventStreams.entries()) {
          if (stream.runId === runId) {
            deliveredToRunStream = true;
            this.sendRunEventStreamFrame(connection, streamId, runFrame);
          }
        }
      }
      if (!deliveredToRunStream) {
        this.sendEvent(connection, event, payload, this.stateVersion);
      }
    }
    if (event === "run.completed" && runId) {
      const status = asString(asObject(payload)?.status) ?? "";
      if (TERMINAL_RUN_STATUSES.has(status)) {
        this.markRunEventWindowTerminal(runId);
      }
    }
    emitGatewayLog(
      "debug",
      "Gateway event broadcast",
      {
        event,
        stateVersion: this.stateVersion,
        recipientCount,
        ...(runId ? { runId } : {}),
      },
      "gateway:broadcast",
    );
  }
  async buildSnapshot() {
    const runs = await this.listRunsAcrossWorkflows(1_000);
    const approvals = await this.listPendingApprovals();
    return {
      runs: runs.filter((run) =>
        ["running", "waiting-approval", "waiting-event", "waiting-timer", "paused"].includes(run.status),
      ),
      approvals,
      stateVersion: this.stateVersion,
    };
  }
  /**
   * @param {SmithersWorkflow} workflow
   * @returns {SmithersDb}
   */
  adapterForWorkflow(workflow) {
    // Cache by the underlying DB so workflows that SHARE a database (the
    // common case once many workflows are registered on one gateway, e.g.
    // a whole init pack) resolve to the SAME adapter instance. That identity
    // is what lets the cross-workflow readers below iterate each DB once
    // instead of once per registered workflow.
    if (!this.adapterCache) {
      this.adapterCache = new Map();
    }
    let adapter = this.adapterCache.get(workflow.db);
    if (adapter) {
      return adapter;
    }
    // Separately-loaded workflow modules each open their OWN handle to the
    // SAME store (an init pack registers ~90 workflows → ~90 drizzle objects
    // over one smithers.db), so object identity alone dedupes nothing. Key
    // on the store's identity too — the sqlite filename (or pglite data
    // dir) — so cross-workflow readers (buildSnapshot,
    // listRunsAcrossWorkflows, the out-of-process event bridge) iterate each
    // STORE once, not once per registered workflow. Without this a WS
    // `connect` (whose hello inlines buildSnapshot) scans the same DB ~90×
    // and starves the handshake on a workspace-sized gateway.
    if (!this.adapterByStore) {
      this.adapterByStore = new Map();
    }
    const client = workflow.db?.$client;
    const storeKey =
      typeof client?.filename === "string" && client.filename.length > 0
        ? `sqlite:${client.filename}`
        : typeof client?.dataDir === "string" && client.dataDir.length > 0
          ? `pglite:${client.dataDir}`
          : null;
    if (storeKey) {
      adapter = this.adapterByStore.get(storeKey);
      if (adapter) {
        this.adapterCache.set(workflow.db, adapter);
        return adapter;
      }
    }
    adapter = new SmithersDb(workflow.db);
    this.adapterCache.set(workflow.db, adapter);
    if (storeKey) {
      this.adapterByStore.set(storeKey, adapter);
    }
    return adapter;
  }
  /**
   * Resolve the true gateway workflow key for a stored run row. A run started
   * THROUGH the gateway records its key in config; a run started elsewhere (e.g.
   * the CLI) does not, so we fall back to the row's own `workflowName` when that
   * matches a registered key, then to the run's entry-file basename (the
   * discovered-workflow id — this catches runs whose workflow crashed before it
   * ever announced a name), then to an unregistered stored name. Only a row with
   * no workflow identity falls back to the adapter's first owner. This keeps
   * runs correctly attributed when many workflows share one DB — the adapter
   * that finds a row is no longer assumed to own it.
   * @param {{ configJson?: string; workflowName?: string; workflowPath?: string }} row
   * @param {Set<string>} registeredKeys
   * @param {string} fallbackKey
   * @returns {string}
   */
  resolveRunWorkflowKey(row, registeredKeys, fallbackKey) {
    const config = parseJson(row.configJson);
    const fromConfig = asString(config?.gatewayWorkflowKey);
    if (fromConfig) {
      return fromConfig;
    }
    const fromName = asString(row.workflowName);
    if (fromName && registeredKeys.has(fromName)) {
      return fromName;
    }
    const fromPath = workflowKeyFromRunPath(asString(row.workflowPath));
    if (fromPath) {
      return fromPath;
    }
    if (fromName) {
      return fromName;
    }
    return fallbackKey;
  }
  /**
   * @param {string} [status]
   * @param {string} [workflow]
   * @param {number} [offset] Rows to skip after the newest-first sort (server-side pagination).
   * @param {boolean} [includeSystem] Include internal and historical unstamped runs.
   * @param {string} [parentRunId] Return only direct children of this run.
   */
  async listRunsAcrossWorkflows(limit = 50, status, workflow, offset = 0, includeSystem = false, parentRunId) {
    const registeredKeys = new Set(this.workflows.keys());
    const seenAdapters = new Set();
    const byRunId = new Map();
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      // Shared-DB workflows share an adapter; query each DB exactly once so
      // a single run isn't returned once per registered workflow.
      if (seenAdapters.has(adapter)) {
        continue;
      }
      seenAdapters.add(adapter);
      // Each adapter's query is newest-first LIMIT; overfetch by the offset
      // so the merged window still contains the page being asked for.
      const rows = await adapter.listRuns(limit + offset, status, workflow, { includeSystem, parentRunId });
      for (const row of rows) {
        if (byRunId.has(row.runId)) {
          continue;
        }
        const workflowKey = this.resolveRunWorkflowKey(row, registeredKeys, entry.key);
        if (workflow && workflowKey !== workflow) {
          continue;
        }
        const rowStartedBy = runStartedByFromRow(row);
        const system = runSystemFromRow(row);
        if (!includeSystem && system) {
          continue;
        }
        byRunId.set(row.runId, {
          ...row,
          workflowKey,
          system,
          ...(rowStartedBy ? { startedBy: rowStartedBy } : {}),
        });
      }
    }
    const results = [...byRunId.values()];
    results.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
    return results.slice(offset, offset + limit);
  }
  /**
   * Cross-run memory facts for the `listMemoryFacts` RPC. Memory is global (keyed
   * by namespace+key, not per-run), so iterate each DISTINCT workflow DB exactly
   * once — shared-DB workflows share an adapter — and union the rows, deduping on
   * `${namespace}\u0000${key}` so a fact stored in a shared DB is returned once.
   * Mirrors the `listRunsAcrossWorkflows` shape.
   * @param {string | null} [namespace]
   */
  async listMemoryFactsAcrossWorkflows(namespace = null) {
    const ns = namespace ?? null;
    const seenAdapters = new Set();
    const byKey = new Map();
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      if (seenAdapters.has(adapter)) {
        continue;
      }
      seenAdapters.add(adapter);
      const rows = await adapter.listMemoryFacts(ns);
      for (const row of rows) {
        const dedupeKey = `${row.namespace}\u0000${row.key}`;
        if (!byKey.has(dedupeKey)) {
          byKey.set(dedupeKey, row);
        }
      }
    }
    const results = [...byKey.values()];
    results.sort((a, b) =>
      a.namespace === b.namespace ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.namespace < b.namespace ? -1 : 1,
    );
    return results;
  }
  /**
   * Registered agent accounts for the `listAccounts` RPC. Accounts are the rows
   * in the USER-level `~/.smithers/accounts.json` registry that the
   * `smithers agents` CLI manages (resolved via `accountsRoot(process.env)`,
   * honoring `SMITHERS_HOME`/`HOME`) — NOT a per-workspace DB table. So, like
   * `listPromptsFromDisk` but at the user root, this reads the file directly
   * through the `@smithers-orchestrator/accounts` package's `listAccounts()` and
   * maps each entry onto the wire `GatewayAccount` shape.
   *
   * SECRET REDACTION: an account may carry a raw `apiKey` (a plaintext
   * credential stored mode-600 on disk). The key is NEVER returned — instead
   * `hasApiKey` reports whether a non-empty key is set and `hasConfigDir`
   * reports whether a subscription account has a config dir, so the client can
   * render the auth posture without ever receiving the secret. A malformed
   * registry surfaces as a thrown `SmithersError` (→ the dispatcher's error
   * envelope); a missing file is a clean empty list (the package's own default).
   * @returns {Array<Record<string, unknown>>}
   */
  listAccountsFromRegistry() {
    return this.registeredAccountsFromRegistry().map((account) => ({
      label: account.label,
      provider: account.provider,
      configDir: typeof account.configDir === "string" ? account.configDir : null,
      hasConfigDir: typeof account.configDir === "string" && account.configDir.trim() !== "",
      hasApiKey: typeof account.apiKey === "string" && account.apiKey.trim() !== "",
      model: typeof account.model === "string" ? account.model : null,
      addedAt: typeof account.addedAt === "string" ? account.addedAt : null,
    }));
  }
  /**
   * Raw registered accounts for host-side provider probes. This method must
   * never be returned directly over the wire because API-key accounts include
   * their credential.
   */
  registeredAccountsFromRegistry() {
    return listAccounts(process.env);
  }
  /**
   * Injection seam for tests; production delegates to the usage package.
   * @param {ReturnType<Gateway["registeredAccountsFromRegistry"]>} accounts
   * @param {{ fresh?: boolean }} options
   * @returns {Promise<UsageReport[]>}
   */
  fetchUsageReports(accounts, options) {
    return getUsageForAccounts(accounts, options);
  }
  /**
   * Provider rate-limit and subscription-usage reports. Normal polling shares
   * one in-flight request and reuses its result for 60 seconds; `fresh` skips
   * the Gateway cache while still honoring provider safety in the usage package.
   * @param {{ fresh?: boolean }} [options]
   * @returns {Promise<UsageReport[]>}
   */
  async listUsageReports(options = {}) {
    const fresh = options.fresh === true;
    const cached = this.usageReportsCache;
    if (!fresh && cached && nowMs() - cached.cachedAtMs < USAGE_REPORT_CACHE_TTL_MS) {
      return cached.reports;
    }
    if (!fresh && this.usageReportsInFlight) {
      return this.usageReportsInFlight;
    }
    const request = Promise.resolve().then(async () => {
      let accounts;
      try {
        accounts = this.registeredAccountsFromRegistry();
      } catch (error) {
        return [
          {
            accountLabel: "accounts",
            provider: "codex",
            authMode: "subscription",
            source: "none",
            windows: [],
            fetchedAt: new Date(nowMs()).toISOString(),
            stale: false,
            estimate: false,
            error: error instanceof Error ? error.message : String(error),
          },
        ];
      }
      return this.fetchUsageReports(accounts, { fresh });
    });
    if (!fresh) {
      this.usageReportsInFlight = request;
    }
    try {
      const reports = await request;
      this.usageReportsCache = { reports, cachedAtMs: nowMs() };
      return reports;
    } finally {
      if (this.usageReportsInFlight === request) {
        this.usageReportsInFlight = null;
      }
    }
  }
  /**
   * Every persisted TokenUsageReported attempt event for a run. Unlike the
   * live event collections this reads the complete durable history and is not
   * bounded by a client replay/ring window.
   * @param {string} runId
   * @returns {Promise<{ runId: string; events: Array<Record<string, string | number>> } | null>}
   */
  async listRunTokenUsage(runId) {
    const resolved = await this.resolveRun(runId);
    if (!resolved) {
      return null;
    }
    const rows = await resolved.adapter.listEventsByType(runId, "TokenUsageReported");
    const events = rows
      .toSorted((left, right) => (asNumber(left.seq) ?? 0) - (asNumber(right.seq) ?? 0))
      .map(parseRunTokenUsageRow)
      .filter((event) => event !== null);
    return { runId, events };
  }
  /**
   * Registered prompts for the `listPrompts` RPC. A prompt is a `.md`/`.mdx`
   * file under the workspace's `.smithers/prompts/` directory — the SAME real
   * source smithers-studio walks. Unlike memory/scores/tickets (DB-table backed),
   * prompts live on disk, so this enumerates the filesystem under the registered
   * WORKSPACE ROOT (`this.workspaceRoot`, set from `options.workspaceRoot`). That
   * root — not `process.cwd()` — is authoritative because some launch modes keep
   * cwd elsewhere than the workspace (e.g. an app that binds the gateway to an
   * ABSOLUTE workspace DB path without `chdir`-ing, like the studio server, which
   * passes `SMITHERS_STUDIO_WORKSPACE`); resolving from cwd there returns the
   * wrong app's prompts or `[]`. When no workspace root was configured we fall
   * back to `process.cwd()`, which is correct for the common case where the
   * gateway boots from the workspace root. Each file maps to
   * `{ id, entryFile, source, createdAtMs, updatedAtMs }` where `id` is the
   * extensionless relative path (POSIX-separated so ids are stable across OSes).
   * Returns `[]` when no `.smithers/prompts/` directory exists (a clean empty
   * state, not an error).
   * @returns {Array<Record<string, unknown>>}
   */
  listPromptsFromDisk() {
    const promptsDir = resolve(this.workspaceRoot ?? process.cwd(), ".smithers", "prompts");
    if (!existsSync(promptsDir)) {
      return [];
    }
    const files = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const ext = extname(entry.name).toLowerCase();
        if (ext === ".md" || ext === ".mdx") {
          files.push(full);
        }
      }
    };
    walk(promptsDir);
    const rows = [];
    for (const file of files) {
      let source;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const relPosix = relative(promptsDir, file).split(sep).join("/");
      const id = relPosix.slice(0, relPosix.length - extname(relPosix).length);
      const row = { id, entryFile: `prompts/${relPosix}`, source };
      try {
        const stat = statSync(file);
        row.createdAtMs = Math.round(stat.birthtimeMs || stat.ctimeMs);
        row.updatedAtMs = Math.round(stat.mtimeMs);
      } catch {
        // Stat failures leave the timestamps absent (optional fields).
      }
      rows.push(row);
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }
  /**
   * Scorer/eval results for one run for the `listScores` RPC. Scores are
   * per-run (keyed by runId), so resolve the run's owning adapter exactly like
   * `getRun` and read the `_smithers_scorers` table via `listScorerResults`
   * (rows already snake→camel cased). Maps each row to the wire `GatewayScoreRow`
   * shape — only the fields the surface needs (no meta/input/output JSON blobs).
   * Returns `null` when the run is unknown so the dispatcher can answer NOT_FOUND.
   * @param {string} runId
   * @param {string | null} [nodeId]
   * @returns {Promise<Array<Record<string, unknown>> | null>}
   */
  async listScoresForRun(runId, nodeId = null) {
    const resolved = await this.resolveRun(runId);
    if (!resolved) {
      return null;
    }
    const rows = await resolved.adapter.listScorerResults(runId, nodeId ?? undefined);
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      runId: row.runId,
      nodeId: row.nodeId,
      iteration: typeof row.iteration === "number" ? row.iteration : 0,
      attempt: typeof row.attempt === "number" ? row.attempt : 0,
      scorerId: row.scorerId,
      scorerName: row.scorerName,
      source: row.source,
      score: row.score,
      reason: row.reason ?? null,
      scoredAtMs: row.scoredAtMs,
      latencyMs: row.latencyMs ?? null,
      durationMs: row.durationMs ?? null,
    }));
  }
  /**
   * Query persisted scorer rows across runs that may live in distinct stores.
   * All run ownership is resolved before the first score-table query so an
   * unknown id fails atomically. Each store contributes its filtered count and
   * its first `offset + limit` candidates; pagination happens after the global
   * deterministic merge.
   * @param {{
   *   runIds: string[];
   *   nodeId?: string;
   *   scorerId?: string;
   *   scorerName?: string;
   *   source?: string;
   *   order: "scoredAtAsc" | "scoredAtDesc";
   *   offset: number;
   *   limit: number;
   * }} query
   * @returns {Promise<{ missingRunId: string } | { rows: Array<Record<string, unknown>>, total: number }>}
   */
  async listScoresForRunsAcrossStores(query) {
    /** @type {Map<SmithersDb, string[]>} */
    const runIdsByAdapter = new Map();
    // Deliberately finish this complete ownership pass before score queries.
    for (const runId of query.runIds) {
      const resolved = await this.resolveRun(runId);
      if (!resolved) {
        return { missingRunId: runId };
      }
      const runIds = runIdsByAdapter.get(resolved.adapter) ?? [];
      runIds.push(runId);
      runIdsByAdapter.set(resolved.adapter, runIds);
    }
    const candidateLimit = query.offset + query.limit;
    const storeResults = await Promise.all(
      [...runIdsByAdapter.entries()].map(async ([adapter, runIds]) => {
        const storeQuery = {
          runIds,
          nodeId: query.nodeId,
          scorerId: query.scorerId,
          scorerName: query.scorerName,
          source: query.source,
        };
        const [total, rows] = await Promise.all([
          adapter.countScorerResultsForRuns(storeQuery),
          adapter.listScorerResultsForRuns({
            ...storeQuery,
            order: query.order,
            offset: 0,
            limit: candidateLimit,
          }),
        ]);
        return { total, rows };
      }),
    );
    const candidates = storeResults.flatMap((result) => result.rows.map((row) => serializeComparisonScoreRow(row)));
    candidates.sort((left, right) => compareScoreRows(left, right, query.order));
    return {
      rows: candidates.slice(query.offset, query.offset + query.limit),
      total: storeResults.reduce((sum, result) => sum + result.total, 0),
    };
  }
  /**
   * Read and decode one exact persisted score row. Missing runs and missing
   * score ids remain distinct so the typed RPC errors stay precise; malformed
   * JSON throws `Internal`.
   * @param {string} runId
   * @param {string} scoreId
   * @returns {Promise<{ missing: "run" | "score" } | { detail: Record<string, unknown> }>}
   */
  async getScoreDetailForRun(runId, scoreId) {
    const resolved = await this.resolveRun(runId);
    if (!resolved) {
      return { missing: "run" };
    }
    const row = await resolved.adapter.getScorerResult(runId, scoreId);
    if (!row) {
      return { missing: "score" };
    }
    return {
      detail: serializeScoreDetailRow({
        ...row,
        scoreId: row.id,
        meta: decodeScoreDetailJson(row.metaJson, scoreId, "meta"),
        input: decodeScoreDetailJson(row.inputJson, scoreId, "input"),
        output: decodeScoreDetailJson(row.outputJson, scoreId, "output"),
        groundTruth: decodeScoreDetailJson(row.groundTruthJson, scoreId, "groundTruth"),
        context: decodeScoreDetailJson(row.contextJson, scoreId, "context"),
      }),
    };
  }
  // ---------------------------------------------------------------------------
  // Tickets / work docs (`_smithers_docs`) — listTickets/createTicket/
  // updateTicket/deleteTicket RPCs + the file-watcher durability seam.
  // ---------------------------------------------------------------------------
  /**
   * The ONE adapter that backs the ticket WRITE RPCs (create/update/delete) and
   * the file-watcher. `_smithers_docs` is a SINGLE global table (not per-run,
   * not per-workflow), so writes must land in one deterministic DB — the first
   * registered workflow's adapter. `listTickets` still reads across every
   * distinct adapter (so a doc in any shared DB surfaces), but a write has to
   * pick one; picking the first registered keeps create→list→update→delete
   * consistent. Returns `null` only when no workflow is registered yet.
   * @returns {import("@smithers-orchestrator/db/adapter").SmithersDb | null}
   */
  primaryDocsAdapter() {
    const first = this.workflows.values().next().value;
    return first ? this.adapterForWorkflow(first.workflow) : null;
  }
  /** Map a stored `_smithers_docs` row (camel-cased) onto the wire `GatewayTicketRow`. */
  static toTicketRow(row) {
    return {
      path: row.path,
      kind: typeof row.kind === "string" ? row.kind : "ticket",
      content: typeof row.content === "string" ? row.content : "",
      contentHash: row.contentHash,
      status: row.status ?? null,
      updatedAtMs: row.updatedAtMs,
    };
  }
  /**
   * Live work docs for the `listTickets` RPC. `_smithers_docs` is global, so
   * read across every DISTINCT adapter (mirrors `listMemoryFactsAcrossWorkflows`)
   * and dedupe by `path`; `listDocs` already filters tombstones server-side, so
   * a soft-deleted doc never surfaces. Newest-updated first.
   * @param {string | null} [kind]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async listTicketsAcrossWorkflows(kind = null) {
    const seenAdapters = new Set();
    const byPath = new Map();
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      if (seenAdapters.has(adapter)) {
        continue;
      }
      seenAdapters.add(adapter);
      const rows = await adapter.listDocs(kind ?? null);
      for (const row of rows) {
        if (!byPath.has(row.path)) {
          byPath.set(row.path, Gateway.toTicketRow(row));
        }
      }
    }
    const results = [...byPath.values()];
    results.sort((a, b) => b.updatedAtMs - a.updatedAtMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return results;
  }
  /**
   * Create-or-replace a work doc for `createTicket`. The handler hashes content
   * + stamps `updated_at_ms` through the SAME `sha256Hex`/clock the file-watcher
   * uses, so an RPC-written `content_hash` and a file-derived one are comparable
   * (last-write-wins). Writing `deleted_at_ms: null` REVIVES a soft-deleted path
   * (a deliberate re-create). Returns the persisted row, or `null` when no
   * workflow is registered.
   * @param {{ path: string, content: string, kind?: string, status?: string }} input
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async createTicketDoc(input) {
    const adapter = this.primaryDocsAdapter();
    if (!adapter) {
      return null;
    }
    const existing = await adapter.getDoc(input.path);
    const kind = input.kind ?? (existing && typeof existing.kind === "string" ? existing.kind : "ticket");
    const status = input.status ?? (existing && existing.status != null ? existing.status : null);
    const contentHash = sha256Hex(input.content);
    const updatedAtMs = Date.now();
    await adapter.upsertDoc({
      path: input.path,
      kind,
      content: input.content,
      contentHash,
      status,
      updatedAtMs,
      deletedAtMs: null,
    });
    return { path: input.path, kind, content: input.content, contentHash, status, updatedAtMs };
  }
  /**
   * Patch a LIVE work doc's content and/or status for `updateTicket`. Re-hashes
   * + re-stamps when content changes (a status-only patch keeps the existing
   * hash/content). Returns `null` for an unknown or already-soft-deleted path so
   * the dispatcher can answer TicketNotFound; `false` when no workflow exists.
   * @param {{ path: string, content?: string, status?: string }} input
   * @returns {Promise<Record<string, unknown> | null | false>}
   */
  async updateTicketDoc(input) {
    const adapter = this.primaryDocsAdapter();
    if (!adapter) {
      return false;
    }
    const existing = await adapter.getDoc(input.path);
    if (!existing || existing.deletedAtMs != null) {
      return null;
    }
    const content = input.content ?? existing.content;
    const status = input.status ?? existing.status ?? null;
    const contentHash = input.content !== undefined ? sha256Hex(content) : existing.contentHash;
    const kind = typeof existing.kind === "string" ? existing.kind : "ticket";
    const updatedAtMs = Date.now();
    await adapter.upsertDoc({ path: input.path, kind, content, contentHash, status, updatedAtMs, deletedAtMs: null });
    return { path: input.path, kind, content, contentHash, status, updatedAtMs };
  }
  /**
   * Soft-delete (tombstone) a work doc for `deleteTicket`. Returns `null` for an
   * unknown/already-deleted path (→ TicketNotFound), `false` when no workflow is
   * registered. The row survives so `listTickets` hides it without losing
   * history; the watcher never materializes a tombstone back to disk.
   * @param {string} path
   * @returns {Promise<boolean | null | false>}
   */
  async deleteTicketDoc(path) {
    const adapter = this.primaryDocsAdapter();
    if (!adapter) {
      return false;
    }
    const existing = await adapter.getDoc(path);
    if (!existing || existing.deletedAtMs != null) {
      return null;
    }
    await adapter.softDeleteDoc(path, Date.now());
    return true;
  }
  /**
   * Wire the `_smithers_docs` file-watcher durability seam against the primary
   * docs adapter: watch a directory of `*.md` work docs and upsert each into
   * `_smithers_docs` (file → DB, last-write-wins on hash mismatch). Idempotent —
   * a second call for the same dir is a no-op. Returns the watcher handle (or
   * `null` when there is no adapter / no dir). The gateway reads
   * `SMITHERS_TICKETS_DIR` at `listen()` to start this automatically.
   * @param {string} dir
   * @returns {{ close: () => void } | null}
   */
  watchTicketsDirectory(dir) {
    if (!dir) {
      return null;
    }
    const adapter = this.primaryDocsAdapter();
    if (!adapter) {
      return null;
    }
    if (!this.ticketWatchers) {
      this.ticketWatchers = new Map();
    }
    const existing = this.ticketWatchers.get(dir);
    if (existing) {
      return existing;
    }
    const watcher = watchDocsDirectory(adapter, { dir, kind: "ticket", defaultStatus: "todo" });
    this.ticketWatchers.set(dir, watcher);
    return watcher;
  }
  async listPendingApprovals() {
    const approvals = [];
    const registeredKeys = new Set(this.workflows.keys());
    const seenAdapters = new Set();
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      // One pass per DB: shared-DB workflows share an adapter, so iterating
      // them all would surface each pending gate (and mis-key it) N times.
      if (seenAdapters.has(adapter)) {
        continue;
      }
      seenAdapters.add(adapter);
      const runs = await adapter.listRuns(1_000);
      const runById = new Map(runs.map((run) => [run.runId, run]));
      const nodeMapsByRunId = new Map();
      const seenApprovalKeys = new Set();
      for (const run of runs) {
        const pending = await adapter.listPendingApprovals(run.runId);
        for (const approval of pending) {
          const approvalKey = `${approval.runId}::${approval.nodeId}::${approval.iteration ?? 0}`;
          if (seenApprovalKeys.has(approvalKey)) continue;
          seenApprovalKeys.add(approvalKey);
          const approvalRun = runById.get(approval.runId) ?? (await adapter.getRun(approval.runId)) ?? run;
          const workflowKey = this.resolveRunWorkflowKey(approvalRun, registeredKeys, entry.key);
          let nodeByKey = nodeMapsByRunId.get(approval.runId);
          if (!nodeByKey) {
            const nodes = await adapter.listNodes(approval.runId);
            nodeByKey = new Map();
            for (const node of nodes) {
              nodeByKey.set(`${node.nodeId}::${node.iteration ?? 0}`, node);
            }
            nodeMapsByRunId.set(approval.runId, nodeByKey);
          }
          const node = nodeByKey.get(`${approval.nodeId}::${approval.iteration ?? 0}`);
          const request = parseApprovalRequest(parseJson(approval.requestJson), node?.label ?? approval.nodeId);
          approvals.push({
            runId: approval.runId,
            workflowKey,
            nodeId: approval.nodeId,
            iteration: approval.iteration ?? 0,
            requestTitle: request.title ?? node?.label ?? approval.nodeId,
            requestSummary: request.summary,
            requestedAtMs: approval.requestedAtMs ?? null,
            approvalMode: request.mode,
            options: request.options,
            allowedScopes: request.allowedScopes,
            allowedUsers: request.allowedUsers,
            autoApprove: request.autoApprove,
          });
        }
      }
    }
    approvals.sort((a, b) => (a.requestedAtMs ?? 0) - (b.requestedAtMs ?? 0));
    return approvals;
  }
  /**
   * @param {{ kind?: string; includeDeleted?: boolean; updatedAfterMs?: number; limit?: number }} [options]
   */
  async listDocsAcrossWorkflows(options = {}) {
    const seenAdapters = new Set();
    const byPath = new Map();
    const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 4_096)));
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      if (seenAdapters.has(adapter)) {
        continue;
      }
      seenAdapters.add(adapter);
      if (typeof adapter.listDocs !== "function") {
        continue;
      }
      const rows = await adapter.listDocs({
        kind: options.kind,
        includeDeleted: options.includeDeleted,
        updatedAfterMs: options.updatedAfterMs,
        limit,
      });
      for (const row of rows) {
        const existing = byPath.get(row.path);
        if (!existing || (row.updatedAtMs ?? 0) >= (existing.updatedAtMs ?? 0)) {
          byPath.set(row.path, row);
        }
      }
    }
    const docs = [...byPath.values()];
    docs.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0) || String(a.path).localeCompare(String(b.path)));
    return docs.slice(0, limit);
  }
  async listCrons() {
    const rows = [];
    const seenAdapters = new Set();
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      if (seenAdapters.has(adapter)) {
        continue;
      }
      seenAdapters.add(adapter);
      const crons = await adapter.listCrons(false);
      for (const cron of crons) {
        const workflowKey = workflowKeyFromCronPath(cron.workflowPath) ?? entry.key;
        rows.push({
          ...cron,
          workflow: workflowKey,
        });
      }
    }
    rows.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
    return rows;
  }
  /**
   * @param {string} cronId
   */
  async findCron(cronId) {
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      const crons = await adapter.listCrons(false);
      const match = crons.find((cron) => cron.cronId === cronId);
      if (match) {
        return {
          cron: match,
          workflowKey: workflowKeyFromCronPath(match.workflowPath) ?? entry.key,
          adapter,
        };
      }
    }
    return null;
  }
  /**
   * @param {string} runId
   * @returns {Promise<ResolvedRun | null>}
   */
  async resolveRun(runId) {
    const active = this.runRegistry.get(runId);
    if (active) {
      return {
        workflowKey: active.workflowKey,
        workflow: active.workflow,
        adapter: this.adapterForWorkflow(active.workflow),
      };
    }
    const registeredKeys = new Set(this.workflows.keys());
    const seenAdapters = new Set();
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      if (seenAdapters.has(adapter)) {
        continue;
      }
      seenAdapters.add(adapter);
      const run = await adapter.getRun(runId);
      if (run) {
        // Attribute the run to its TRUE workflow (from its stored key /
        // workflowName), not whichever adapter happened to find the row —
        // critical once workflows share a DB. Resolve the owning entry by
        // that key so the returned workflow/adapter are the right ones.
        const workflowKey = this.resolveRunWorkflowKey(run, registeredKeys, entry.key);
        if (!this.workflows.has(workflowKey)) {
          await this.refreshWorkflowRegistryOnMiss(workflowKey);
        }
        const owner = this.workflows.get(workflowKey) ?? entry;
        return {
          workflowKey,
          workflow: owner.workflow,
          adapter: this.adapterForWorkflow(owner.workflow),
        };
      }
    }
    return null;
  }
  /**
   * @param {SmithersEvent} event
   * @returns {string | null}
   */
  terminalRunIdFromSmithersEvent(event) {
    switch (event.type) {
      case "RunFinished":
      case "RunFailed":
      case "RunCancelled":
      case "RunContinuedAsNew":
        return typeof event.runId === "string" ? event.runId : null;
      case "RunStatusChanged":
        return typeof event.runId === "string" && TERMINAL_RUN_STATUSES.has(String(event.status)) ? event.runId : null;
      default:
        return null;
    }
  }
  /**
   * @param {SmithersEvent} event
   */
  handleSmithersEvent(event) {
    // Invalidate devtools baselines before we broadcast the jump event so
    // that in-flight streams emit a fresh full snapshot, not a delta rooted
    // on a stale baseline.
    if (event.type === "TimeTravelJumped" && typeof event.runId === "string") {
      this.invalidateDevToolsSubscribersForRun(event.runId);
    }
    const mapped = this.mapEvent(event);
    if (mapped) {
      this.broadcastEvent(mapped.event, mapped.payload);
    }
    // Broadcast before marking terminal so subscribers see the final event
    // inside the run's live window.
    const terminalRunId = this.terminalRunIdFromSmithersEvent(event);
    if (terminalRunId) {
      this.markRunEventWindowTerminal(terminalRunId);
    }
  }
  /**
   * @param {SmithersEvent} event
   * @returns {{ event: string; payload: unknown } | null}
   */
  mapEvent(event) {
    switch (event.type) {
      case "NodePending":
        return {
          event: "node.pending",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "pending",
            iteration: event.iteration,
          },
        };
      case "NodeStarted":
        return {
          event: "node.started",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "in-progress",
          },
        };
      case "NodeFinished":
        return {
          event: "node.finished",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "finished",
          },
        };
      case "NodeFailed":
        return {
          event: "node.failed",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "failed",
            error: event.error,
          },
        };
      case "NodeSkipped":
        return {
          event: "node.skipped",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "skipped",
          },
        };
      case "NodeCancelled":
        return {
          event: "node.cancelled",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "cancelled",
          },
        };
      case "NodeRetrying":
        return {
          event: "node.retrying",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "in-progress",
            attempt: event.attempt,
          },
        };
      case "NodeOutput":
        return {
          event: "task.output",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            output: event.text,
            stream: event.stream,
          },
        };
      case "ApprovalRequested":
        return {
          event: "approval.requested",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
          },
        };
      case "ApprovalGranted":
        return {
          event: "approval.decided",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            approved: true,
          },
        };
      case "ApprovalAutoApproved":
        return {
          event: "approval.auto_approved",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
          },
        };
      case "ApprovalDenied":
        return {
          event: "approval.decided",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            approved: false,
          },
        };
      case "TaskHeartbeat":
        return {
          event: "task.heartbeat",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            attempt: event.attempt,
          },
        };
      case "NodeWaitingApproval":
        return {
          event: "node.waiting_approval",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "waiting",
            iteration: event.iteration,
          },
        };
      case "NodeWaitingTimer":
        return {
          event: "node.waiting_timer",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "waiting",
            iteration: event.iteration,
          },
        };
      case "AgentEvent":
        return {
          event: "agent.event",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            attempt: event.attempt,
            engine: event.engine,
            event: event.event,
          },
        };
      case "AgentSessionEvent":
        return {
          event: "agent.session",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            attempt: event.attempt,
            transcript: event.transcript,
          },
        };
      case "AgentTraceEvent":
        return {
          event: "agent.trace",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            attempt: event.attempt,
            trace: event.trace,
          },
        };
      case "AgentTraceSummary":
        return {
          event: "agent.trace_summary",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            attempt: event.attempt,
            summary: event.summary,
          },
        };
      case "TokenUsageReported":
        return {
          event: "token.usage",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            attempt: event.attempt,
            model: event.model,
            agent: event.agent,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheWriteTokens: event.cacheWriteTokens,
            reasoningTokens: event.reasoningTokens,
            timestampMs: event.timestampMs,
          },
        };
      case "TimeTravelJumped":
        return {
          event: "run.time_travel_jumped",
          payload: {
            runId: event.runId,
            fromFrameNo: event.fromFrameNo,
            toFrameNo: event.toFrameNo,
            timestampMs: event.timestampMs,
            caller: event.caller ?? null,
          },
        };
      case "SideEffectBoundaryCrossed":
        return {
          event: "run.side_effect_boundary_crossed",
          payload: {
            runId: event.runId,
            opId: event.opId,
            operation: event.operation,
            report: event.report,
            timestampMs: event.timestampMs,
            ...(event.parentRunId != null ? { parentRunId: event.parentRunId } : {}),
            ...(event.warningOnly != null ? { warningOnly: event.warningOnly } : {}),
            ...(event.lateCompletion != null ? { lateCompletion: event.lateCompletion } : {}),
            ...(event.archivedByOp != null ? { archivedByOp: event.archivedByOp } : {}),
          },
        };
      case "RunFinished":
        return {
          event: "run.completed",
          payload: {
            runId: event.runId,
            status: "finished",
            ...(event.failedChildren > 0
              ? {
                  failedChildren: event.failedChildren,
                  failedChildKeys: Array.isArray(event.failedChildKeys) ? event.failedChildKeys : [],
                }
              : {}),
          },
        };
      case "RunFailed":
        return {
          event: "run.completed",
          payload: {
            runId: event.runId,
            status: "failed",
            error: event.error,
          },
        };
      case "RunCancelled":
        return {
          event: "run.completed",
          payload: {
            runId: event.runId,
            status: "cancelled",
          },
        };
      default:
        return null;
    }
  }
  /**
   * @param {GatewayRequestContext} connection
   * @param {RequestFrame} frame
   * @returns {Promise<ResponseFrame>}
   */
  async routeRequest(connection, frame) {
    this.markActivity();
    const rawParams = frame.params;
    const params = asObject(frame.params) ?? {};
    if (isExtensionMethod(frame.method)) {
      return this.routeExtensionRequest(connection, frame, params);
    }
    switch (frame.method) {
      case "health":
        return responseOk(frame.id, {
          protocol: this.protocol,
          features: this.features,
          stateVersion: this.stateVersion,
          uptimeMs: nowMs() - this.startedAtMs,
          identity: this.buildIdentity(),
          ...this.workflowRegistryProgress(),
        });
      case "createBrowserSession":
        return this.browserCall(frame, () => this.browser.create(validateBrowserRequest(frame.method, rawParams)));
      case "browserAct":
        return this.browserCall(frame, () =>
          this.browser.act({
            ...validateBrowserRequest(frame.method, rawParams),
            actor: connection.role === "user" || connection.role === "operator" ? "user" : "agent",
          }),
        );
      case "browserContext":
        return this.browserCall(frame, () => this.browser.context(validateBrowserRequest(frame.method, rawParams)));
      case "browserPick":
        return this.browserCall(frame, () => this.browser.pick(validateBrowserRequest(frame.method, rawParams)));
      case "closeBrowserSession":
        return this.browserCall(frame, () =>
          this.browser.close(validateBrowserRequest(frame.method, rawParams).sessionId),
        );
      case "listBrowserSessions":
        return this.browserCall(frame, () => {
          validateBrowserRequest(frame.method, rawParams);
          return this.browser.list();
        });
      case "runs.list":
      case "listRuns": {
        await this.awaitWorkflowRegistryReady();
        const filter = asObject(params.filter) ?? {};
        const limit = asOptionalPositiveInt(filter.limit, "limit") ?? 50;
        const status = asString(filter.status);
        const workflow = asString(filter.workflow);
        const parentRunId = asString(filter.parentRunId);
        const includeSystem = asBoolean(filter.includeSystem) ?? false;
        // offset pages the newest-first result server-side; 0 is valid
        // (asOptionalPositiveInt rejects it), so parse non-negative here.
        const offsetRaw = filter.offset;
        const offset = offsetRaw === undefined || offsetRaw === null ? 0 : offsetRaw;
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
          return responseError(frame.id, "INVALID_REQUEST", "offset must be a non-negative integer");
        }
        return responseOk(
          frame.id,
          await this.listRunsAcrossWorkflows(limit, status, workflow, offset, includeSystem, parentRunId),
        );
      }
      case "runs.descendants":
      case "listRunDescendants": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const limit = asOptionalPositiveInt(params.limit, "limit") ?? 1_000;
        return responseOk(frame.id, await resolved.adapter.listRunDescendants(runId, limit));
      }
      case "getSchemaSignature": {
        const firstEntry = this.workflows.values().next().value;
        if (!firstEntry) {
          return responseOk(frame.id, {
            schemaVersion: "0000",
            signature: createHash("sha256").update("empty").digest("hex"),
            components: {},
          });
        }
        const adapter = this.adapterForWorkflow(firstEntry.workflow);
        return responseOk(frame.id, await getSmithersSchemaSignature(adapter));
      }
      case "workflows.list":
      case "listWorkflows": {
        await this.awaitWorkflowRegistryReady();
        const filter = asObject(params.filter) ?? {};
        const hasUi = asBoolean(params.hasUi) ?? asBoolean(filter.hasUi);
        const includeSystem = asBoolean(params.includeSystem) ?? asBoolean(filter.includeSystem);
        return responseOk(frame.id, this.listWorkflowSummaries(hasUi, includeSystem));
      }
      case "runs.create":
      case "launchRun": {
        const workflowKey = asString(params.workflow);
        if (!workflowKey) {
          return responseError(frame.id, "INVALID_REQUEST", "workflow is required");
        }
        if (!this.workflows.has(workflowKey)) {
          await this.refreshWorkflowRegistryOnMiss(workflowKey);
        }
        if (!this.workflows.has(workflowKey)) {
          return responseError(frame.id, "NOT_FOUND", `Unknown workflow: ${workflowKey}`);
        }
        let input;
        try {
          input = validateGatewayRpcInput(params.input);
        } catch (error) {
          if (isSmithersError(error)) {
            return responseError(frame.id, error.code, error.summary);
          }
          throw error;
        }
        const options = asObject(params.options) ?? {};
        let startedBy;
        if (options.startedBy !== undefined) {
          try {
            startedBy = parseGatewayStartedBy(options.startedBy);
          } catch (error) {
            return responseError(frame.id, "INVALID_REQUEST", error?.message ?? String(error));
          }
        }
        const runOptions = {
          resume: false,
          maxConcurrency: asNumber(options.maxConcurrency),
          allowNetwork: asBoolean(options.allowNetwork),
          maxOutputBytes: asNumber(options.maxOutputBytes),
          toolTimeoutMs: asNumber(options.toolTimeoutMs),
          ...(startedBy ? { startedBy } : {}),
        };
        return responseOk(
          frame.id,
          await this.startRun(
            workflowKey,
            input,
            {
              triggeredBy: connection.userId ?? "gateway",
              scopes: [...connection.scopes],
              role: connection.role ?? "operator",
              tokenId: connection.tokenId ?? null,
              subscribeConnection: connection,
            },
            asString(params.runId) ?? asString(options.runId) ?? crypto.randomUUID(),
            runOptions,
          ),
        );
      }
      case "resumeRun": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const run = await resolved.adapter.getRun(runId);
        if (!run) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        if (run.status === "finished" || run.status === "failed" || run.status === "cancelled") {
          return responseOk(frame.id, { runId, status: "already_terminal" });
        }
        await this.resumeRunIfNeeded(runId, resolved.workflowKey, resolved.adapter, {
          triggeredBy: connection.userId ?? "gateway",
          scopes: [...connection.scopes],
          role: connection.role ?? "operator",
          tokenId: connection.tokenId ?? null,
          subscribeConnection: connection.transport === "ws" ? connection : undefined,
        });
        return responseOk(frame.id, { runId, status: "resume_requested" });
      }
      case "retryTask": {
        const runId = asString(params.runId);
        const nodeId = asString(params.nodeId);
        if (!runId || !nodeId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId and nodeId are required");
        }
        const iteration = asNumber(params.iteration) ?? 0;
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        // A just-settled run's in-process handle can outlive its
        // terminal DB status by a beat (engine finalization) — wait
        // briefly for the bookkeeping instead of refusing a retry the
        // operator can see is legitimate. A genuinely live run keeps
        // its handle and still gets the honest RUN_ACTIVE below.
        for (let waited = 0; waited < 40 && this.activeRuns.has(runId); waited += 1) {
          await delay(25);
        }
        if (this.activeRuns.has(runId)) {
          return responseError(
            frame.id,
            "RUN_ACTIVE",
            "Run is currently executing — cancel or pause it before retrying a task",
          );
        }
        // Same library machinery as `smithers retry-task`: cancel the
        // node's live/failed attempts, drop its output row, re-insert
        // it (and every node that ran after it) as pending, and flip
        // the run back to running. No engine is spawned here.
        const result = await retryTaskReset(resolved.adapter, {
          runId,
          nodeId,
          iteration,
          resetDependents: asBoolean(params.resetDependents) ?? true,
        });
        if (!result.success) {
          const message = result.error ?? "retry-task failed";
          const code = /not found/i.test(message)
            ? "NOT_FOUND"
            : /still running/i.test(message)
              ? "RUN_ACTIVE"
              : "INVALID_REQUEST";
          return responseError(frame.id, code, message);
        }
        // Resume through the exact path resumeRun takes (in-process
        // engine with resume: true); retryTask already durably set the
        // run's status back to running.
        await this.resumeRunIfNeeded(runId, resolved.workflowKey, resolved.adapter, {
          triggeredBy: connection.userId ?? "gateway",
          scopes: [...connection.scopes],
          role: connection.role ?? "operator",
          tokenId: connection.tokenId ?? null,
          subscribeConnection: connection.transport === "ws" ? connection : undefined,
        });
        return responseOk(frame.id, {
          runId,
          nodeId,
          iteration,
          resetNodes: result.resetNodes,
          status: "retry_requested",
        });
      }
      case "listNodeStates": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const nodes = await resolved.adapter.listNodes(runId);
        const attempts = await resolved.adapter.listAttemptsForRun(runId);
        // Latest attempt per (nodeId, iteration): listAttemptsForRun
        // orders by started_at_ms then attempt, so the last write wins.
        const latestAttempts = new Map();
        for (const attempt of attempts) {
          latestAttempts.set(`${attempt.nodeId}::${attempt.iteration ?? 0}`, attempt);
        }
        return responseOk(
          frame.id,
          nodes.map((node) => {
            const attempt = latestAttempts.get(`${node.nodeId}::${node.iteration ?? 0}`);
            return {
              nodeId: node.nodeId,
              iteration: node.iteration ?? 0,
              state: node.state,
              lastAttempt: node.lastAttempt ?? null,
              updatedAtMs: node.updatedAtMs ?? null,
              label: node.label ?? null,
              startedAtMs: attempt?.startedAtMs ?? null,
              finishedAtMs: attempt?.finishedAtMs ?? null,
            };
          }),
        );
      }
      case "listRunTokenUsage": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const usage = await this.listRunTokenUsage(runId);
        if (!usage) {
          return responseError(frame.id, "RunNotFound", `Run not found: ${runId}`);
        }
        return responseOk(frame.id, usage);
      }
      case "runs.get":
      case "getRun": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const run = await resolved.adapter.getRun(runId);
        if (!run) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const [summary, runState, degradedOutcome] = await Promise.all([
          resolved.adapter.countNodesByState(runId),
          computeRunStateFromRow(resolved.adapter, run).catch(() => undefined),
          readPersistedDegradedOutcome(resolved.adapter, runId, run.status),
        ]);
        const startedBy = runStartedByFromRow(run);
        return responseOk(frame.id, {
          ...run,
          workflowKey: resolved.workflowKey,
          system: runSystemFromRow(run),
          summary: summary.reduce((acc, row) => {
            acc[row.state] = row.count;
            return acc;
          }, {}),
          ...(runState ? { runState } : {}),
          ...(startedBy ? { startedBy } : {}),
          ...degradedOutcome,
        });
      }
      case "frames.list": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const limit = asOptionalPositiveInt(params.limit, "limit") ?? 50;
        const afterFrameNo = asOptionalPositiveInt(params.afterFrameNo, "afterFrameNo");
        return responseOk(frame.id, await resolved.adapter.listFrames(runId, limit, afterFrameNo));
      }
      case "frames.get": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const frameNo = asOptionalPositiveInt(params.frameNo, "frameNo");
        const frameRow =
          frameNo === undefined
            ? await resolved.adapter.getLastFrame(runId)
            : (await resolved.adapter.listFrames(runId, Math.max(frameNo + 1, 50))).find(
                (entry) => entry.frameNo === frameNo,
              );
        if (!frameRow) {
          return responseError(frame.id, "NOT_FOUND", "Frame not found");
        }
        return responseOk(frame.id, frameRow);
      }
      case "attempts.list": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const nodeId = asString(params.nodeId);
        if (nodeId) {
          const iteration = asNumber(params.iteration) ?? 0;
          return responseOk(frame.id, await resolved.adapter.listAttempts(runId, nodeId, iteration));
        }
        return responseOk(frame.id, await resolved.adapter.listAttemptsForRun(runId));
      }
      case "attempts.get": {
        const runId = asString(params.runId);
        const nodeId = asString(params.nodeId);
        const iteration = asNumber(params.iteration);
        const attempt = asNumber(params.attempt);
        if (!runId || !nodeId || iteration === undefined || attempt === undefined) {
          return responseError(frame.id, "INVALID_REQUEST", "runId, nodeId, iteration, and attempt are required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const row = await resolved.adapter.getAttempt(runId, nodeId, iteration, attempt);
        if (!row) {
          return responseError(frame.id, "NOT_FOUND", "Attempt not found");
        }
        return responseOk(frame.id, row);
      }
      case "getNodeOutput":
      case "devtools.getNodeOutput": {
        try {
          const payload = await getNodeOutputRoute({
            runId: params.runId,
            nodeId: params.nodeId,
            iteration: params.iteration,
            resolveRun: this.resolveRun.bind(this),
          });
          return responseOk(frame.id, payload);
        } catch (error) {
          if (error instanceof NodeOutputRouteError) {
            return responseError(frame.id, error.code, error.message);
          }
          throw error;
        }
      }
      case "getNodeDiff":
      case "devtools.getNodeDiff": {
        const result = await runPromise(
          Effect.promise(() =>
            getNodeDiffRoute({
              runId: params.runId,
              nodeId: params.nodeId,
              iteration: params.iteration,
              resolveRun: this.resolveRun.bind(this),
            }),
          ).pipe(Effect.withLogSpan("devtools.getNodeDiff")),
        );
        if (!result.ok) {
          return responseError(frame.id, result.error.code, result.error.message);
        }
        return responseOk(frame.id, result.payload);
      }
      case "getRunDiff": {
        const result = await getRunDiffRoute({
          runId: params.runId,
          resolveRun: this.resolveRun.bind(this),
        });
        if (!result.ok) return responseError(frame.id, result.error.code, result.error.message);
        return responseOk(frame.id, result.payload);
      }
      case "whatHappened": {
        try {
          const payload = await whatHappenedRoute({
            runId: params.runId,
            nodeId: params.nodeId,
            iteration: params.iteration,
            resolveRun: this.resolveRun.bind(this),
            summarize: this.whatHappenedNarrator,
            cache: this.whatHappenedCache,
          });
          return responseOk(frame.id, payload);
        } catch (error) {
          if (error instanceof WhatHappenedRouteError) {
            return responseError(frame.id, error.code, error.message);
          }
          throw error;
        }
      }
      case "getDevToolsSnapshot": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "InvalidRunId", "runId is required");
        }
        try {
          // Full route-level validation runs at the gateway boundary
          // before any DB lookup. Malformed inputs never reach
          // resolveRun() or the adapter.
          validateRunId(runId);
          validateFrameNoInput(params.frameNo);
          if (!this.isDevToolsRunAuthorized(connection, runId)) {
            return responseError(frame.id, "Unauthorized", "Connection is not subscribed to this runId.");
          }
          const resolved = await this.resolveRun(runId);
          if (!resolved) {
            return responseError(frame.id, "RunNotFound", `Run not found: ${runId}`);
          }
          const payload = await getDevToolsSnapshotRoute({
            adapter: resolved.adapter,
            runId,
            frameNo: params.frameNo,
            onWarning: (warning) => {
              emitGatewayLog(
                "warning",
                "devtools snapshot serializer warning",
                {
                  runId,
                  code: warning.code,
                  path: warning.path,
                },
                "gateway:devtools",
              );
            },
          });
          return responseOk(frame.id, payload);
        } catch (error) {
          if (error instanceof DevToolsRouteError) {
            return responseError(frame.id, error.code, error.message);
          }
          throw error;
        }
      }
      case "streamRunEvents": {
        if (connection.transport !== "ws" || !connection.ws) {
          return responseError(
            frame.id,
            "INVALID_REQUEST",
            "streamRunEvents is only supported over websocket connections",
          );
        }
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "InvalidRunId", "runId is required");
        }
        const afterSeq = params.afterSeq;
        if (afterSeq !== undefined && (typeof afterSeq !== "number" || !Number.isInteger(afterSeq) || afterSeq < 0)) {
          return responseError(frame.id, "SeqOutOfRange", "afterSeq must be a non-negative integer");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "RunNotFound", `Run not found: ${runId}`);
        }
        if (connection.closed) {
          // The WS closed while resolveRun() was in flight; its close
          // path already ran cleanupRunEventSubscribers for this
          // connection. Registering now would leak a subscriber that
          // cleanup will never see again (#553).
          return responseError(
            frame.id,
            "ConnectionClosed",
            "Connection closed before subscription could be registered.",
          );
        }
        // Capture a replay cutoff and retained window before registering
        // the live subscriber. Live events emitted after this point are
        // buffered on the replay-pending stream until the captured replay
        // has drained, so they cannot overtake older frames.
        const state = this.runEventWindows.get(runId);
        const currentSeq = state?.nextSeq ?? 0;
        const window = [...(state?.window ?? [])];
        if (typeof afterSeq === "number" && afterSeq > currentSeq) {
          return responseError(
            frame.id,
            "SeqOutOfRange",
            `afterSeq ${afterSeq} is newer than current seq ${currentSeq}`,
          );
        }
        const capViolation = this.runEventStreamCapViolation(connection, runId);
        if (capViolation) {
          emitGatewayLog(
            "warning",
            "Gateway run-event subscriber rejected: cap reached",
            {
              ...gatewayContextAnnotations(connection),
              runId,
              capScope: capViolation.scope,
              capLimit: capViolation.limit,
              subscriberCount: this.runEventSubscriberTotal,
            },
            "gateway:run-events",
          );
          // RateLimited is the stable v1 capacity error code. Clients
          // can retry it without parsing this message.
          return responseError(
            frame.id,
            "RateLimited",
            `Gateway run-event subscriber limit reached (${capViolation.scope} cap of ${capViolation.limit}).`,
            {
              scope: capViolation.scope,
              limit: capViolation.limit,
            },
          );
        }
        const streamId = randomUUID();
        this.registerRunEventSubscriber(connection, streamId, runId, typeof afterSeq === "number");
        queueMicrotask(() => {
          void (async () => {
            if (typeof afterSeq === "number") {
              const firstSeq = window.length > 0 ? Number(window[0].seq) : currentSeq + 1;
              if (window.length > 0 && afterSeq < firstSeq - 1) {
                const snapshot = await this.buildRunSnapshot(runId);
                if (!connection.runEventStreams?.has(streamId)) {
                  return;
                }
                this.sendRunGapResync(connection, streamId, runId, afterSeq + 1, firstSeq - 1, snapshot);
              }
              for (const eventFrame of window) {
                if (Number(eventFrame.seq) > afterSeq) {
                  this.sendRunEventStreamFrame(connection, streamId, eventFrame, true);
                }
              }
              const stream = connection.runEventStreams?.get(streamId);
              if (stream) {
                stream.replayPending = false;
                this.drainRunEventStream(connection, stream);
              }
            }
          })().catch((error) => {
            this.sendEvent(connection, "run.error", {
              streamId,
              runId,
              error: {
                version: SMITHERS_API_VERSION,
                code: "Internal",
                message: error?.message ?? "streamRunEvents replay failed",
              },
            });
            this.unregisterRunEventSubscriber(connection, streamId);
          });
        });
        return responseOk(frame.id, {
          streamId,
          runId,
          afterSeq: typeof afterSeq === "number" ? afterSeq : null,
          currentSeq,
        });
      }
      case "streamDevTools": {
        if (connection.transport !== "ws" || !connection.ws) {
          this.recordDevToolsSubscribeAttempt("error");
          return responseError(
            frame.id,
            "INVALID_REQUEST",
            "streamDevTools is only supported over websocket connections",
          );
        }
        const runId = asString(params.runId);
        if (!runId) {
          this.recordDevToolsSubscribeAttempt("error");
          return responseError(frame.id, "InvalidRunId", "runId is required");
        }
        if (
          typeof params.fromSeq === "number" &&
          typeof params.afterSeq === "number" &&
          params.fromSeq !== params.afterSeq
        ) {
          this.recordDevToolsSubscribeAttempt("error");
          return responseError(frame.id, "SeqOutOfRange", "fromSeq and afterSeq must match when both are provided");
        }
        const fromSeq = typeof params.fromSeq === "number" ? params.fromSeq : params.afterSeq;
        const streamId = randomUUID();
        try {
          // Full route-level validation at the gateway boundary so
          // malformed numeric inputs never reach resolveRun() or
          // getLastFrame() below.
          validateRunId(runId);
          validateFromSeqInput(fromSeq);
          if (!this.isDevToolsRunAuthorized(connection, runId)) {
            this.recordDevToolsSubscribeAttempt("error");
            return responseError(frame.id, "Unauthorized", "Connection is not subscribed to this runId.");
          }
          const resolved = await this.resolveRun(runId);
          if (!resolved) {
            this.recordDevToolsSubscribeAttempt("error");
            return responseError(frame.id, "RunNotFound", `Run not found: ${runId}`);
          }
          if (typeof fromSeq === "number") {
            const latestFrame = await resolved.adapter.getLastFrame(runId);
            // Zero-frame runs: current seq is 0. fromSeq > 0 is in
            // the future relative to current seq and must reject.
            const latestSeq = latestFrame?.frameNo ?? 0;
            if (fromSeq > latestSeq) {
              this.recordDevToolsSubscribeAttempt("error");
              return responseError(
                frame.id,
                "SeqOutOfRange",
                `fromSeq ${fromSeq} is newer than current seq ${latestSeq}`,
              );
            }
          }
          if (connection.closed) {
            // The WS closed while resolveRun()/getLastFrame() were in
            // flight; its close path already ran
            // cleanupDevToolsSubscribers for this connection.
            // Registering now would leak a subscriber that stays in
            // devtoolsSubscribers with a never-aborted signal (#553).
            this.recordDevToolsSubscribeAttempt("error");
            return responseError(
              frame.id,
              "ConnectionClosed",
              "Connection closed before subscription could be registered.",
            );
          }
          const abort = this.registerDevToolsSubscriber(connection, streamId, runId);
          emitGatewayLog(
            "info",
            "devtools stream subscribed",
            {
              runId,
              fromSeq: typeof fromSeq === "number" ? fromSeq : null,
              streamId,
              subscriberId: connection.connectionId,
            },
            "gateway:devtools",
          );
          // Per-subscriber outbound queue gated on actual WS send
          // pressure. If the WS socket has buffered > limit bytes,
          // we queue locally up to 1000 events; exceeding that is a
          // BackpressureDisconnect that tears down only this stream.
          const outboundQueue = [];
          let flushPending = false;
          const drainOutboundQueue = () => {
            if (flushPending) return;
            flushPending = true;
            queueMicrotask(() => {
              try {
                while (outboundQueue.length > 0 && connection.ws.readyState === connection.ws.OPEN) {
                  const ws = connection.ws;
                  if (
                    typeof ws.bufferedAmount === "number" &&
                    ws.bufferedAmount > DEVTOOLS_STREAM_WS_BUFFERED_HIGH_WATER_BYTES
                  ) {
                    setTimeout(() => {
                      flushPending = false;
                      drainOutboundQueue();
                    }, 10);
                    return;
                  }
                  const payload = outboundQueue.shift();
                  if (!payload) continue;
                  this.sendEvent(connection, "devtools.event", payload);
                }
              } finally {
                flushPending = false;
              }
            });
          };
          /**
           * Send a devtools event through the outbound queue. Applies
           * WS-level backpressure detection and raises a typed
           * BackpressureDisconnect if the queue overflows.
           */
          const enqueueDevToolsEvent = (payload) => {
            if (outboundQueue.length >= DEVTOOLS_STREAM_OUTBOUND_QUEUE_LIMIT) {
              throw new DevToolsRouteError(
                "BackpressureDisconnect",
                `Subscriber outbound queue exceeded ${DEVTOOLS_STREAM_OUTBOUND_QUEUE_LIMIT} events.`,
              );
            }
            outboundQueue.push(payload);
            drainOutboundQueue();
          };
          void (async () => {
            let eventsDelivered = 0;
            try {
              for await (const event of streamDevToolsRoute({
                adapter: resolved.adapter,
                runId,
                fromSeq: typeof fromSeq === "number" ? fromSeq : undefined,
                subscriberId: connection.connectionId,
                signal: abort.signal,
                invalidateSnapshot: () => {
                  if (this.devtoolsInvalidateFlags.has(streamId)) {
                    this.devtoolsInvalidateFlags.delete(streamId);
                    return true;
                  }
                  return false;
                },
                onWarning: (warning) => {
                  emitGatewayLog(
                    "warning",
                    "devtools snapshot serializer warning",
                    {
                      runId,
                      code: warning.code,
                      path: warning.path,
                    },
                    "gateway:devtools",
                  );
                },
                onLog: (level, message, fields) => {
                  emitGatewayLog(level === "warn" ? "warning" : level, message, fields, "gateway:devtools");
                },
                onEvent: (event, stats) => {
                  const kind = event.kind;
                  emitGatewayEffect(
                    Effect.all(
                      [
                        Metric.update(taggedMetric(devtoolsEventTotal, { kind }), 1),
                        Metric.update(devtoolsEventBytes, stats.bytes),
                        ...(kind === "snapshot"
                          ? [Metric.update(devtoolsSnapshotBuildMs, stats.durationMs)]
                          : [Metric.update(devtoolsDeltaBuildMs, stats.durationMs)]),
                      ],
                      { discard: true },
                    ),
                  );
                },
                onClose: ({ errorCode }) => {
                  if (errorCode === "BackpressureDisconnect") {
                    emitGatewayEffect(Metric.update(devtoolsBackpressureDisconnectTotal, 1));
                  }
                },
              })) {
                eventsDelivered += 1;
                enqueueDevToolsEvent({
                  streamId,
                  runId,
                  event,
                });
              }
            } catch (error) {
              const code = error?.code ?? "SERVER_ERROR";
              if (code === "BackpressureDisconnect") {
                emitGatewayEffect(Metric.update(devtoolsBackpressureDisconnectTotal, 1));
              }
              emitGatewayLog(
                "error",
                "devtools stream failed",
                {
                  runId,
                  streamId,
                  code,
                  message: error?.message ?? "stream failed",
                },
                "gateway:devtools",
              );
              // Notify ONLY the offending subscriber. The WS
              // stays open so other subscribers on the same
              // connection continue to receive events.
              this.sendEvent(connection, "devtools.error", {
                streamId,
                runId,
                error: {
                  code,
                  message: error?.message ?? "stream failed",
                },
              });
            } finally {
              this.unregisterDevToolsSubscriber(connection, streamId, {
                runId,
                streamId,
                eventsDelivered,
              });
            }
          })();
          return responseOk(frame.id, {
            streamId,
            runId,
            fromSeq: typeof fromSeq === "number" ? fromSeq : null,
            afterSeq: typeof fromSeq === "number" ? fromSeq : null,
          });
        } catch (error) {
          this.recordDevToolsSubscribeAttempt("error");
          if (error instanceof DevToolsRouteError) {
            return responseError(frame.id, error.code, error.message);
          }
          throw error;
        }
      }
      case "hijackRun": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "InvalidRunId", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "RunNotFound", `Run not found: ${runId}`);
        }
        return responseOk(frame.id, {
          runId,
          status: "hijack-ready",
          sessionId: randomUUID(),
        });
      }
      case "rewindRun":
      case "jumpToFrame":
      case "devtools.jumpToFrame": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "InvalidRunId", "runId is required");
        }
        const frameNo = asNumber(params.frameNo);
        if (frameNo === undefined) {
          return responseError(frame.id, "InvalidFrameNo", "frameNo is required");
        }
        const confirm = asBoolean(params.confirm);
        const force = asBoolean(params.force);
        const noRevert = asBoolean(params.noRevert);
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "RunNotFound", `Run not found: ${runId}`);
        }
        const run = await resolved.adapter.getRun(runId);
        if (!run) {
          return responseError(frame.id, "RunNotFound", `Run not found: ${runId}`);
        }
        const ownerId = resolveRunOwnerId(run);
        const isAdmin = (connection.role ?? "").toLowerCase() === "admin";
        const isOwner = Boolean(ownerId && connection.userId && ownerId === connection.userId);
        if (!isAdmin && !isOwner) {
          // Record the unauthorized attempt so the audit log contains
          // every rewind request — successful or not.
          try {
            await writeRewindAuditRow(resolved.adapter, {
              runId,
              fromFrameNo: -1,
              toFrameNo: Number.isInteger(frameNo) ? frameNo : -1,
              caller: connection.userId ?? "gateway",
              timestampMs: nowMs(),
              result: "failed",
              durationMs: 0,
            });
          } catch (auditError) {
            emitGatewayLog(
              "warning",
              "Gateway jumpToFrame unauthorized audit-write failed",
              {
                runId,
                ...gatewayErrorAnnotations(auditError),
              },
              "gateway:jump-to-frame",
            );
          }
          return responseError(frame.id, "Unauthorized", "Only the run owner or an admin may rewind this run.");
        }
        const active = this.activeRuns.get(runId);
        try {
          const payload = await jumpToFrameRoute({
            adapter: resolved.adapter,
            runId,
            frameNo,
            confirm,
            force,
            noRevert,
            caller: connection.userId ?? "gateway",
            pauseRunLoop: async () => {
              if (!active) {
                return;
              }
              active.abort.abort();
              const timeoutAt = Date.now() + 10_000;
              while (this.activeRuns.has(runId) && Date.now() < timeoutAt) {
                await delay(25);
              }
              // Hard stop: if the task is still live after the grace
              // window, abort the rewind rather than mutating the DB
              // underneath a running task.
              if (this.activeRuns.has(runId)) {
                throw new JumpToFrameError(
                  "RewindFailed",
                  `Run ${runId} did not stop within 10s of abort; refusing to rewind a live task.`,
                  {
                    details: { runId, stage: "pause" },
                  },
                );
              }
            },
            resumeRunLoop: async () => {
              await this.resumeRunIfNeeded(runId, resolved.workflowKey, resolved.adapter, {
                triggeredBy: connection.userId ?? "gateway",
                scopes: [...connection.scopes],
                role: connection.role ?? "operator",
                tokenId: connection.tokenId ?? null,
                subscribeConnection: connection.transport === "ws" ? connection : undefined,
              });
            },
            emitEvent: async (event) => {
              this.handleSmithersEvent(event);
            },
            onLog: async (level, message, fields) => {
              emitGatewayLog(
                level === "warn" ? "warning" : level,
                message,
                {
                  runId,
                  frameNo,
                  caller: connection.userId ?? "gateway",
                  ...fields,
                },
                "gateway:jump-to-frame",
              );
            },
          });
          return responseOk(frame.id, payload);
        } catch (error) {
          if (error instanceof JumpToFrameError) {
            return responseError(frame.id, error.code, error.message, error.details ? { details: error.details } : {});
          }
          throw error;
        }
      }
      case "runs.diff": {
        const leftRunId = asString(params.leftRunId);
        const rightRunId = asString(params.rightRunId);
        if (!leftRunId || !rightRunId) {
          return responseError(frame.id, "INVALID_REQUEST", "leftRunId and rightRunId are required");
        }
        const left = await this.resolveRun(leftRunId);
        const right = await this.resolveRun(rightRunId);
        if (!left || !right) {
          return responseError(frame.id, "NOT_FOUND", "Both runs must exist");
        }
        const leftSnapshot = await loadLatestSnapshot(left.adapter, leftRunId);
        const rightSnapshot = await loadLatestSnapshot(right.adapter, rightRunId);
        if (!leftSnapshot || !rightSnapshot) {
          return responseError(frame.id, "NOT_FOUND", "Snapshots not found for both runs");
        }
        return responseOk(frame.id, diffRawSnapshots(leftSnapshot, rightSnapshot));
      }
      case "approvals.list":
      case "listApprovals": {
        const filter = asObject(params.filter) ?? {};
        const runId = asString(params.runId) ?? asString(filter.runId);
        const workflow = asString(params.workflow) ?? asString(filter.workflow);
        const limit = asOptionalPositiveInt(params.limit ?? filter.limit, "limit");
        let approvals = await this.listPendingApprovals();
        if (runId) {
          approvals = approvals.filter((approval) => approval.runId === runId);
        }
        if (workflow) {
          approvals = approvals.filter((approval) => approval.workflowKey === workflow);
        }
        if (limit !== undefined) {
          approvals = approvals.slice(0, limit);
        }
        return responseOk(frame.id, approvals);
      }
      case "listDocs": {
        const filter = asObject(params.filter) ?? {};
        const kind = asString(params.kind) ?? asString(filter.kind);
        const includeDeleted = asBoolean(params.includeDeleted) ?? asBoolean(filter.includeDeleted) ?? false;
        const updatedAfterMs = asNumber(params.updatedAfterMs) ?? asNumber(filter.updatedAfterMs);
        const limit = asOptionalPositiveInt(params.limit ?? filter.limit, "limit") ?? 4_096;
        return responseOk(
          frame.id,
          await this.listDocsAcrossWorkflows({
            kind,
            includeDeleted,
            updatedAfterMs,
            limit,
          }),
        );
      }
      case "approvals.decide":
      case "submitApproval": {
        const runId = asString(params.runId);
        const nodeId = asString(params.nodeId);
        const stableDecision = asObject(params.decision);
        const approved = asBoolean(params.approved) ?? asBoolean(stableDecision?.approved);
        const iteration = asNumber(params.iteration) ?? 0;
        if (!runId || !nodeId || approved === undefined) {
          return responseError(frame.id, "INVALID_REQUEST", "runId, nodeId, and approved are required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const approval = await resolved.adapter.getApproval(runId, nodeId, iteration);
        if (approval && approval.status !== "requested") {
          return responseError(frame.id, "AlreadyDecided", `Approval for ${nodeId} has already been decided`, {
            runId,
            nodeId,
            iteration,
            status: approval.status,
          });
        }
        const request = parseApprovalRequest(
          parseJson(typeof approval?.requestJson === "string" ? approval.requestJson : null),
          nodeId,
        );
        if (request.restrictionError) {
          return responseError(frame.id, "INVALID_REQUEST", `Malformed approval request: ${request.restrictionError}`);
        }
        if (
          request.allowedUsers.length > 0 &&
          (!connection.userId || !request.allowedUsers.includes(connection.userId))
        ) {
          return responseError(frame.id, "FORBIDDEN", "User is not allowed to decide this approval");
        }
        if (
          request.allowedScopes.length > 0 &&
          !request.allowedScopes.some((scope) => hasApprovalScope(connection.scopes, scope))
        ) {
          return responseError(frame.id, "FORBIDDEN", "Connection is missing required approval scope");
        }
        const decision = stableDecision && "value" in stableDecision ? stableDecision.value : params.decision;
        const note = asString(params.note) ?? asString(stableDecision?.note);
        if (approved) {
          const validation = validateApprovalDecision(request, decision);
          if (!validation.ok) {
            return responseError(frame.id, validation.code, validation.message);
          }
        }
        if (approved) {
          const { approveNode } = await loadEngineApprovals();
          await Effect.runPromise(
            approveNode(resolved.adapter, runId, nodeId, iteration, note, connection.userId ?? undefined, decision),
          );
        } else {
          const { denyNode } = await loadEngineApprovals();
          await Effect.runPromise(
            denyNode(resolved.adapter, runId, nodeId, iteration, note, connection.userId ?? undefined, decision),
          );
        }
        this.resumeRunInBackground(runId, resolved.workflowKey, resolved.adapter, {
          triggeredBy: connection.userId ?? "gateway",
          scopes: [...connection.scopes],
          role: connection.role ?? "operator",
          tokenId: connection.tokenId ?? null,
          subscribeConnection: connection,
        });
        return responseOk(frame.id, { runId, nodeId, iteration, approved });
      }
      case "signals.send":
      case "submitSignal": {
        const runId = asString(params.runId);
        const correlationKey = asString(params.correlationKey);
        const signalName = asString(params.signalName) ?? correlationKey;
        if (!runId || !signalName) {
          return responseError(frame.id, "INVALID_REQUEST", "runId and signalName are required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const { signalRun } = await loadEngineSignals();
        const delivered = await Effect.runPromise(
          signalRun(resolved.adapter, runId, signalName, params.data ?? params.payload ?? {}, {
            correlationId: asString(params.correlationId) ?? correlationKey,
            receivedBy: connection.userId,
          }),
        );
        await this.resumeRunIfNeeded(runId, resolved.workflowKey, resolved.adapter, {
          triggeredBy: connection.userId ?? "gateway",
          scopes: [...connection.scopes],
          role: connection.role ?? "operator",
          tokenId: connection.tokenId ?? null,
          subscribeConnection: connection,
        });
        return responseOk(frame.id, delivered);
      }
      case "runs.cancel":
      case "cancelRun": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const active = this.activeRuns.get(runId);
        if (active) {
          const resolved = await this.resolveRun(runId).catch(() => null);
          if (!resolved) {
            return responseError(frame.id, "RunNotFound", "Run not found");
          }
          const { finalizeCancelledRun } = await loadEngineRuntime();
          const claimed = await finalizeCancelledRun(resolved.adapter, runId, { now: Date.now() });
          if (claimed.won) active.abort.abort();
          return responseOk(frame.id, claimed);
        }
        const resolved = await this.resolveRun(runId).catch(() => null);
        const run = resolved ? await resolved.adapter.getRun(runId) : null;
        if (!resolved || !run) {
          return responseError(frame.id, "RunNotFound", "Run not found");
        }
        if (
          ![
            "running",
            "waiting-approval",
            "waiting-event",
            "waiting-timer",
            "waiting-quota",
            "paused",
            "cancelled",
            "canceled",
          ].includes(run.status)
        ) {
          return responseError(frame.id, "RUN_NOT_ACTIVE", "Run is not currently active");
        }
        const { finalizeCancelledRun } = await loadEngineRuntime();
        const result = await finalizeCancelledRun(resolved.adapter, runId);
        return responseOk(frame.id, result);
      }
      case "runs.pause":
      case "pauseRun": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId).catch(() => null);
        const run = resolved ? await resolved.adapter.getRun(runId) : null;
        if (!resolved || !run) {
          return responseError(frame.id, "RunNotFound", "Run not found");
        }
        if (run.status !== "running") {
          return responseError(frame.id, "RUN_NOT_ACTIVE", "Run is not currently executing");
        }
        // Durable pause request: the engine's pause-watcher stops scheduling,
        // drains in-flight tasks, then writes the resumable `paused` status.
        // Unlike cancel, this never aborts the run's tasks.
        await runPromise(resolved.adapter.requestRunPause(runId, nowMs()));
        return responseOk(frame.id, { runId, status: "pausing" });
      }
      case "runs.rerun": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const { resolveSchema } = await loadEngineRuntime();
        const inputTable = resolveSchema(resolved.workflow.db).input;
        if (!inputTable) {
          return responseError(frame.id, "MISSING_INPUT_TABLE", "Schema must include input table");
        }
        const input = normalizeRerunInput(await loadInput(resolved.workflow.db, inputTable, runId));
        return this.routeRequest(connection, {
          type: "req",
          id: frame.id,
          method: "runs.create",
          params: {
            workflow: resolved.workflowKey,
            input,
            runId: asString(params.newRunId),
          },
        });
      }
      case "cron.list":
      case "cronList": {
        const filter = asObject(params.filter) ?? {};
        const workflowFilter = asString(filter.workflow);
        const rows = await this.listCrons();
        return responseOk(frame.id, workflowFilter ? rows.filter((row) => row.workflow === workflowFilter) : rows);
      }
      case "cron.add":
      case "cronCreate": {
        const workflowKey = asString(params.workflow);
        const pattern = asString(params.pattern);
        if (!workflowKey || !pattern) {
          return responseError(frame.id, "INVALID_REQUEST", "workflow and pattern are required");
        }
        if (!this.workflows.has(workflowKey)) {
          await this.refreshWorkflowRegistryOnMiss(workflowKey);
        }
        const entry = this.workflows.get(workflowKey);
        if (!entry) {
          return responseError(frame.id, "NOT_FOUND", `Unknown workflow: ${workflowKey}`);
        }
        const cronId = asString(params.cronId) ?? randomUUID();
        const adapter = this.adapterForWorkflow(entry.workflow);
        const row = {
          cronId,
          pattern,
          workflowPath: cronWorkflowPath(workflowKey),
          enabled: asBoolean(params.enabled) ?? true,
          createdAtMs: nowMs(),
          lastRunAtMs: null,
          nextRunAtMs: nextCronRunAtMs(pattern),
          errorJson: null,
        };
        await adapter.upsertCron(row);
        return responseOk(frame.id, {
          ...row,
          workflow: workflowKey,
        });
      }
      case "cron.remove":
      case "cronDelete": {
        const cronId = asString(params.cronId);
        if (!cronId) {
          return responseError(frame.id, "INVALID_REQUEST", "cronId is required");
        }
        const resolvedCron = await this.findCron(cronId);
        if (!resolvedCron) {
          return responseError(frame.id, "NOT_FOUND", `Cron not found: ${cronId}`);
        }
        await resolvedCron.adapter.deleteCron(cronId);
        return responseOk(frame.id, { cronId, removed: true });
      }
      case "cron.trigger":
      case "cronRun": {
        const cronId = asString(params.cronId);
        const workflowKey = asString(params.workflow);
        const resolvedCron = cronId ? await this.findCron(cronId) : null;
        const targetWorkflowKey = resolvedCron?.workflowKey ?? workflowKey;
        if (!targetWorkflowKey) {
          return responseError(frame.id, "INVALID_REQUEST", "cronId or workflow is required");
        }
        if (resolvedCron) {
          await resolvedCron.adapter.updateCronRunTime(
            resolvedCron.cron.cronId,
            nowMs(),
            nextCronRunAtMs(resolvedCron.cron.pattern),
            null,
          );
        }
        let input;
        try {
          input = validateGatewayRpcInput(params.input);
        } catch (error) {
          if (isSmithersError(error)) {
            return responseError(frame.id, error.code, error.summary);
          }
          throw error;
        }
        return responseOk(
          frame.id,
          await this.startRun(
            targetWorkflowKey,
            input,
            {
              triggeredBy: connection.userId ?? "gateway",
              scopes: [...connection.scopes],
              role: connection.role ?? "operator",
              tokenId: connection.tokenId ?? null,
              subscribeConnection: connection,
            },
            undefined,
            { resume: false },
          ),
        );
      }
      case "listAccounts": {
        return responseOk(frame.id, this.listAccountsFromRegistry());
      }
      case "listUsageReports": {
        return responseOk(frame.id, await this.listUsageReports({ fresh: asBoolean(params.fresh) ?? false }));
      }
      case "listMemoryFacts": {
        const namespace = asString(params.namespace);
        return responseOk(frame.id, await this.listMemoryFactsAcrossWorkflows(namespace ?? null));
      }
      case "listPrompts": {
        return responseOk(frame.id, this.listPromptsFromDisk());
      }
      case "listScores": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const nodeId = asString(params.nodeId);
        const scores = await this.listScoresForRun(runId, nodeId ?? null);
        if (scores === null) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        return responseOk(frame.id, scores);
      }
      case "listScoresForRuns": {
        const allowed = new Set(["runIds", "nodeId", "scorerId", "scorerName", "source", "order", "offset", "limit"]);
        const unexpected = Object.keys(params).find((key) => !allowed.has(key));
        if (unexpected) {
          return responseError(frame.id, "INVALID_REQUEST", `Unexpected listScoresForRuns parameter: ${unexpected}`);
        }
        let runIds;
        let nodeId;
        let scorerId;
        let scorerName;
        let source;
        let order;
        let offset;
        let limit;
        try {
          runIds = normalizeScoreRunIds(params.runIds);
          nodeId = optionalScoreFilter(params.nodeId, "nodeId");
          scorerId = optionalScoreFilter(params.scorerId, "scorerId");
          scorerName = optionalScoreFilter(params.scorerName, "scorerName");
          source = optionalScoreSource(params.source);
          order = scoreResultOrder(params.order);
          offset = boundedScorePageInteger(params.offset, "offset", 0, 0, SCORE_COMPARE_MAX_OFFSET);
          limit = boundedScorePageInteger(
            params.limit,
            "limit",
            SCORE_COMPARE_DEFAULT_LIMIT,
            1,
            SCORE_COMPARE_MAX_LIMIT,
          );
          if (offset + limit > SCORE_COMPARE_MAX_WINDOW) {
            throw new SmithersError("INVALID_REQUEST", `offset + limit must not exceed ${SCORE_COMPARE_MAX_WINDOW}`);
          }
        } catch (error) {
          if (isSmithersError(error)) {
            return responseError(frame.id, error.code, error.summary);
          }
          throw error;
        }
        if (runIds.length === 0) {
          return responseOk(frame.id, { rows: [], total: 0 });
        }
        const result = await this.listScoresForRunsAcrossStores({
          runIds,
          nodeId,
          scorerId,
          scorerName,
          source,
          order,
          offset,
          limit,
        });
        if ("missingRunId" in result) {
          return responseError(frame.id, "RunNotFound", `Run not found: ${result.missingRunId}`);
        }
        return responseOk(frame.id, result);
      }
      case "getScoreDetail": {
        const unexpected = Object.keys(params).find((key) => key !== "runId" && key !== "scoreId");
        if (unexpected) {
          return responseError(frame.id, "INVALID_REQUEST", `Unexpected getScoreDetail parameter: ${unexpected}`);
        }
        if (typeof params.runId !== "string" || typeof params.scoreId !== "string") {
          return responseError(frame.id, "INVALID_REQUEST", "runId and scoreId must be strings");
        }
        const runId = params.runId.trim();
        const scoreId = params.scoreId.trim();
        if (!runId || !scoreId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId and scoreId must not be blank");
        }
        if (runId.length > DB_RUN_ID_MAX_LENGTH) {
          return responseError(
            frame.id,
            "INVALID_REQUEST",
            `runId must be at most ${DB_RUN_ID_MAX_LENGTH} characters after trimming`,
          );
        }
        if (scoreId.length > SCORE_ID_MAX_LENGTH) {
          return responseError(
            frame.id,
            "INVALID_REQUEST",
            `scoreId must be at most ${SCORE_ID_MAX_LENGTH} characters after trimming`,
          );
        }
        const result = await this.getScoreDetailForRun(runId, scoreId);
        if ("missing" in result) {
          return result.missing === "run"
            ? responseError(frame.id, "RunNotFound", `Run not found: ${runId}`)
            : responseError(frame.id, "ScoreNotFound", `Score not found on run ${runId}: ${scoreId}`);
        }
        return responseOk(frame.id, result.detail);
      }
      case "listTickets": {
        const kind = asString(params.kind);
        return responseOk(frame.id, await this.listTicketsAcrossWorkflows(kind ?? null));
      }
      case "createTicket": {
        const path = asString(params.path);
        const content = asString(params.content);
        if (!path) {
          return responseError(frame.id, "INVALID_REQUEST", "path is required");
        }
        if (content === undefined) {
          return responseError(frame.id, "INVALID_REQUEST", "content is required");
        }
        const created = await this.createTicketDoc({
          path,
          content,
          kind: asString(params.kind),
          status: asString(params.status),
        });
        if (created === null) {
          return responseError(frame.id, "INVALID_REQUEST", "No workflow is registered to back ticket storage");
        }
        return responseOk(frame.id, created);
      }
      case "updateTicket": {
        const path = asString(params.path);
        if (!path) {
          return responseError(frame.id, "INVALID_REQUEST", "path is required");
        }
        const updated = await this.updateTicketDoc({
          path,
          content: asString(params.content),
          status: asString(params.status),
        });
        if (updated === false) {
          return responseError(frame.id, "INVALID_REQUEST", "No workflow is registered to back ticket storage");
        }
        if (updated === null) {
          return responseError(frame.id, "NOT_FOUND", `Ticket not found: ${path}`);
        }
        return responseOk(frame.id, updated);
      }
      case "deleteTicket": {
        const path = asString(params.path);
        if (!path) {
          return responseError(frame.id, "INVALID_REQUEST", "path is required");
        }
        const removed = await this.deleteTicketDoc(path);
        if (removed === false) {
          return responseError(frame.id, "INVALID_REQUEST", "No workflow is registered to back ticket storage");
        }
        if (removed === null) {
          return responseError(frame.id, "NOT_FOUND", `Ticket not found: ${path}`);
        }
        return responseOk(frame.id, { path, deleted: true });
      }
      default:
        return responseError(frame.id, "METHOD_NOT_FOUND", `Unknown method: ${frame.method}`);
    }
  }
  async browserCall(frame, operation) {
    try {
      return responseOk(frame.id, await operation());
    } catch (error) {
      const candidate = error?.code === "INVALID_REQUEST" ? "InvalidRequest" : error?.code;
      const code =
        typeof candidate === "string" && Object.prototype.hasOwnProperty.call(GATEWAY_RPC_ERRORS, candidate)
          ? candidate
          : "Internal";
      return responseError(frame.id, code, error?.message ?? "Browser operation failed", error?.details);
    }
  }
  /**
   * Dispatch an `ext.*` RPC. Resources/actions are resolved to a handler that
   * gets the validated params plus a context bundle (scopes, ids, abort
   * signal); streams allocate a stream id, attach the subscriber, and replay
   * any `initial` snapshot before deferring further frames to `ctx.send`.
   *
   * Errors are normalized into the same wire envelope as built-in RPCs.
   * Handler-thrown SmithersErrors keep their code/summary; everything else
   * surfaces as `EXTENSION_HANDLER_ERROR` with the message text but no stack
   * (leaking handler internals to the wire would be a security regression).
   *
   * @param {GatewayRequestContext} connection
   * @param {RequestFrame} frame
   * @param {Record<string, unknown>} params
   * @returns {Promise<ResponseFrame>}
   */
  async routeExtensionRequest(connection, frame, params) {
    const resolved = this.extensions.resolve(frame.method);
    if (!resolved) {
      // Typed `EXTENSION_METHOD_NOT_FOUND` distinguishes a bad ext.*
      // dispatch from a missing builtin RPC method; UI code can tell the
      // user "no such extension" without parsing the message text.
      return responseError(frame.id, EXTENSION_METHOD_NOT_FOUND_CODE, `Unknown extension method: ${frame.method}`, {
        method: frame.method,
      });
    }
    // Per-extension scope is re-checked here even though the gateway
    // handleSocket / handleHttpRpc paths already gate the connection. This
    // belt-and-braces re-check exists so a future refactor that bypasses
    // `hasScope` cannot accidentally elevate an extension RPC.
    if (!hasScope(connection.scopes, frame.method, this.extensions)) {
      return responseForbidden(frame.id, frame.method, this.extensions);
    }
    if (resolved.kind === "stream") {
      return this.subscribeExtensionStream(connection, frame, params, resolved);
    }
    const abort = new AbortController();
    // Track the pending handler so a connection drop can abort it without
    // waiting for the handler to notice. This is the difference between
    // honouring AbortSignal "on disconnect" (correct) and only aborting in
    // the local `finally` after the handler resolves (review blocker).
    this.trackExtensionPendingHandler(connection, abort);
    const ctx = {
      namespace: resolved.namespace,
      key: resolved.key,
      kind: resolved.kind,
      scopes: [...connection.scopes],
      userId: connection.userId ?? null,
      tokenId: connection.tokenId ?? null,
      connectionId: connection.connectionId ?? null,
      signal: abort.signal,
    };
    try {
      const result = await resolved.entry.handler(params, ctx);
      // Guard against oversized payloads BEFORE shipping back to the wire.
      // A misbehaving extension shouldn't be able to OOM a UI client or
      // wedge the WS backpressure queue.
      const serialized = JSON.stringify(result ?? null);
      if (Buffer.byteLength(serialized, "utf8") > EXTENSION_PAYLOAD_MAX_BYTES) {
        return responseError(
          frame.id,
          "PayloadTooLarge",
          `Extension ${frame.method} payload exceeds ${EXTENSION_PAYLOAD_MAX_BYTES} bytes.`,
          {
            maxBytes: EXTENSION_PAYLOAD_MAX_BYTES,
          },
        );
      }
      return responseOk(frame.id, result ?? null);
    } catch (error) {
      if (isSmithersError(error)) {
        return responseError(frame.id, error.code, error.summary, asObject(error.details) ?? {});
      }
      return responseError(frame.id, "EXTENSION_HANDLER_ERROR", error?.message ?? "Extension handler failed.");
    } finally {
      abort.abort();
      this.untrackExtensionPendingHandler(connection, abort);
    }
  }
  /**
   * Register a pending handler abort controller against a connection so the
   * disconnect / cleanup path can fire its `.abort()` and stop in-flight work
   * even if the handler never resolves.
   *
   * @param {GatewayRequestContext} connection
   * @param {AbortController} abort
   */
  trackExtensionPendingHandler(connection, abort) {
    let set = this.extensionPendingHandlers.get(connection);
    if (!set) {
      set = new Set();
      this.extensionPendingHandlers.set(connection, set);
    }
    set.add(abort);
  }
  /**
   * Remove a pending handler abort from the per-connection set. Safe to call
   * even when the connection has already been cleaned up.
   *
   * @param {GatewayRequestContext} connection
   * @param {AbortController} abort
   */
  untrackExtensionPendingHandler(connection, abort) {
    const set = this.extensionPendingHandlers.get(connection);
    if (!set) {
      return;
    }
    set.delete(abort);
    if (set.size === 0) {
      this.extensionPendingHandlers.delete(connection);
    }
  }
  /**
   * Fire the abort signal on every pending resource/action handler for a
   * connection. Called from the disconnect path so handlers respecting
   * `ctx.signal` stop work immediately instead of returning into a dead
   * socket and racing the cleanup of dependent resources.
   *
   * @param {GatewayRequestContext} connection
   */
  cleanupExtensionPendingHandlers(connection) {
    const set = this.extensionPendingHandlers.get(connection);
    if (!set) {
      return;
    }
    this.extensionPendingHandlers.delete(connection);
    for (const abort of set) {
      try {
        abort.abort();
      } catch {
        /* swallow */
      }
    }
  }
  /**
   * Attach a subscriber to an extension stream. The wire response carries the
   * allocated `streamId` (and any `initial` snapshot for resume semantics).
   * Further frames flow as `ext.stream` events tagged with `streamId` so a
   * stale subscriber on the same connection can fence late frames after it
   * unsubscribed and re-subscribed.
   *
   * @param {GatewayRequestContext} connection
   * @param {RequestFrame} frame
   * @param {Record<string, unknown>} params
   * @param {import("./GatewayExtensions.js").ResolvedExtension & { kind: "stream", entry: import("./GatewayExtensions.js").GatewayExtensionStream }} resolved
   * @returns {Promise<ResponseFrame>}
   */
  async subscribeExtensionStream(connection, frame, params, resolved) {
    if (connection.transport !== "ws" || !connection.ws) {
      return responseError(
        frame.id,
        "INVALID_REQUEST",
        `Extension stream ${frame.method} is only supported over websocket connections.`,
      );
    }
    const streamId = randomUUID();
    const abort = new AbortController();
    let cleanupFn = async () => {};
    // Per-subscriber outbound queue + WS-level backpressure detection.
    // Mirrors the devtools slow-consumer guard so a chatty extension cannot
    // monopolize the shared outbound buffer or evict frames for other
    // subscribers on the same connection. Overflow raises a typed
    // BackpressureDisconnect that tears down ONLY this stream.
    /** @type {Array<Record<string, unknown>>} */
    const outboundQueue = [];
    let flushPending = false;
    let backpressureDisconnected = false;
    const drainOutboundQueue = () => {
      if (flushPending) return;
      flushPending = true;
      queueMicrotask(() => {
        try {
          while (outboundQueue.length > 0 && connection.ws.readyState === connection.ws.OPEN && !abort.signal.aborted) {
            const ws = connection.ws;
            if (typeof ws.bufferedAmount === "number" && ws.bufferedAmount > EXTENSION_WS_BUFFERED_HIGH_WATER_BYTES) {
              setTimeout(() => {
                flushPending = false;
                drainOutboundQueue();
              }, 10);
              return;
            }
            const envelope = outboundQueue.shift();
            if (!envelope) continue;
            this.sendEvent(connection, "ext.stream.event", envelope);
          }
        } finally {
          flushPending = false;
        }
      });
    };
    const tearDownForBackpressure = () => {
      if (backpressureDisconnected) return;
      backpressureDisconnected = true;
      this.sendEvent(connection, "ext.stream.error", {
        streamId,
        namespace: resolved.namespace,
        key: resolved.key,
        error: {
          version: SMITHERS_API_VERSION,
          code: EXTENSION_BACKPRESSURE_DISCONNECT_CODE,
          message: `Extension stream outbound queue exceeded ${EXTENSION_STREAM_OUTBOUND_QUEUE_LIMIT} events.`,
        },
      });
      abort.abort();
      const map = this.extensionStreamSubscriptions.get(connection);
      if (map) {
        map.delete(streamId);
        if (map.size === 0) {
          this.extensionStreamSubscriptions.delete(connection);
        }
      }
      // Cleanup callback runs detached so a hung extension cleanup
      // cannot wedge this disconnect path.
      const c = cleanupFn;
      void (async () => {
        try {
          await c();
        } catch {
          /* swallow */
        }
      })();
    };
    const send = (payload) => {
      if (abort.signal.aborted || backpressureDisconnected) {
        return;
      }
      const envelope = {
        streamId,
        namespace: resolved.namespace,
        key: resolved.key,
        payload,
      };
      // Bounded payload check on each stream frame too. A streaming
      // extension is the more likely OOM vector — a slow UI consumer can
      // sit on a 4 MiB JSON every 100 ms.
      const serialized = JSON.stringify(envelope);
      if (Buffer.byteLength(serialized, "utf8") > EXTENSION_PAYLOAD_MAX_BYTES) {
        this.sendEvent(connection, "ext.stream.error", {
          streamId,
          namespace: resolved.namespace,
          key: resolved.key,
          error: {
            version: SMITHERS_API_VERSION,
            code: "PayloadTooLarge",
            message: `Extension stream frame exceeds ${EXTENSION_PAYLOAD_MAX_BYTES} bytes.`,
          },
        });
        return;
      }
      if (outboundQueue.length >= EXTENSION_STREAM_OUTBOUND_QUEUE_LIMIT) {
        tearDownForBackpressure();
        return;
      }
      outboundQueue.push(envelope);
      drainOutboundQueue();
    };
    const streamCtx = {
      namespace: resolved.namespace,
      key: resolved.key,
      kind: "stream",
      streamId,
      scopes: [...connection.scopes],
      userId: connection.userId ?? null,
      tokenId: connection.tokenId ?? null,
      connectionId: connection.connectionId ?? null,
      signal: abort.signal,
      send,
    };
    try {
      const result = await resolved.entry.subscribe(params, streamCtx);
      let initial;
      if (typeof result === "function") {
        cleanupFn = async () => {
          await result();
        };
      } else if (result && typeof result === "object") {
        if (typeof result.cleanup === "function") {
          const c = result.cleanup;
          cleanupFn = async () => {
            await c();
          };
        }
        if ("initial" in result) {
          initial = result.initial;
        }
      }
      if (connection.closed) {
        // The WS closed while resolved.entry.subscribe() was in flight;
        // its close path already ran cleanupExtensionSubscriptions for
        // this connection. Registering now would leak whatever
        // handler-owned resources (DB cursors, watchers, shape
        // handles) the subscribe call above just acquired (#553).
        abort.abort();
        try {
          await cleanupFn();
        } catch {
          /* swallow */
        }
        return responseError(
          frame.id,
          "ConnectionClosed",
          "Connection closed before subscription could be registered.",
        );
      }
      // Size-bound the initial snapshot the same way ctx.send frames are
      // bounded. An extension that crams 100 MiB into `initial` would
      // otherwise sail past EXTENSION_PAYLOAD_MAX_BYTES because the
      // initial replay is delivered on the response frame, not via
      // sendEvent. Reject early + clean up.
      if (initial !== undefined) {
        const serializedInitial = JSON.stringify(initial);
        if (Buffer.byteLength(serializedInitial, "utf8") > EXTENSION_PAYLOAD_MAX_BYTES) {
          abort.abort();
          try {
            await cleanupFn();
          } catch {
            /* swallow */
          }
          return responseError(
            frame.id,
            "PayloadTooLarge",
            `Extension ${frame.method} initial payload exceeds ${EXTENSION_PAYLOAD_MAX_BYTES} bytes.`,
            {
              maxBytes: EXTENSION_PAYLOAD_MAX_BYTES,
            },
          );
        }
      }
      if (!this.extensionStreamSubscriptions.has(connection)) {
        this.extensionStreamSubscriptions.set(connection, new Map());
      }
      const map = this.extensionStreamSubscriptions.get(connection);
      map.set(streamId, {
        namespace: resolved.namespace,
        key: resolved.key,
        abort,
        cleanup: cleanupFn,
      });
      return responseOk(frame.id, {
        streamId,
        namespace: resolved.namespace,
        key: resolved.key,
        ...(initial !== undefined ? { initial } : {}),
      });
    } catch (error) {
      abort.abort();
      try {
        await cleanupFn();
      } catch {
        /* swallow */
      }
      if (isSmithersError(error)) {
        return responseError(frame.id, error.code, error.summary, asObject(error.details) ?? {});
      }
      return responseError(frame.id, "EXTENSION_HANDLER_ERROR", error?.message ?? "Extension subscribe failed.");
    }
  }
  /**
   * Tear down every extension stream attached to a connection. Called from
   * the existing socket cleanup path so a disconnect releases handler-owned
   * resources (subscriptions, db cursors, ElectricSQL shape handles, etc.)
   * even if the handler never observed the abort signal.
   *
   * @param {GatewayRequestContext} connection
   */
  async cleanupExtensionSubscriptions(connection) {
    // Also abort any in-flight resource/action handlers so they observe
    // ctx.signal and stop work — long-running RPCs must not keep running
    // after the connection drops.
    this.cleanupExtensionPendingHandlers(connection);
    const map = this.extensionStreamSubscriptions.get(connection);
    if (!map) {
      return;
    }
    this.extensionStreamSubscriptions.delete(connection);
    // Abort every stream up front so callbacks see the signal immediately,
    // then await all cleanups concurrently with allSettled. A single hung
    // cleanup must not block tearing down the other streams or returning
    // from the disconnect path — every cleanup gets its own detached
    // microtask, isolated from its peers.
    for (const { abort } of map.values()) {
      try {
        abort.abort();
      } catch {
        /* swallow */
      }
    }
    await Promise.allSettled(Array.from(map.values()).map(({ cleanup }) => Promise.resolve().then(() => cleanup())));
  }
}
function sameOriginNextPath(rawNext) {
  if (typeof rawNext !== "string" || !rawNext.startsWith("/")) return "/";
  // Reject any authority form: second char "/" or "\\", or an embedded
  // backslash anywhere (a browser rewrites "\\" to "/" before parsing).
  if (rawNext.length >= 2 && (rawNext[1] === "/" || rawNext[1] === "\\")) return "/";
  if (rawNext.includes("\\")) return "/";
  try {
    const base = "http://smithers.invalid";
    const resolved = new URL(rawNext, base);
    if (resolved.origin !== base) return "/";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}
