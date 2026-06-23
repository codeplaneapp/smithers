import * as _smithers_orchestrator_db_adapter_RunRow from '@smithers-orchestrator/db/adapter/RunRow';
import * as node_http from 'node:http';
import * as _smithers_orchestrator_observability_SmithersEvent from '@smithers-orchestrator/observability/SmithersEvent';
import * as _smithers_orchestrator_components_SmithersWorkflow from '@smithers-orchestrator/components/SmithersWorkflow';
import { SmithersWorkflow as SmithersWorkflow$1 } from '@smithers-orchestrator/components/SmithersWorkflow';
import * as _smithers_orchestrator_db_adapter from '@smithers-orchestrator/db/adapter';
import { SmithersDb as SmithersDb$4 } from '@smithers-orchestrator/db/adapter';
import * as hono from 'hono';
import { Hono } from 'hono';
import * as hono_types from 'hono/types';
import { Effect } from 'effect';
import * as effect_Fiber from 'effect/Fiber';
import * as _smithers_orchestrator_protocol_errors from '@smithers-orchestrator/protocol/errors';
import * as _smithers_orchestrator_devtools_snapshotSerializer from '@smithers-orchestrator/devtools/snapshotSerializer';
import * as _smithers_orchestrator_protocol_devtools from '@smithers-orchestrator/protocol/devtools';
import * as _smithers_orchestrator_engine_effect_DiffBundle from '@smithers-orchestrator/engine/effect/DiffBundle';
import { DiffBundle } from '@smithers-orchestrator/engine/effect/DiffBundle';
import { selectOutputRow } from '@smithers-orchestrator/db/output';
import * as _smithers_orchestrator_time_travel_jumpToFrame from '@smithers-orchestrator/time-travel/jumpToFrame';
export { JumpToFrameError } from '@smithers-orchestrator/time-travel/jumpToFrame';

type ServerOptions$1 = {
    port?: number;
    db?: unknown;
    authToken?: string;
    maxBodyBytes?: number;
    rootDir?: string;
    allowNetwork?: boolean;
    /**
     * Maximum time (in milliseconds) allowed for the HTTP parser to receive the
     * complete headers of a single request. Helps mitigate slowloris attacks.
     * @default 30000
     */
    headersTimeout?: number;
    /**
     * Maximum time (in milliseconds) allowed for a single request to be received
     * and parsed, including the body. Helps mitigate slowloris attacks.
     * @default 60000
     */
    requestTimeout?: number;
};

type ResponseFrame$1 = {
    type: "res";
    id: string;
    ok: boolean;
    apiVersion?: "v1";
    payload?: unknown;
    error?: {
        version?: "v1";
        code: string;
        message: string;
        requiredScope?: string;
        refresh?: string;
        details?: unknown;
    };
};

type RequestFrame$1 = {
    type: "req";
    id: string;
    method: string;
    params?: unknown;
};

type GatewayWebhookSignalConfig$1 = {
    name: string;
    correlationIdPath?: string;
    runIdPath?: string;
    payloadPath?: string;
};

type GatewayWebhookRunConfig$1 = {
    enabled?: boolean;
    inputPath?: string;
};

type GatewayWebhookConfig$1 = {
    secret: string;
    signatureHeader?: string;
    signaturePrefix?: string;
    signal?: GatewayWebhookSignalConfig$1;
    run?: GatewayWebhookRunConfig$1;
};

type GatewayTokenGrant$1 = {
    role: string;
    scopes: string[];
    userId?: string;
    tokenId?: string;
    issuedAtMs?: number;
    expiresAtMs?: number;
    revokedAtMs?: number;
};

type GatewayAuthConfig$1 = {
    mode: "token";
    tokens: Record<string, GatewayTokenGrant$1>;
    /**
     * Optional Origin allow-list (defense-in-depth). When non-empty, a request
     * or WS upgrade carrying a browser `Origin` header not on the list is
     * rejected; requests with no `Origin` (server-to-server / CLI) are allowed.
     * Unset/empty preserves the prior allow-all behavior.
     */
    allowedOrigins?: string[];
} | {
    mode: "jwt";
    issuer: string;
    audience: string | string[];
    secret: string;
    scopesClaim?: string;
    roleClaim?: string;
    userClaim?: string;
    defaultRole?: string;
    defaultScopes?: string[];
    clockSkewSeconds?: number;
    /**
     * Optional Origin allow-list (defense-in-depth). When non-empty, a request
     * or WS upgrade carrying a browser `Origin` header not on the list is
     * rejected; requests with no `Origin` (server-to-server / CLI) are allowed.
     * Unset/empty preserves the prior allow-all behavior.
     */
    allowedOrigins?: string[];
} | {
    mode: "trusted-proxy";
    trustedHeaders?: string[];
    allowedOrigins?: string[];
    defaultRole?: string;
    defaultScopes?: string[];
};

type GatewayDefaults$1 = {
    cliAgentTools?: "all" | "explicit-only";
    outOfProcessEventBridge?: boolean;
    outOfProcessEventBridgePollMs?: number;
};

type GatewayOperatorUiConfig$1 = {
    /**
     * URL path for the built-in operator console.
     * @default "/console"
     */
    path?: string;
    /**
     * Document title for the generated HTML shell.
     */
    title?: string;
    /**
     * JSON-serializable boot data exposed to the browser.
     */
    props?: Record<string, unknown>;
};

type GatewayUiConfig$1 = true | {
    /**
     * Browser entry module for the React app. Smithers bundles this with Bun and
     * serves it from the Gateway origin. Pass `true` to mount the built-in
     * operator console.
     */
    entry: string;
    /**
     * URL path where the UI is mounted. Gateway-level UI defaults to `/`;
     * workflow-level UI defaults to `/workflows/<workflowKey>`.
     */
    path?: string;
    /**
     * Document title for the generated HTML shell.
     */
    title?: string;
    /**
     * JSON-serializable boot data exposed to the browser.
     */
    props?: Record<string, unknown>;
};

type GatewayOptions$1 = {
    protocol?: number;
    features?: string[];
    heartbeatMs?: number;
    auth?: GatewayAuthConfig$1;
    ui?: GatewayUiConfig$1;
    /**
     * Absolute path to the workspace root — the directory that holds the
     * `.smithers/` registry (workflows, prompts, components) and `smithers.db`.
     *
     * Disk-backed registry reads (currently the `listPrompts` RPC, which walks
     * `<workspaceRoot>/.smithers/prompts/`) resolve relative to this root rather
     * than `process.cwd()`. Set it whenever the gateway runs with its cwd
     * elsewhere than the workspace — e.g. an app that binds the gateway to an
     * ABSOLUTE workspace DB path without `chdir`-ing into the workspace (the
     * studio dev server passes `SMITHERS_STUDIO_WORKSPACE` here). When omitted,
     * these reads fall back to `process.cwd()`, which is correct for the common
     * case where the gateway boots from the workspace root.
     */
    workspaceRoot?: string;
    /**
     * Built-in browser console for operators. Set to false to disable it.
     * @default { path: "/console" }
     */
    operatorUi?: GatewayOperatorUiConfig$1 | false;
    defaults?: GatewayDefaults$1;
    maxBodyBytes?: number;
    maxPayload?: number;
    maxConnections?: number;
    /**
     * Per-run replay window for Gateway run event streams.
     * @default 10000
     */
    eventWindowSize?: number;
    /**
     * Bridge persisted run events from the workspace DB into live Gateway streams
     * for runs executed by another process.
     * @default true
     */
    outOfProcessEventBridge?: boolean;
    /**
     * Poll interval (in milliseconds) for the out-of-process event bridge.
     * @default 1000
     */
    outOfProcessEventBridgePollMs?: number;
    /**
     * Maximum time (in milliseconds) allowed for the HTTP parser to receive the
     * complete headers of a single request. Helps mitigate slowloris attacks.
     * @default 30000
     */
    headersTimeout?: number;
    /**
     * Maximum time (in milliseconds) allowed for a single request to be received
     * and parsed, including the body. Helps mitigate slowloris attacks.
     * @default 60000
     */
    requestTimeout?: number;
};

type ConnectRequest$1 = {
    minProtocol: number;
    maxProtocol: number;
    client: {
        id: string;
        version: string;
        platform: string;
    };
    auth?: {
        token: string;
    };
    subscribe?: string[];
};

type HelloResponse$1 = {
    protocol: number;
    features: string[];
    policy: {
        heartbeatMs: number;
    };
    auth: {
        sessionToken: string;
        role: string;
        scopes: string[];
        userId: string | null;
    };
    snapshot: {
        runs: unknown[];
        approvals: unknown[];
        stateVersion: number;
    };
};

type GatewayRegisterOptions$1 = {
    schedule?: string;
    webhook?: GatewayWebhookConfig$1;
    ui?: GatewayUiConfig$1;
};

type EventFrame$1 = {
    type: "event";
    event: string;
    payload?: unknown;
    seq: number;
    stateVersion: number;
    apiVersion?: "v1";
};

/**
 * Build the canonical extension method name. Useful in tests and tooling.
 * @param {string} namespace
 * @param {"resource" | "action" | "stream"} kind
 * @param {string} key
 */
declare function extensionMethodName(namespace: string, kind: "resource" | "action" | "stream", key: string): string;
/**
 * @param {string} method
 */
declare function isExtensionMethod(method: string): boolean;
/**
 * Hard ceiling on a single extension response payload byte size after JSON
 * serialization. Keeps a runaway extension from blowing through the gateway's
 * inbound `maxPayload` on the wire and from monopolizing the per-connection
 * outbound buffer. Mirrors the spirit of `NODE_OUTPUT_MAX_BYTES` (8 MiB) but is
 * a hair smaller so a misbehaving extension surfaces an `ExtensionPayloadTooLarge`
 * before it pegs the WS backpressure limit and gets the connection killed.
 */
declare const EXTENSION_PAYLOAD_MAX_BYTES: number;
/**
 * Per-stream outbound event queue ceiling. Mirrors the devtools slow-consumer
 * guard. Once the queue grows beyond this size the gateway raises a typed
 * `BackpressureDisconnect` and tears the stream down so a single chatty
 * extension cannot starve other consumers on the same socket.
 */
declare const EXTENSION_STREAM_OUTBOUND_QUEUE_LIMIT: 1000;
/**
 * Outbound WebSocket buffer high-water threshold. Same constant the devtools
 * stream uses — when the underlying ws.bufferedAmount exceeds this, we pause
 * the per-stream drain and back off via a microtask + timer.
 */
declare const EXTENSION_WS_BUFFERED_HIGH_WATER_BYTES: number;
/**
 * Typed error codes the gateway emits for extension-RPC routing failures.
 * Keeps METHOD_NOT_FOUND reserved for builtin RPCs so a UI can tell "the
 * extension namespace/key was wrong" apart from "the builtin route was
 * misnamed" without parsing the message text.
 */
declare const EXTENSION_METHOD_NOT_FOUND_CODE: "EXTENSION_METHOD_NOT_FOUND";
declare const EXTENSION_BACKPRESSURE_DISCONNECT_CODE: "BackpressureDisconnect";
declare class GatewayExtensions {
    /** @type {Map<string, GatewayExtensionDefinition>} */
    namespaces: Map<string, GatewayExtensionDefinition>;
    /** Track resource + action keys per namespace so namespaced collisions are caught at register time. */
    /** @type {Map<string, Set<string>>} */
    invocableKeys: Map<string, Set<string>>;
    /** @type {Map<string, Set<string>>} */
    streamKeys: Map<string, Set<string>>;
    /**
     * @param {string} namespace
     * @param {GatewayExtensionDefinition} definition
     */
    register(namespace: string, definition: GatewayExtensionDefinition): this;
    /**
     * @param {string} method
     * @returns {ResolvedExtension | undefined}
     */
    resolve(method: string): ResolvedExtension | undefined;
    /**
     * Pre-flight scope lookup for a method name, used by `requiredScopeForMethod`
     * in the gateway so the standard auth pipeline can refuse an unauthorized
     * extension RPC before the handler runs.
     * @param {string} method
     * @returns {GatewayScope | undefined}
     */
    requiredScopeForMethod(method: string): GatewayScope | undefined;
    /**
     * Enumerate registered extensions (for diagnostics / introspection).
     */
    list(): {
        namespace: string;
        title: string | undefined;
        description: string | undefined;
        defaultScope: GatewayScope | undefined;
        resources: string[];
        actions: string[];
        streams: string[];
    }[];
}
type GatewayScope = "run:read" | "run:write" | "run:admin" | "approval:submit" | "signal:submit" | "cron:read" | "cron:write" | "observability:read";
type GatewayExtensionContext = {
    namespace: string;
    key: string;
    kind: "resource" | "action" | "stream";
    /**
     * Scopes granted to the calling connection.
     */
    scopes: readonly string[];
    userId: string | null;
    tokenId: string | null;
    connectionId: string | null;
    /**
     * Aborted when the connection drops or the
     * stream is unsubscribed. Resource/action handlers should respect it on long
     * work so a stale request cannot stomp a fresh one.
     */
    signal: AbortSignal;
};
type GatewayExtensionStreamContext = {
    namespace: string;
    key: string;
    kind: "stream";
    /**
     * Stable per-subscription id (used to fence stale
     * replies on reconnect / fast-toggle).
     */
    streamId: string;
    scopes: readonly string[];
    userId: string | null;
    tokenId: string | null;
    connectionId: string | null;
    signal: AbortSignal;
    /**
     * Push a frame to this subscriber.
     * Drops silently if the connection has closed; backpressure on the underlying
     * WS is enforced by the existing slow-consumer guard in Gateway.
     */
    send: (payload: unknown) => void;
};
type GatewayExtensionResource = {
    /**
     * Required scope; defaults to namespace
     * `defaultScope`, then `run:read`.
     */
    scope?: GatewayScope | undefined;
    /**
     * Human-readable label (for diagnostics).
     */
    title?: string | undefined;
    handler: (params: Record<string, unknown>, ctx: GatewayExtensionContext) => Promise<unknown> | unknown;
};
type GatewayExtensionAction = {
    /**
     * Defaults to namespace `defaultScope`, then `run:write`.
     */
    scope?: GatewayScope | undefined;
    title?: string | undefined;
    handler: (params: Record<string, unknown>, ctx: GatewayExtensionContext) => Promise<unknown> | unknown;
};
type GatewayExtensionStream = {
    /**
     * Defaults to namespace `defaultScope`, then `run:read`.
     */
    scope?: GatewayScope | undefined;
    title?: string | undefined;
    /**
     *   Called once when a subscriber attaches. Returns either a `cleanup` callable
     *   (no replay frame) or an `{initial, cleanup}` envelope where `initial` is
     *   the first frame delivered to the subscriber (replay snapshot used for
     *   resume after a reconnect).
     */
    subscribe: (params: Record<string, unknown>, ctx: GatewayExtensionStreamContext) => Promise<{
        initial?: unknown;
        cleanup?: () => void | Promise<void>;
    } | (() => void | Promise<void>) | void>;
};
type GatewayExtensionDefinition = {
    title?: string | undefined;
    description?: string | undefined;
    defaultScope?: GatewayScope | undefined;
    resources?: Record<string, GatewayExtensionResource> | undefined;
    /**
     *   Alias for `resources`; both surfaces route the same way. Useful when an
     *   extension wants to draw a read/write line in code.
     */
    queries?: Record<string, GatewayExtensionResource> | undefined;
    actions?: Record<string, GatewayExtensionAction> | undefined;
    streams?: Record<string, GatewayExtensionStream> | undefined;
};
type ResolvedExtension = {
    kind: "resource" | "action" | "stream";
    namespace: string;
    key: string;
    scope: GatewayScope;
    entry: GatewayExtensionResource | GatewayExtensionAction | GatewayExtensionStream;
};
declare const EXTENSION_METHOD_PREFIX: "ext.";
declare const EXTENSION_STREAM_METHOD_PREFIX: "ext.stream.";

/**
 * @param {unknown} method
 * @returns {string}
 */
declare function validateGatewayMethodName(method: unknown): string;
/**
 * @param {unknown} raw
 * @returns {RequestFrame}
 */
declare function parseGatewayRequestFrame(raw: unknown, maxPayloadBytes?: number): RequestFrame;
/**
 * @param {unknown} value
 * @returns {number}
 */
declare function getGatewayInputDepth(value: unknown): number;
/**
 * @param {unknown} value
 * @returns {number}
 */
declare function assertGatewayInputDepthWithinBounds(value: unknown, maxDepth?: number): number;
/**
 * @param {string | undefined} code
 */
declare function statusForRpcError(code: string | undefined): 400 | 401 | 403 | 404 | 409 | 429 | 413 | 501 | 500;
declare const GATEWAY_RPC_MAX_PAYLOAD_BYTES: 1048576;
declare const GATEWAY_RPC_MAX_DEPTH: 32;
declare const GATEWAY_RPC_MAX_ARRAY_LENGTH: 256;
declare const GATEWAY_RPC_MAX_STRING_LENGTH: number;
declare const GATEWAY_METHOD_NAME_MAX_LENGTH: 64;
declare const GATEWAY_FRAME_ID_MAX_LENGTH: 128;
declare const GATEWAY_RPC_INPUT_MAX_BYTES: 1048576;
declare const GATEWAY_RPC_INPUT_MAX_DEPTH: 32;
declare class Gateway {
    /** Map a stored `_smithers_docs` row (camel-cased) onto the wire `GatewayTicketRow`. */
    static toTicketRow(row: any): {
        path: any;
        kind: any;
        content: any;
        contentHash: any;
        status: any;
        updatedAtMs: any;
    };
    /**
   * @param {GatewayOptions} [options]
   */
    constructor(options?: GatewayOptions);
    protocol: number;
    features: string[];
    heartbeatMs: number;
    maxBodyBytes: number;
    maxPayload: number;
    maxConnections: number;
    eventWindowSize: number;
    outOfProcessEventBridge: boolean;
    outOfProcessEventBridgePollMs: number;
    headersTimeout: number;
    requestTimeout: number;
    auth: GatewayAuthConfig$1 | undefined;
    ui: ResolvedGatewayUiConfig | null;
    operatorUi: ResolvedGatewayUiConfig | null;
    uiApp: hono.Hono<hono_types.BlankEnv, hono_types.BlankSchema, "/">;
    defaults: GatewayDefaults$1 | undefined;
    /**
     * Absolute workspace root for disk-backed registry reads (e.g. the
     * `listPrompts` RPC, which walks `<workspaceRoot>/.smithers/prompts/`).
     * `null` ⇒ fall back to `process.cwd()`. Set from `options.workspaceRoot`.
     * @type {string | null}
     */
    workspaceRoot: string | null;
    workflows: Map<any, any>;
    connections: Set<any>;
    runRegistry: Map<any, any>;
    activeRuns: Map<any, any>;
    inflightRuns: Map<any, any>;
    devtoolsSubscribers: Map<any, any>;
    runEventWindows: Map<any, any>;
    /** Absolute active subscriber count per runId (gauge source of truth). */
    devtoolsSubscriberCounts: Map<any, any>;
    /** Flagged subscriber IDs that should force a snapshot on their next emit. */
    devtoolsInvalidateFlags: Set<any>;
    uiAssetCache: Map<any, any>;
    /** @type {GatewayExtensions} */
    extensions: GatewayExtensions;
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
    extensionStreamSubscriptions: WeakMap<GatewayRequestContext, Map<string, {
        namespace: string;
        key: string;
        abort: AbortController;
        cleanup: () => Promise<void>;
    }>>;
    /**
     * Per-connection in-flight resource/action handler aborts. A long-running
     * extension RPC (LLM call, remote API hit) must NOT keep running after the
     * client cancels or disconnects — `cleanupExtensionPendingHandlers` fires
     * the abort signal on connection close so handlers that observe `ctx.signal`
     * can stop work immediately instead of completing into a dead socket.
     * @type {WeakMap<GatewayRequestContext, Set<AbortController>>}
     */
    extensionPendingHandlers: WeakMap<GatewayRequestContext, Set<AbortController>>;
    server: null;
    wsServer: null;
    schedulerTimer: null;
    outOfProcessEventBridgeTimer: null;
    outOfProcessEventBridgeStopped: boolean;
    outOfProcessEventBridgeLastFedSeq: Map<any, any>;
    outOfProcessEventBridgeDrainedRuns: Set<any>;
    stateVersion: number;
    startedAtMs: number;
    /**
   * @returns {GatewayUiMount[]}
   */
    getUiMounts(): GatewayUiMount[];
    /**
   * @param {string} pathname
   * @returns {GatewayUiMount | null}
   */
    findUiMount(pathname: string): GatewayUiMount | null;
    /**
   * @param {string} pathname
   */
    resolveUiMatch(pathname: string): {
        pathname: string;
        mountPath: string;
        assetPath: string | null;
        config: GatewayUiMount;
    } | null;
    /**
   * @param {GatewayUiMount} mount
   */
    uiBootConfig(mount: GatewayUiMount): {
        apiVersion: "v1";
        kind: "workflow" | "gateway" | "operator";
        workflowKey: string | null;
        mountPath: string;
        rpcPath: string;
        wsPath: string;
        assetBasePath: string;
        props: Record<string, unknown>;
    };
    /**
   * @param {{ config: GatewayUiMount }} match
   */
    renderUiIndex(match: {
        config: GatewayUiMount;
    }): string;
    /**
   * @param {{ config: GatewayUiMount; assetPath: string | null }} match
   */
    renderUiAsset(match: {
        config: GatewayUiMount;
        assetPath: string | null;
    }): Promise<{
        body: string;
        contentType: string;
    } | null>;
    /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
    handleUiHttp(req: IncomingMessage, res: ServerResponse$1): Promise<boolean>;
    /**
   * @param {string} key
   * @param {RegisteredWorkflow} entry
   */
    workflowSummary(key: string, entry: RegisteredWorkflow): {
        hasUi: boolean;
        uiPath: string | null;
        description?: string | undefined;
        readableName?: string | undefined;
        key: string;
    };
    /**
   * @param {boolean | undefined} hasUi
   */
    listWorkflowSummaries(hasUi: boolean | undefined): {
        hasUi: boolean;
        uiPath: string | null;
        description?: string | undefined;
        readableName?: string | undefined;
        key: string;
    }[];
    authModeLabel(): string;
    /**
   * @param {string} [runId]
   * @returns {number}
   */
    getDevToolsSubscriberCount(runId?: string): number;
    /**
   * Record a single subscribe attempt outcome. Centralised so that invalid
   * runId, missing run, SeqOutOfRange, etc. still update
   * `smithers_devtools_subscribe_total{result="error"}`.
   *
   * @param {"ok" | "error"} result
   */
    recordDevToolsSubscribeAttempt(result: "ok" | "error"): void;
    /**
   * Push the absolute active-subscriber count to the Prometheus gauge. The
   * `runId` is hashed for bounded cardinality.
   *
   * @param {string} runId
   */
    publishDevToolsActiveSubscribersGauge(runId: string): void;
    /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {string} runId
   * @returns {AbortController}
   */
    registerDevToolsSubscriber(connection: ConnectionState, streamId: string, runId: string): AbortController;
    /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {Record<string, unknown>} [details]
   */
    unregisterDevToolsSubscriber(connection: ConnectionState, streamId: string, details?: Record<string, unknown>): void;
    /**
   * Flag every active subscriber for `runId` to rebaseline on its next emit.
   * Called when the gateway observes `TimeTravelJumped` for that run.
   *
   * @param {string} runId
   */
    invalidateDevToolsSubscribersForRun(runId: string): void;
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
    isDevToolsRunAuthorized(connection: ConnectionState | null | undefined, runId: string): boolean;
    /**
   * @param {ConnectionState} connection
   */
    cleanupDevToolsSubscribers(connection: ConnectionState): void;
    /**
   * @param {string} runId
   * @returns {{ nextSeq: number; window: Array<Record<string, unknown>> }}
   */
    getRunEventWindow(runId: string): {
        nextSeq: number;
        window: Array<Record<string, unknown>>;
    };
    /**
   * @param {string} event
   * @param {unknown} payload
   * @param {number} stateVersion
   * @returns {Record<string, unknown> | null}
   */
    appendRunEventWindow(event: string, payload: unknown, stateVersion: number): Record<string, unknown> | null;
    /**
   * @param {string} runId
   * @returns {number}
   */
    getRunEventCurrentSeq(runId: string): number;
    /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {string} runId
   * @returns {() => void}
   */
    registerRunEventSubscriber(connection: ConnectionState, streamId: string, runId: string): () => void;
    /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   */
    unregisterRunEventSubscriber(connection: ConnectionState, streamId: string): void;
    /**
   * @param {ConnectionState} connection
   */
    cleanupRunEventSubscribers(connection: ConnectionState): void;
    /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {Record<string, unknown>} frame
   */
    sendRunEventStreamFrame(connection: ConnectionState, streamId: string, frame: Record<string, unknown>): void;
    /**
   * Drain a run event stream's outbound queue against the socket's buffered
   * bytes. If the socket is congested past the high-water mark we re-arm a
   * short retry instead of dropping frames; the queue cap (enforced at enqueue
   * time) is what bounds memory and trips the slow-consumer disconnect.
   * @param {ConnectionState} connection
   * @param {RunEventStreamState} stream
   */
    drainRunEventStream(connection: ConnectionState, stream: RunEventStreamState): void;
    /**
   * Tear down a single slow run event subscriber whose outbound queue overflowed.
   * The WS connection itself stays open so other streams keep receiving events.
   * @param {ConnectionState} connection
   * @param {RunEventStreamState} stream
   */
    disconnectRunEventStreamForBackpressure(connection: ConnectionState, stream: RunEventStreamState): void;
    /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {string} runId
   * @param {number} fromSeq
   * @param {number} toSeq
   * @param {unknown} snapshot
   */
    sendRunGapResync(connection: ConnectionState, streamId: string, runId: string, fromSeq: number, toSeq: number, snapshot: unknown): void;
    /**
   * @param {string} runId
   */
    buildRunSnapshot(runId: string): Promise<any>;
    /**
   * @param {GatewayTransport} transport
   * @param {string} frameType
   * @param {GatewayMetricLabels} [labels]
   */
    recordMessageReceived(transport: GatewayTransport, frameType: string, labels?: GatewayMetricLabels): void;
    /**
   * @param {GatewayTransport} transport
   * @param {string} frameType
   * @param {GatewayMetricLabels} [labels]
   */
    recordMessageSent(transport: GatewayTransport, frameType: string, labels?: GatewayMetricLabels): void;
    /**
   * @param {GatewayTransport} transport
   * @param {"success" | "failure"} outcome
   * @param {GatewayRequestContext} context
   * @param {Record<string, unknown>} [details]
   * @param {"debug" | "info" | "warning"} [level]
   */
    recordAuthEvent(transport: GatewayTransport, outcome: "success" | "failure", context: GatewayRequestContext, details?: Record<string, unknown>, level?: "debug" | "info" | "warning"): void;
    /**
   * @param {GatewayRequestContext} context
   * @param {RequestFrame} frame
   * @param {() => Promise<ResponseFrame>} handler
   * @returns {Promise<ResponseFrame>}
   */
    executeRpc(context: GatewayRequestContext, frame: RequestFrame, handler: () => Promise<ResponseFrame>): Promise<ResponseFrame>;
    /**
   * @param {GatewayRequestContext} context
   * @param {RequestFrame} frame
   * @param {ResponseFrame} response
   * @returns {Effect.Effect<void>}
   */
    rpcSuccessEffect(context: GatewayRequestContext, frame: RequestFrame, response: ResponseFrame): Effect.Effect<void>;
    /**
   * @param {ServerResponse} res
   * @param {number} status
   * @param {ResponseFrame} response
   */
    sendHttpRpcResponse(res: ServerResponse$1, status: number, response: ResponseFrame): void;
    /**
   * @param {SmithersDb} adapter
   * @param {string} runId
   * @param {string} signalName
   * @param {string | null} correlationId
   */
    runWaitsForSignal(adapter: SmithersDb$4, runId: string, signalName: string, correlationId: string | null): Promise<boolean>;
    /**
   * @param {RegisteredWorkflow} entry
   * @param {string} signalName
   * @param {string | null} correlationId
   * @param {string} [explicitRunId]
   */
    findMatchingWebhookRuns(entry: RegisteredWorkflow, signalName: string, correlationId: string | null, explicitRunId?: string): Promise<any[]>;
    /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {string} workflowKey
   */
    handleWebhook(req: IncomingMessage, res: ServerResponse$1, workflowKey: string): Promise<void>;
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
    extend(namespace: string, definition: GatewayExtensionDefinition): this;
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
    register(key: string, workflow: SmithersWorkflow, options?: GatewayRegisterOptions): this;
    /**
   * @param {{ port?: number; host?: string; path?: string }} [options]
   */
    listen(options?: {
        port?: number;
        host?: string;
        path?: string;
    }): Promise<node_http.Server<typeof node_http.IncomingMessage, typeof node_http.ServerResponse>>;
    close(): Promise<void>;
    ticketWatchers: Map<any, any> | null | undefined;
    startScheduler(): void;
    startOutOfProcessEventBridge(): void;
    stopOutOfProcessEventBridge(): void;
    pollOutOfProcessRunEvents(): Promise<void>;
    feedOutOfProcessRunEvents(adapter: any, runId: any, terminal: any): Promise<void>;
    syncRegisteredSchedules(): Promise<void>;
    processDueCrons(): Promise<void>;
    /**
   * Earliest fire time across a run's still-pending timer nodes, or null when the
   * run has no timer waiting to fire. Lets the scheduler tick decide when a
   * torn-down `waiting-timer` run is due to resume without re-driving it blindly.
   * @param {SmithersDb} adapter
   * @param {string} runId
   * @returns {Promise<number | null>}
   */
    runTimerDueAtMs(adapter: SmithersDb$4, runId: string): Promise<number | null>;
    /**
   * Wake suspended timer runs whose fire time has passed. The engine releases the
   * worker when a `<Timer>` starts waiting, persisting only the fire time, so this
   * sweep is what resumes the run on its own without a live process holding CPU.
   * Mirrors `processDueCrons`: one pass per shared DB, attribute each run to its
   * true workflow key, and let `resumeRunIfNeeded` re-acquire the durable lease.
   * @returns {Promise<void>}
   */
    processDueTimers(): Promise<void>;
    timerSweepInFlight: boolean | undefined;
    /**
   * @param {string} workflowKey
   * @param {Record<string, unknown>} input
   * @param {RunStartAuthContext} auth
   * @param {string} [runId]
   * @param {{ resume?: boolean }} [options]
   */
    startRun(workflowKey: string, input: Record<string, unknown>, auth: RunStartAuthContext, runId?: string, options?: {
        resume?: boolean;
    }): Promise<{
        runId: string;
        workflow: string;
    }>;
    /**
   * @param {string} runId
   * @param {string} workflowKey
   * @param {SmithersDb} adapter
   * @param {RunStartAuthContext} auth
   */
    resumeRunIfNeeded(runId: string, workflowKey: string, adapter: SmithersDb$4, auth: RunStartAuthContext): Promise<void>;
    /**
   * @param {WebSocket} ws
   * @param {IncomingMessage} req
   */
    handleSocket(ws: WebSocket, req: IncomingMessage): void;
    /**
   * @param {ConnectionState} connection
   */
    startHeartbeat(connection: ConnectionState): void;
    /**
   * @param {ConnectionState} connection
   * @param {IncomingMessage} req
   * @param {string} id
   * @param {unknown} params
   * @returns {Promise<ResponseFrame>}
   */
    handleConnect(connection: ConnectionState, req: IncomingMessage, id: string, params: unknown): Promise<ResponseFrame>;
    /**
   * @param {IncomingMessage} req
   * @param {ConnectRequest} request
   * @returns {Promise< | { ok: true; role: string; scopes: string[]; userId?: string } | { ok: false; code: string; message: string } >}
   */
    authenticate(req: IncomingMessage, request: ConnectRequest): Promise<{
        ok: true;
        role: string;
        scopes: string[];
        userId?: string;
    } | {
        ok: false;
        code: string;
        message: string;
    }>;
    /**
   * Whether `req`'s browser `Origin` is permitted by the configured auth-mode
   * Origin allow-list. No auth, an empty/unset `allowedOrigins`, or a missing
   * `Origin` header (server-to-server / CLI) are always allowed; a present
   * `Origin` must be on the list. Enforced for both the HTTP RPC path (via
   * `authenticateRequest`) and the WS `upgrade` handler (#446).
   * @param {IncomingMessage} req
   * @returns {boolean}
   */
    isOriginAllowed(req: IncomingMessage): boolean;
    /**
   * @param {IncomingMessage} req
   * @param {string | null} token
   * @returns {Promise< | { ok: true; role: string; scopes: string[]; userId?: string } | { ok: false; code: string; message: string } >}
   */
    authenticateRequest(req: IncomingMessage, token: string | null): Promise<{
        ok: true;
        role: string;
        scopes: string[];
        userId?: string;
    } | {
        ok: false;
        code: string;
        message: string;
    }>;
    /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
    handleElectricWrite(req: IncomingMessage, res: ServerResponse$1): Promise<void>;
    /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {string} [forcedMethod]
   */
    handleHttpRpc(req: IncomingMessage, res: ServerResponse$1, forcedMethod?: string): Promise<void>;
    /**
   * @param {ConnectionState} connection
   * @param {ResponseFrame} frame
   */
    sendResponse(connection: ConnectionState, frame: ResponseFrame): void;
    /**
   * @param {ConnectionState} connection
   * @param {string} event
   * @param {unknown} [payload]
   */
    sendEvent(connection: ConnectionState, event: string, payload?: unknown, stateVersion?: number): void;
    /**
   * @param {string} event
   * @param {unknown} [payload]
   */
    broadcastEvent(event: string, payload?: unknown): void;
    buildSnapshot(): Promise<{
        runs: any[];
        approvals: {
            runId: any;
            workflowKey: string;
            nodeId: any;
            iteration: any;
            requestTitle: any;
            requestSummary: any;
            requestedAtMs: any;
            approvalMode: any;
            options: any;
            allowedScopes: any;
            allowedUsers: any;
            autoApprove: any;
        }[];
        stateVersion: number;
    }>;
    /**
   * @param {SmithersWorkflow} workflow
   * @returns {SmithersDb}
   */
    adapterForWorkflow(workflow: SmithersWorkflow): SmithersDb$4;
    adapterCache: Map<any, any> | undefined;
    /**
   * Resolve the true gateway workflow key for a stored run row. A run started
   * THROUGH the gateway records its key in config; a run started elsewhere (e.g.
   * the CLI) does not, so we fall back to the row's own `workflowName` when that
   * matches a registered key, and only then to the adapter's first owner. This
   * is what keeps runs correctly attributed when many workflows share one DB —
   * the adapter that finds a row is no longer assumed to own it.
   * @param {{ configJson?: string; workflowName?: string }} row
   * @param {Set<string>} registeredKeys
   * @param {string} fallbackKey
   * @returns {string}
   */
    resolveRunWorkflowKey(row: {
        configJson?: string;
        workflowName?: string;
    }, registeredKeys: Set<string>, fallbackKey: string): string;
    /**
   * @param {string} [status]
   */
    listRunsAcrossWorkflows(limit?: number, status?: string): Promise<any[]>;
    /**
   * Cross-run memory facts for the `listMemoryFacts` RPC. Memory is global (keyed
   * by namespace+key, not per-run), so iterate each DISTINCT workflow DB exactly
   * once — shared-DB workflows share an adapter — and union the rows, deduping on
   * `${namespace} ${key}` so a fact stored in a shared DB is returned once.
   * Mirrors the `listRunsAcrossWorkflows` shape.
   * @param {string | null} [namespace]
   */
    listMemoryFactsAcrossWorkflows(namespace?: string | null): Promise<any[]>;
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
    listAccountsFromRegistry(): Array<Record<string, unknown>>;
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
    listPromptsFromDisk(): Array<Record<string, unknown>>;
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
    listScoresForRun(runId: string, nodeId?: string | null): Promise<Array<Record<string, unknown>> | null>;
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
    primaryDocsAdapter(): _smithers_orchestrator_db_adapter.SmithersDb | null;
    /**
   * Live work docs for the `listTickets` RPC. `_smithers_docs` is global, so
   * read across every DISTINCT adapter (mirrors `listMemoryFactsAcrossWorkflows`)
   * and dedupe by `path`; `listDocs` already filters tombstones server-side, so
   * a soft-deleted doc never surfaces. Newest-updated first.
   * @param {string | null} [kind]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
    listTicketsAcrossWorkflows(kind?: string | null): Promise<Array<Record<string, unknown>>>;
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
    createTicketDoc(input: {
        path: string;
        content: string;
        kind?: string;
        status?: string;
    }): Promise<Record<string, unknown> | null>;
    /**
   * Patch a LIVE work doc's content and/or status for `updateTicket`. Re-hashes
   * + re-stamps when content changes (a status-only patch keeps the existing
   * hash/content). Returns `null` for an unknown or already-soft-deleted path so
   * the dispatcher can answer TicketNotFound; `false` when no workflow exists.
   * @param {{ path: string, content?: string, status?: string }} input
   * @returns {Promise<Record<string, unknown> | null | false>}
   */
    updateTicketDoc(input: {
        path: string;
        content?: string;
        status?: string;
    }): Promise<Record<string, unknown> | null | false>;
    /**
   * Soft-delete (tombstone) a work doc for `deleteTicket`. Returns `null` for an
   * unknown/already-deleted path (→ TicketNotFound), `false` when no workflow is
   * registered. The row survives so `listTickets` hides it without losing
   * history; the watcher never materializes a tombstone back to disk.
   * @param {string} path
   * @returns {Promise<boolean | null | false>}
   */
    deleteTicketDoc(path: string): Promise<boolean | null | false>;
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
    watchTicketsDirectory(dir: string): {
        close: () => void;
    } | null;
    listPendingApprovals(): Promise<{
        runId: any;
        workflowKey: string;
        nodeId: any;
        iteration: any;
        requestTitle: any;
        requestSummary: any;
        requestedAtMs: any;
        approvalMode: any;
        options: any;
        allowedScopes: any;
        allowedUsers: any;
        autoApprove: any;
    }[]>;
    /**
   * @param {{ kind?: string; includeDeleted?: boolean; updatedAfterMs?: number; limit?: number }} [options]
   */
    listDocsAcrossWorkflows(options?: {
        kind?: string;
        includeDeleted?: boolean;
        updatedAfterMs?: number;
        limit?: number;
    }): Promise<any[]>;
    listCrons(): Promise<any[]>;
    /**
   * @param {string} cronId
   */
    findCron(cronId: string): Promise<{
        cron: any;
        workflowKey: any;
        adapter: SmithersDb$4;
    } | null>;
    /**
   * @param {string} runId
   * @returns {Promise<ResolvedRun | null>}
   */
    resolveRun(runId: string): Promise<ResolvedRun | null>;
    /**
   * @param {SmithersEvent} event
   */
    handleSmithersEvent(event: SmithersEvent$1): void;
    /**
   * @param {SmithersEvent} event
   * @returns {{ event: string; payload: unknown } | null}
   */
    mapEvent(event: SmithersEvent$1): {
        event: string;
        payload: unknown;
    } | null;
    /**
   * @param {GatewayRequestContext} connection
   * @param {RequestFrame} frame
   * @returns {Promise<ResponseFrame>}
   */
    routeRequest(connection: GatewayRequestContext, frame: RequestFrame): Promise<ResponseFrame>;
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
    routeExtensionRequest(connection: GatewayRequestContext, frame: RequestFrame, params: Record<string, unknown>): Promise<ResponseFrame>;
    /**
     * Register a pending handler abort controller against a connection so the
     * disconnect / cleanup path can fire its `.abort()` and stop in-flight work
     * even if the handler never resolves.
     *
     * @param {GatewayRequestContext} connection
     * @param {AbortController} abort
     */
    trackExtensionPendingHandler(connection: GatewayRequestContext, abort: AbortController): void;
    /**
     * Remove a pending handler abort from the per-connection set. Safe to call
     * even when the connection has already been cleaned up.
     *
     * @param {GatewayRequestContext} connection
     * @param {AbortController} abort
     */
    untrackExtensionPendingHandler(connection: GatewayRequestContext, abort: AbortController): void;
    /**
     * Fire the abort signal on every pending resource/action handler for a
     * connection. Called from the disconnect path so handlers respecting
     * `ctx.signal` stop work immediately instead of returning into a dead
     * socket and racing the cleanup of dependent resources.
     *
     * @param {GatewayRequestContext} connection
     */
    cleanupExtensionPendingHandlers(connection: GatewayRequestContext): void;
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
    subscribeExtensionStream(connection: GatewayRequestContext, frame: RequestFrame, params: Record<string, unknown>, resolved: ResolvedExtension & {
        kind: "stream";
        entry: GatewayExtensionStream;
    }): Promise<ResponseFrame>;
    /**
     * Tear down every extension stream attached to a connection. Called from
     * the existing socket cleanup path so a disconnect releases handler-owned
     * resources (subscriptions, db cursors, ElectricSQL shape handles, etc.)
     * even if the handler never observed the abort signal.
     *
     * @param {GatewayRequestContext} connection
     */
    cleanupExtensionSubscriptions(connection: GatewayRequestContext): Promise<void>;
}
type EventFrame = EventFrame$1;
type GatewayDefaults = GatewayDefaults$1;
type GatewayRegisterOptions = GatewayRegisterOptions$1;
type GatewayTokenGrant = GatewayTokenGrant$1;
type GatewayUiConfig = GatewayUiConfig$1;
type HelloResponse = HelloResponse$1;
type GatewayWebhookRunConfig = GatewayWebhookRunConfig$1;
type GatewayWebhookSignalConfig = GatewayWebhookSignalConfig$1;
type ConnectRequest = ConnectRequest$1;
type RunEventStreamState = {
    streamId: string;
    runId: string;
    heartbeat: unknown;
    outboundQueue: Record<string, unknown>[];
    flushPending: boolean;
    backpressureDisconnected: boolean;
};
type GatewayAuthConfig = GatewayAuthConfig$1;
type GatewayOperatorUiConfig = GatewayOperatorUiConfig$1;
type GatewayOptions = GatewayOptions$1;
type GatewayWebhookConfig = GatewayWebhookConfig$1;
type IncomingMessage = node_http.IncomingMessage;
type RequestFrame = RequestFrame$1;
type ResponseFrame = ResponseFrame$1;
type ServerResponse$1 = node_http.ServerResponse;
type SmithersWorkflow = _smithers_orchestrator_components_SmithersWorkflow.SmithersWorkflow<unknown>;
type SmithersEvent$1 = _smithers_orchestrator_observability_SmithersEvent.SmithersEvent;
type GatewayMetricLabels = Record<string, string | number | null | undefined>;
type GatewayTransport = "ws" | "http";
type GatewayRequestContext = {
    connectionId?: string;
    role?: string;
    scopes?: string[];
    userId?: string | null;
    tokenId?: string | null;
    origin?: string;
    transport?: GatewayTransport;
};
type ConnectionState = {
    id: string;
    ws?: unknown;
    role: string;
    scopes: string[];
    userId: string | null;
    subscribedRuns?: Set<string>;
    heartbeat?: unknown;
    lastActivity?: number;
    closed?: boolean;
} & Record<string, unknown>;
type RunStartAuthContext = {
    role: string;
    scopes: string[];
    userId?: string | null;
    tokenId?: string | null;
    connectionId?: string;
};
type RegisteredWorkflow = {
    workflow: SmithersWorkflow;
    adapter: SmithersDb$4;
    key: string;
    schedule?: string;
    webhook?: GatewayWebhookConfig;
    ui?: ResolvedGatewayUiConfig | null;
};
type ResolvedRun = {
    runId: string;
    workflowKey: string;
    workflow: SmithersWorkflow;
    adapter: SmithersDb$4;
};
type ResolvedGatewayUiConfig = {
    entry: string;
    path: string;
    title?: string;
    props?: Record<string, unknown>;
    builtin?: "operator";
};
type GatewayUiMount = {
    kind: "gateway" | "workflow" | "operator";
    workflowKey: string | null;
    config: ResolvedGatewayUiConfig;
};

type ServeOptions$1 = {
    workflow: SmithersWorkflow$1<unknown>;
    adapter: SmithersDb$4;
    runId: string;
    abort: AbortController;
    authToken?: string;
    metrics?: boolean;
};

/**
 * @param {ServeOptions} opts
 */
declare function createServeApp(opts: ServeOptions): Hono<hono_types.BlankEnv, hono_types.BlankSchema, "/">;
type ServeOptions = ServeOptions$1;

/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 * @param {{ signal?: AbortSignal }} [options]
 */
declare function runPromise<A, E, R>(effect: Effect.Effect<A, E, R>, options?: {
    signal?: AbortSignal;
}): Promise<A>;
/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
declare function runFork<A, E, R>(effect: Effect.Effect<A, E, R>): effect_Fiber.RuntimeFiber<A, E>;
/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
declare function runSync<A, E, R>(effect: Effect.Effect<A, E, R>): A;

declare const NODE_OUTPUT_MAX_BYTES: number;

declare const NODE_OUTPUT_WARN_BYTES: 1048576;

/** @typedef {import("@smithers-orchestrator/protocol/errors").NodeOutputErrorCode} NodeOutputErrorCode */
declare class NodeOutputRouteError extends Error {
    /**
     * @param {NodeOutputErrorCode} code
     * @param {string} message
     */
    constructor(code: NodeOutputErrorCode, message: string);
    /** @type {NodeOutputErrorCode} */
    code: NodeOutputErrorCode;
}
type NodeOutputErrorCode = _smithers_orchestrator_protocol_errors.NodeOutputErrorCode;

/**
 * @returns {DevToolsNode}
 */
declare function emptyDevToolsRoot(): DevToolsNode;
/**
 * @param {string} runId
 * @returns {string}
 */
declare function validateRunId(runId: string): string;
/**
 * @param {unknown} frameNo
 * @param {number} latestFrameNo
 * @returns {number}
 */
declare function validateRequestedFrameNo(frameNo: unknown, latestFrameNo: number): number;
/**
 * @param {unknown} xml
 * @param {(warning: SnapshotSerializerWarning) => void} [onWarning]
 * @returns {DevToolsNode}
 */
declare function parseXmlToDevToolsRoot(xml: unknown, onWarning?: (warning: SnapshotSerializerWarning$1) => void): DevToolsNode;
/**
 * @param {{
 *   runId: string;
 *   frameNo: number;
 *   xmlJson: string;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 * }} input
 * @returns {DevToolsSnapshot}
 */
declare function snapshotFromFrameRow(input: {
    runId: string;
    frameNo: number;
    xmlJson: string;
    onWarning?: (warning: SnapshotSerializerWarning$1) => void;
}): DevToolsSnapshot;
/**
 * Validate a frameNo input before any DB or reconciler call so that oversized
 * or malformed numeric inputs never reach the adapter.
 *
 * @param {unknown} frameNo
 * @returns {void}
 */
declare function validateFrameNoInput(frameNo: unknown): void;
/**
 * Validate a fromSeq input before any DB or reconciler call.
 *
 * @param {unknown} fromSeq
 * @returns {void}
 */
declare function validateFromSeqInput(fromSeq: unknown): void;
/**
 * @param {{
 *   adapter: SmithersDb;
 *   runId: string;
 *   frameNo?: number;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 * }} input
 * @returns {Promise<DevToolsSnapshot>}
 */
declare function getDevToolsSnapshotRoute(input: {
    adapter: SmithersDb$3;
    runId: string;
    frameNo?: number;
    onWarning?: (warning: SnapshotSerializerWarning$1) => void;
}): Promise<DevToolsSnapshot>;
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsNode} DevToolsNode */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsNodeType} DevToolsNodeType */
/** @typedef {import("@smithers-orchestrator/devtools/snapshotSerializer").SnapshotSerializerWarning} SnapshotSerializerWarning */
declare const DEVTOOLS_RUN_ID_PATTERN: RegExp;
declare const DEVTOOLS_MAX_FRAME_NO: 2147483647;
declare const DEVTOOLS_TREE_MAX_DEPTH: 256;
declare class DevToolsRouteError extends Error {
    /**
   * @param {string} code
   * @param {string} message
   * @param {string} [hint]
   */
    constructor(code: string, message: string, hint?: string);
    code: string;
    hint: string | undefined;
}
declare const DEVTOOLS_EMPTY_ROOT_ID: 0;
type SmithersDb$3 = _smithers_orchestrator_db_adapter.SmithersDb;
type DevToolsNode = _smithers_orchestrator_protocol_devtools.DevToolsNode;
type DevToolsSnapshot = _smithers_orchestrator_protocol_devtools.DevToolsSnapshot;
type DevToolsNodeType = _smithers_orchestrator_protocol_devtools.DevToolsNodeType;
type SnapshotSerializerWarning$1 = _smithers_orchestrator_devtools_snapshotSerializer.SnapshotSerializerWarning;

type DiffSummary$1 = {
    filesChanged: number;
    added: number;
    removed: number;
    files: Array<{
        path: string;
        added: number;
        removed: number;
    }>;
};

type GetNodeDiffStatPayload = {
    seq: number;
    baseRef: string;
    summary: DiffSummary$1;
};
type GetNodeDiffRoutePayload = DiffBundle | GetNodeDiffStatPayload;
type GetNodeDiffRouteResult$1 = {
    ok: true;
    payload: GetNodeDiffRoutePayload;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
    };
};

/**
 * @param {{
 *   runId: unknown;
 *   nodeId: unknown;
 *   iteration: unknown;
 *   resolveRun: (runId: string) => Promise<{ adapter: SmithersDb } | null>;
 *   emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
 *   computeDiffBundleImpl?: (baseRef: string, cwd: string, seq?: number) => Promise<import("@smithers-orchestrator/engine/effect/DiffBundle").DiffBundle>;
 *   computeDiffBundleBetweenRefsImpl?: (baseRef: string, targetRef: string, cwd: string, seq?: number) => Promise<import("@smithers-orchestrator/engine/effect/DiffBundle").DiffBundle>;
 *   resolveCommitPointerImpl?: (pointer: string, cwd: string) => Promise<string | null>;
 *   nowMs?: () => number;
 *   stat?: boolean;
 * }} opts
 * @returns {Promise<GetNodeDiffRouteResult>}
 */
declare function getNodeDiffRoute({ runId: rawRunId, nodeId: rawNodeId, iteration: rawIteration, resolveRun, emitEffect, computeDiffBundleImpl, computeDiffBundleBetweenRefsImpl, resolveCommitPointerImpl, nowMs, stat, }: {
    runId: unknown;
    nodeId: unknown;
    iteration: unknown;
    resolveRun: (runId: string) => Promise<{
        adapter: SmithersDb$2;
    } | null>;
    emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
    computeDiffBundleImpl?: (baseRef: string, cwd: string, seq?: number) => Promise<_smithers_orchestrator_engine_effect_DiffBundle.DiffBundle>;
    computeDiffBundleBetweenRefsImpl?: (baseRef: string, targetRef: string, cwd: string, seq?: number) => Promise<_smithers_orchestrator_engine_effect_DiffBundle.DiffBundle>;
    resolveCommitPointerImpl?: (pointer: string, cwd: string) => Promise<string | null>;
    nowMs?: () => number;
    stat?: boolean;
}): Promise<GetNodeDiffRouteResult>;
type SmithersDb$2 = _smithers_orchestrator_db_adapter.SmithersDb;
type AttemptRow = _smithers_orchestrator_db_adapter.AttemptRow;
type GetNodeDiffRouteResult = GetNodeDiffRouteResult$1;
type DiffSummary = DiffSummary$1;

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/db/adapter").AttemptRow} AttemptRow */
/** @typedef {import("./GetNodeDiffRouteResult.js").GetNodeDiffRouteResult} GetNodeDiffRouteResult */
/** @typedef {import("./DiffSummary.js").DiffSummary} DiffSummary */
declare const RUN_ID_PATTERN: RegExp;
declare const NODE_ID_PATTERN: RegExp;
declare const ITERATION_MAX: 2147483647;
/**
 * Compute a lightweight per-file / total summary of a DiffBundle without
 * retaining full patch text. Counts lines starting with "+"/"-" excluding
 * file headers ("+++"/"---").
 *
 * @param {{ patches?: Array<{ path: string; diff?: string }> }} bundle
 * @returns {DiffSummary}
 */
declare function summarizeBundle(bundle: {
    patches?: Array<{
        path: string;
        diff?: string;
    }>;
}): DiffSummary;

type NodeOutputResponse$1 = {
    status: "produced" | "pending" | "failed";
    row: Record<string, unknown> | null;
    schema: {
        fields: Array<{
            name: string;
            type: "string" | "number" | "boolean" | "object" | "array" | "null" | "unknown";
            optional: boolean;
            nullable: boolean;
            description?: string;
            enum?: readonly unknown[];
        }>;
    } | null;
    partial?: Record<string, unknown> | null;
};

/**
 * Resolve per-node output row plus schema hints for DevTools rendering.
 *
 * @param {{
 *   runId: unknown;
 *   nodeId: unknown;
 *   iteration: unknown;
 *   resolveRun: (runId: string) => Promise<{ workflow: import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<unknown>; adapter: import("@smithers-orchestrator/db/adapter").SmithersDb } | null>;
 *   selectOutputRowImpl?: typeof selectOutputRow;
 *   emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
 * }} params
 * @returns {Promise<NodeOutputResponse>}
 */
declare function getNodeOutputRoute(params: {
    runId: unknown;
    nodeId: unknown;
    iteration: unknown;
    resolveRun: (runId: string) => Promise<{
        workflow: _smithers_orchestrator_components_SmithersWorkflow.SmithersWorkflow<unknown>;
        adapter: _smithers_orchestrator_db_adapter.SmithersDb;
    } | null>;
    selectOutputRowImpl?: typeof selectOutputRow;
    emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
}): Promise<NodeOutputResponse>;
type NodeOutputResponse = NodeOutputResponse$1;

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("@smithers-orchestrator/time-travel/jumpToFrame").JumpResult} JumpResult */
/**
 * Gateway wrapper around time-travel jump orchestration.
 *
 * The gateway has no direct hook into the engine's in-memory reconciler
 * (reconciler state is DB-backed: frames, nodes, attempts). We wire real
 * capture/restore/rebuild functions that operate on the run's DB state so
 * that the transaction rollback path inside jumpToFrame has meaningful
 * inputs, and callers can plug in an in-memory reconciler if they have one.
 *
 * @param {{
 *   adapter: SmithersDb;
 *   runId: unknown;
 *   frameNo: unknown;
 *   confirm?: unknown;
 *   caller?: string;
 *   pauseRunLoop?: () => Promise<void> | void;
 *   resumeRunLoop?: () => Promise<void> | void;
 *   emitEvent?: (event: SmithersEvent) => Promise<void> | void;
 *   captureReconcilerState?: () => Promise<unknown> | unknown;
 *   restoreReconcilerState?: (snapshot: unknown) => Promise<void> | void;
 *   rebuildReconcilerState?: (xmlJson: string) => Promise<void> | void;
 *   onLog?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => Promise<void> | void;
 * }} input
 * @returns {Promise<JumpResult>}
 */
declare function jumpToFrameRoute(input: {
    adapter: SmithersDb$1;
    runId: unknown;
    frameNo: unknown;
    confirm?: unknown;
    caller?: string;
    pauseRunLoop?: () => Promise<void> | void;
    resumeRunLoop?: () => Promise<void> | void;
    emitEvent?: (event: SmithersEvent) => Promise<void> | void;
    captureReconcilerState?: () => Promise<unknown> | unknown;
    restoreReconcilerState?: (snapshot: unknown) => Promise<void> | void;
    rebuildReconcilerState?: (xmlJson: string) => Promise<void> | void;
    onLog?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => Promise<void> | void;
}): Promise<JumpResult>;

type SmithersDb$1 = _smithers_orchestrator_db_adapter.SmithersDb;
type SmithersEvent = _smithers_orchestrator_observability_SmithersEvent.SmithersEvent;
type JumpResult = _smithers_orchestrator_time_travel_jumpToFrame.JumpResult;

/**
 * @param {{
 *   adapter: SmithersDb;
 *   runId: string;
 *   fromSeq?: number;
 *   subscriberId?: string;
 *   pollIntervalMs?: number;
 *   maxBufferedEvents?: number;
 *   signal?: AbortSignal;
 *   invalidateSnapshot?: () => boolean;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 *   onLog?: (level: "debug" | "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
 *   onEvent?: (event: DevToolsEvent, stats: { bytes: number; durationMs: number; opCount?: number; frameNo?: number }) => void;
 *   onClose?: (summary: { eventsDelivered: number; durationMs: number; errorCode?: string }) => void;
 * }} input
 * @returns {AsyncIterable<DevToolsEvent>}
 */
declare function streamDevToolsRoute(input: {
    adapter: SmithersDb;
    runId: string;
    fromSeq?: number;
    subscriberId?: string;
    pollIntervalMs?: number;
    maxBufferedEvents?: number;
    signal?: AbortSignal;
    invalidateSnapshot?: () => boolean;
    onWarning?: (warning: SnapshotSerializerWarning) => void;
    onLog?: (level: "debug" | "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
    onEvent?: (event: DevToolsEvent, stats: {
        bytes: number;
        durationMs: number;
        opCount?: number;
        frameNo?: number;
    }) => void;
    onClose?: (summary: {
        eventsDelivered: number;
        durationMs: number;
        errorCode?: string;
    }) => void;
}): AsyncIterable<DevToolsEvent>;
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsEvent} DevToolsEvent */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("@smithers-orchestrator/devtools/snapshotSerializer").SnapshotSerializerWarning} SnapshotSerializerWarning */
declare const DEVTOOLS_REBASELINE_INTERVAL: 50;
declare const DEVTOOLS_BACKPRESSURE_LIMIT: 1000;
declare const DEVTOOLS_POLL_INTERVAL_MS: 25;
type SmithersDb = _smithers_orchestrator_db_adapter.SmithersDb;
type DevToolsEvent = _smithers_orchestrator_protocol_devtools.DevToolsEvent;
type SnapshotSerializerWarning = _smithers_orchestrator_devtools_snapshotSerializer.SnapshotSerializerWarning;

/**
 * @param {ServerOptions} [opts]
 */
declare function startServerEffect(opts?: ServerOptions): Effect.Effect<node_http.Server<typeof node_http.IncomingMessage, typeof node_http.ServerResponse>, never, never>;
/**
 * @param {ServerOptions} [opts]
 */
declare function startServer(opts?: ServerOptions): node_http.Server<typeof node_http.IncomingMessage, typeof node_http.ServerResponse>;

type RunRow = _smithers_orchestrator_db_adapter_RunRow.RunRow;
type ServerResponse = node_http.ServerResponse;
type ServerOptions = ServerOptions$1;

export { type AttemptRow, type ConnectRequest, type ConnectionState, DEVTOOLS_BACKPRESSURE_LIMIT, DEVTOOLS_EMPTY_ROOT_ID, DEVTOOLS_MAX_FRAME_NO, DEVTOOLS_POLL_INTERVAL_MS, DEVTOOLS_REBASELINE_INTERVAL, DEVTOOLS_RUN_ID_PATTERN, DEVTOOLS_TREE_MAX_DEPTH, type DevToolsEvent, type DevToolsNode, type DevToolsNodeType, DevToolsRouteError, type DiffSummary, EXTENSION_BACKPRESSURE_DISCONNECT_CODE, EXTENSION_METHOD_NOT_FOUND_CODE, EXTENSION_METHOD_PREFIX, EXTENSION_PAYLOAD_MAX_BYTES, EXTENSION_STREAM_METHOD_PREFIX, EXTENSION_STREAM_OUTBOUND_QUEUE_LIMIT, EXTENSION_WS_BUFFERED_HIGH_WATER_BYTES, type EventFrame, GATEWAY_FRAME_ID_MAX_LENGTH, GATEWAY_METHOD_NAME_MAX_LENGTH, GATEWAY_RPC_INPUT_MAX_BYTES, GATEWAY_RPC_INPUT_MAX_DEPTH, GATEWAY_RPC_MAX_ARRAY_LENGTH, GATEWAY_RPC_MAX_DEPTH, GATEWAY_RPC_MAX_PAYLOAD_BYTES, GATEWAY_RPC_MAX_STRING_LENGTH, Gateway, type GatewayAuthConfig, type GatewayDefaults, type GatewayExtensionAction, type GatewayExtensionContext, type GatewayExtensionDefinition, type GatewayExtensionResource, type GatewayExtensionStream, type GatewayExtensionStreamContext, GatewayExtensions, type GatewayMetricLabels, type GatewayOperatorUiConfig, type GatewayOptions, type GatewayRegisterOptions, type GatewayRequestContext, type GatewayScope, type GatewayTokenGrant, type GatewayTransport, type GatewayUiConfig, type GatewayUiMount, type GatewayWebhookConfig, type GatewayWebhookRunConfig, type GatewayWebhookSignalConfig, type GetNodeDiffRouteResult, type HelloResponse, ITERATION_MAX, type IncomingMessage, type JumpResult, NODE_ID_PATTERN, NODE_OUTPUT_MAX_BYTES, NODE_OUTPUT_WARN_BYTES, type NodeOutputErrorCode, type NodeOutputResponse, NodeOutputRouteError, RUN_ID_PATTERN, type RegisteredWorkflow, type RequestFrame, type ResolvedExtension, type ResolvedGatewayUiConfig, type ResolvedRun, type ResponseFrame, type RunEventStreamState, type RunRow, type RunStartAuthContext, type ServeOptions, type ServerOptions, type ServerResponse, type SmithersWorkflow, assertGatewayInputDepthWithinBounds, createServeApp, emptyDevToolsRoot, extensionMethodName, getDevToolsSnapshotRoute, getGatewayInputDepth, getNodeDiffRoute, getNodeOutputRoute, isExtensionMethod, jumpToFrameRoute, parseGatewayRequestFrame, parseXmlToDevToolsRoot, runFork, runPromise, runSync, snapshotFromFrameRow, startServer, startServerEffect, statusForRpcError, streamDevToolsRoute, summarizeBundle, validateFrameNoInput, validateFromSeqInput, validateGatewayMethodName, validateRequestedFrameNo, validateRunId };
