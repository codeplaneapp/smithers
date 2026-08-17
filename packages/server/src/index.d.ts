import * as node_http from 'node:http';
import { IncomingMessage as IncomingMessage$1, ServerResponse as ServerResponse$2 } from 'node:http';
import * as _smthrs_usage from '@smthrs/usage';
import * as _smthrs_observability_SmithersEvent from '@smthrs/observability/SmithersEvent';
import * as _smthrs_components_SmithersWorkflow from '@smthrs/components/SmithersWorkflow';
import { SmithersWorkflow as SmithersWorkflow$1 } from '@smthrs/components/SmithersWorkflow';
import * as _smthrs_db_adapter from '@smthrs/db/adapter';
import { SmithersDb as SmithersDb$4 } from '@smthrs/db/adapter';
import * as _smthrs_driver_RunStartedBy from '@smthrs/driver/RunStartedBy';
import * as ws from 'ws';
import { WebSocketServer } from 'ws';
import * as node_stream from 'node:stream';
import * as _smthrs_db_runState from '@smthrs/db/runState';
import * as effect_Record from 'effect/Record';
import * as effect_LogLevel from 'effect/LogLevel';
import * as hono from 'hono';
import { Hono } from 'hono';
import * as hono_types from 'hono/types';
import { Effect } from 'effect';
import * as effect_Fiber from 'effect/Fiber';
import * as _smthrs_protocol_errors from '@smthrs/protocol/errors';
import * as _smthrs_devtools_snapshotSerializer from '@smthrs/devtools/snapshotSerializer';
import * as _smthrs_protocol_devtools from '@smthrs/protocol/devtools';
import * as _smthrs_engine_effect_DiffBundle from '@smthrs/engine/effect/DiffBundle';
import { DiffBundle } from '@smthrs/engine/effect/DiffBundle';
import { computeDiffBundleBetweenRefs, computeDiffBundle } from '@smthrs/engine/effect/diff-bundle';
import { selectOutputRow } from '@smthrs/db/output';
import * as _smthrs_time_travel_jumpToFrame from '@smthrs/time-travel/jumpToFrame';
export { JumpToFrameError } from '@smthrs/time-travel/jumpToFrame';

declare namespace approvalDecision {
    export { parseApprovalRequest };
    export { validateApprovalDecision };
    export { normalizeDecision };
    export function unwrapDecision(value: any): unknown;
}
type ApprovalRequestRecord$1 = {
    mode: "gate" | "select" | "rank" | "decision";
    title: string | null;
    summary: string | null;
    options: Array<{
        key: string;
        label: string;
        summary?: string;
    }>;
    allowedScopes: string[];
    allowedUsers: string[];
    restrictionError: string | null;
    autoApprove: Record<string, unknown> | null;
};
/**
 * @param {unknown} value
 * @param {string | null} fallbackTitle
 * @returns {ApprovalRequestRecord}
 */
declare function parseApprovalRequest(value: unknown, fallbackTitle: string | null): ApprovalRequestRecord$1;
/**
 * @param {ApprovalRequestRecord} request
 * @param {unknown} decision
 */
declare function validateApprovalDecision(request: ApprovalRequestRecord$1, decision: unknown): {
    ok: boolean;
    code: string;
    message: string;
} | {
    ok: boolean;
    code?: undefined;
    message?: undefined;
};
/**
 * @param {unknown} value
 * @param {unknown} explicitNote
 */
declare function normalizeDecision(value: unknown, explicitNote: unknown): {
    decision: unknown;
    note: string | undefined;
};

/**
 * A generic HMAC-verified webhook event source served at
 * `POST /v1/webhooks/:id`. Each verified delivery becomes ONE external event
 * (signal name = `event`) fanned out to runs parked on
 * `WaitForEvent(event, correlationId)` via the integration runtime.
 */
type IntegrationsWebhookSourceConfig = {
    /**
     * Source id, the `:sourceId` path segment of `POST /v1/webhooks/:sourceId`.
     */
    id: string;
    /**
     * HMAC-SHA256 shared secret used to verify deliveries.
     */
    secret: string;
    /**
     * Header carrying the signature. Defaults to `x-hub-signature-256`.
     */
    signatureHeader?: string | undefined;
    /**
     * Required signature prefix (e.g. GitHub's `sha256=`). When
     * omitted, a leading `sha256=` is stripped if present and plain hex/base64 digests are accepted.
     */
    signaturePrefix?: string | undefined;
    /**
     * Signal name to deliver (e.g. `integration:test:ping`).
     */
    event: string;
    /**
     * Dot-path into the JSON payload for the correlation id (e.g. `issue.key`).
     */
    correlationIdPath?: string | undefined;
    /**
     * Dot-path selecting the signal payload. Defaults to the whole body.
     */
    payloadPath?: string | undefined;
    /**
     * Dot-path for a provider-stable delivery id used for redelivery
     * dedupe. Defaults to `sha256(rawBody)`.
     */
    dedupeKeyPath?: string | undefined;
    /**
     * Bounded ingress queue capacity. Defaults to 256.
     */
    capacity?: number | undefined;
};
/**
 * Server-level integrations config (`ServerOptions.integrations`). Requires
 * `ServerOptions.db`: delivered events are deduped and matched against the
 * server database.
 */
type IntegrationsConfig = {
    webhooks?: IntegrationsWebhookSourceConfig[] | undefined;
};

/**
 * `IntegrationsConfig` is referenced inline rather than aliased through a local
 * `@typedef`. A `@typedef` is itself an export, so aliasing here would make both
 * this module and `./IntegrationsConfig.js` export the same name. `index.js`
 * re-exports both with `export *`, and a name exported by two star sources is
 * ambiguous, so the declaration bundler drops `IntegrationsConfig` from the
 * public types instead of emitting it.
 */
type ServerOptions$1 = {
    port?: number | undefined;
    /**
     * External integrations served by this process:
     * generic HMAC-verified webhook sources exposed at `POST /v1/webhooks/:sourceId` and delivered
     * to waiting runs through the integration runtime. Requires `db`.
     */
    integrations?: IntegrationsConfig | undefined;
    /**
     * Network interface to bind. Defaults to the loopback address 127.0.0.1.
     * Binding a non-loopback host (e.g. 0.0.0.0) requires an authToken unless `insecure` is set,
     * because the control plane can launch, cancel, and approve arbitrary workflow runs.
     */
    host?: string | undefined;
    /**
     * Allow binding a non-loopback host with no authToken configured.
     * This exposes a full-control, unauthenticated HTTP control plane to the network. Defaults to false.
     */
    insecure?: boolean | undefined;
    db?: unknown;
    authToken?: string | undefined;
    maxBodyBytes?: number | undefined;
    rootDir?: string | undefined;
    allowNetwork?: boolean | undefined;
    /**
     * Maximum time in milliseconds allowed for the HTTP parser to
     * receive the complete headers of a single request. Helps mitigate slowloris attacks. Defaults to 30000.
     */
    headersTimeout?: number | undefined;
    /**
     * Maximum time in milliseconds allowed for a single request to be
     * received and parsed, including the body. Helps mitigate slowloris attacks. Defaults to 60000.
     */
    requestTimeout?: number | undefined;
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
    /** Decode and durably deduplicate provider deliveries before signaling or launching. */
    source?: "github";
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
    /**
     * Transport-level trust boundary. Required and non-empty: trusted-proxy
     * mode authenticates from client-supplied identity headers, so the
     * gateway only honors them when the immediate socket peer matches one of
     * these entries. Each entry is an IP literal (`"10.0.0.7"`, `"::1"`), a
     * CIDR block (`"10.0.0.0/24"`), or the literal `"unix"` for a
     * Unix-domain listener. The peer is the transport peer — never
     * `X-Forwarded-For` — so behind a proxy chain list only the last hop.
     * Startup fails when this is missing, empty, malformed, or cannot apply
     * to the socket the gateway binds.
     */
    trustedProxies: string[];
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

/** Create the gateway-local Playwright browser session registry. */
declare function createBrowserSessionRegistry(options?: {}): {
    create: ({ source, viewport }: {
        source: any;
        viewport?: {
            width: number;
            height: number;
        } | undefined;
    }) => Promise<{
        sessionId: any;
        source: any;
        status: any;
        revision: any;
        page: {
            url: any;
            title: any;
            canGoBack: boolean;
            canGoForward: boolean;
        } | null;
        viewport: any;
        control: {
            owner: any;
        };
    }>;
    act: (params: any) => Promise<any>;
    context: ({ sessionId, sinceRevision, include }: {
        sessionId: any;
        sinceRevision: any;
        include?: never[] | undefined;
    }) => Promise<any>;
    pick: ({ sessionId, point }: {
        sessionId: any;
        point: any;
    }) => Promise<any>;
    close: (sessionId: any) => Promise<{
        closed: boolean;
        sessionId?: undefined;
    } | {
        closed: boolean;
        sessionId: any;
    }>;
    list: () => Promise<{
        sessionId: any;
        source: any;
        status: any;
        revision: any;
        page: {
            url: any;
            title: any;
            canGoBack: boolean;
            canGoForward: boolean;
        } | null;
        viewport: any;
        control: {
            owner: any;
        };
    }[]>;
    subscribe: (kind: any, listener: any) => () => any;
    setFrameSubscribers: (sessionId: any, count: any) => Promise<void>;
    get: (id: any) => any;
    shutdown: () => Promise<void>;
    BrowserError: typeof BrowserError;
};
declare class BrowserError extends Error {
    constructor(code: any, message: any, details: any);
    code: any;
    details: any;
}

type GatewayOptions$1 = {
    browser?: ReturnType<typeof createBrowserSessionRegistry>;
    protocol?: number;
    features?: string[];
    heartbeatMs?: number;
    /**
     * Idle spin-down (spec decision 14). When > 0 and `onIdle` is set, the daemon
     * fires `onIdle` once it has been idle — no WS clients, no in-flight runs, no
     * registered crons or pending timers — for this many milliseconds. Wired by
     * the CLI for autostarted daemons only; 0 (default) never idle-exits.
     */
    idleTimeoutMs?: number;
    /** Called once when the daemon goes idle for `idleTimeoutMs` (graceful shutdown). */
    onIdle?: () => void | Promise<void>;
    auth?: GatewayAuthConfig$1;
    /**
     * Deliberately trust any Host header on an unauthenticated bind (the daemon
     * equivalent of `smithers gateway --insecure`). Without it, an unauthenticated
     * gateway rejects any non-loopback Host as a DNS-rebinding defense, so binding
     * `--host 0.0.0.0` without a token would 403 every LAN request. Ignored when
     * `auth` is set. Mirrors serve.js's `insecure`.
     */
    insecure?: boolean;
    ui?: GatewayUiConfig$1;
    /**
     * Optional host-owned HTTP fallback. The Gateway still owns its native
     * /health, /metrics, /workflows, /v1/rpc, /rpc, websocket, webhook, and UI
     * routes; this hook runs before the built-in 404 so an embedding app can
     * serve product-specific HTTP surfaces from the same listener without
     * standing up Express or a second server.
     *
     * Return true after writing the response, false to let Gateway continue.
     */
    routes?: (req: IncomingMessage$1, res: ServerResponse$2, context: {
        gateway: unknown;
        url: URL;
    }) => boolean | Promise<boolean>;
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
     * Host-owned refresh hook for workflow registry misses. The gateway invokes
     * it only when a requested workflow key is not registered, then retries the
     * lookup. A CLI host can rescan its workspace packs and call
     * `gateway.register(...)` without making the server package own CLI-specific
     * discovery and module-loading rules.
     */
    workflowRegistryRefresh?: (workflowKey: string) => void | Promise<void>;
    /** Current workflow discovery/loading progress, advertised additively by health. */
    workflowRegistryStatus?: () => {
        workflowsLoaded?: number;
        workflowsTotal?: number;
    };
    /** Resolves when the host has finished loading the discovered workflow registry. */
    workflowRegistryReady?: () => void | Promise<void>;
    /**
     * Identity advertised on `GET /health`, the `health` RPC, and the WS hello
     * (together with `workspaceRoot`, the process pid, and the listen time).
     * Clients use it to verify they reached the gateway for the workspace they
     * resolved locally instead of trusting whichever process owns the port.
     */
    identity?: {
        /** Storage backend the workspace store resolved to (sqlite | pglite | postgres). */
        backend?: string;
        /** smthrs package version serving this gateway. */
        version?: string;
    };
    /**
     * Built-in browser console for operators. Set to false to disable it.
     * @default { path: "/console" }
     */
    operatorUi?: GatewayOperatorUiConfig$1 | false;
    /**
     * Host-injected PTY hijack launcher for the `/v1/pty/hijack` websocket
     * channel. Given a run (and optionally the node whose agent session should
     * be handed off), return the argv to spawn inside a real PTY — the smithers
     * CLI wires `smithers hijack <runId> [--target <nodeId>]` here. Omit to
     * disable the channel (upgrades answer 501). The Gateway itself never
     * guesses how to resume an agent CLI session.
     */
    hijackPty?: (params: {
        runId: string;
        nodeId?: string;
    }) => {
        command: string[];
        cwd?: string;
        env?: Record<string, string | undefined>;
    } | null;
    /**
     * Host-owned built-in oneshot controls. The CLI injects these because it
     * owns agent session argv, resume-target argv, and cheap narrator selection;
     * the Gateway only authenticates and transports monitor requests.
     */
    oneshotMonitor?: {
        attach(params: {
            runId: string;
            adapter: SmithersDb$4;
        }): Promise<Record<string, unknown>>;
        steer(params: {
            runId: string;
            message: string;
            adapter: SmithersDb$4;
        }): Promise<Record<string, unknown>>;
        restart(params: {
            runId: string;
            adapter: SmithersDb$4;
        }): Promise<Record<string, unknown>>;
    };
    defaults?: GatewayDefaults$1;
    maxBodyBytes?: number;
    maxPayload?: number;
    /**
     * Cap on authenticated WebSocket connections. Pre-authenticated sockets do
     * not count against this pool — they are bounded separately by
     * `maxPreAuthConnections` and only consume authenticated capacity once a
     * successful `connect` promotes them.
     * @default 1000
     */
    maxConnections?: number;
    /**
     * Cap on upgraded WebSocket connections that have not yet completed a
     * successful `connect` RPC. Keeps a pool of idle unauthenticated sockets
     * from exhausting `maxConnections` authenticated capacity; the slot is
     * released on promotion, close, or failed authentication.
     * @default 64
     */
    maxPreAuthConnections?: number;
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
    /**
     * Maximum time (in milliseconds) a WebSocket connection may stay
     * unauthenticated after upgrade. Sockets hold a `maxConnections` slot from
     * the moment of upgrade but only authenticate via the `connect` RPC, so a
     * silent socket is terminated once this deadline elapses, releasing its
     * slot.
     * @default 10000
     */
    authDeadlineMs?: number;
};

type ConnectRequest$1 = {
    minProtocol: number;
    maxProtocol: number;
    client: {
        id: string;
        version: string;
        platform: string;
        pid?: number;
    };
    auth?: {
        token: string;
    };
    subscribe?: string[];
};

type HelloResponse$1 = {
    protocol: number;
    features: string[];
    /**
     * Which workspace/process answered, so clients can verify they reached the
     * gateway they resolved locally (see also `GET /health`).
     */
    identity: {
        workspaceRoot: string | null;
        backend: string | null;
        version: string | null;
        pid: number;
        startedAtMs: number;
    };
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
    /** Internal plumbing workflow (e.g. init): excluded from default `listWorkflows` results unless the caller opts in via `filter.includeSystem`. */
    system?: boolean;
    /**
     * Absolute path of the workflow source file this entry was loaded from.
     * Threaded into `runWorkflow` as `workflowPath` so gateway-hosted runs record
     * real durability metadata (entry/module-graph hashes) — and, critically, so
     * the gateway can RESUME a parked run started elsewhere (e.g. a detached CLI
     * run paused at an approval gate): without a path the resume computes no
     * hashes and the engine rejects it with RESUME_METADATA_MISMATCH.
     */
    entryFile?: string;
};

type EventFrame$1 = {
    type: "event";
    event: string;
    payload?: unknown;
    seq: number;
    stateVersion: number;
    apiVersion?: "v1";
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
type GatewayScope = "run:read" | "run:write" | "run:admin" | "approval:submit" | "signal:submit" | "cron:read" | "cron:write" | "observability:read";
declare const EXTENSION_METHOD_PREFIX: "ext.";
declare const EXTENSION_STREAM_METHOD_PREFIX: "ext.stream.";

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
declare function clampFrameStartedByPrompt(params: unknown): void;
declare function validateGatewayMethodName(method: any): string;
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
declare function statusForRpcError(code: string | undefined): 401 | 403 | 404 | 400 | 409 | 429 | 413 | 501 | 500;
declare const GATEWAY_RPC_MAX_PAYLOAD_BYTES: 1048576;
declare const GATEWAY_RPC_MAX_DEPTH: 32;
declare const GATEWAY_RPC_MAX_ARRAY_LENGTH: 256;
declare const GATEWAY_RPC_MAX_STRING_LENGTH: number;
declare const GATEWAY_METHOD_NAME_MAX_LENGTH: 64;
declare const GATEWAY_FRAME_ID_MAX_LENGTH: 128;
declare const GATEWAY_RPC_INPUT_MAX_BYTES: 1048576;
declare const GATEWAY_RPC_INPUT_MAX_DEPTH: 32;
/**
 * Browser session cookie carrying the gateway bearer token. Browsers cannot
 * send an Authorization header on top-level navigations (or WebSocket
 * upgrades), so `GET /v1/auth/session` exchanges a bearer for this HttpOnly
 * cookie and every authenticated path accepts it as an alternative. SameSite=Lax
 * keeps it off cross-site subrequests (CSRF), matching the Origin allow-list
 * model.
 */
declare const GATEWAY_SESSION_COOKIE: "smithers_session";
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
    maxPreAuthConnections: number;
    eventWindowSize: number;
    outOfProcessEventBridge: boolean;
    outOfProcessEventBridgePollMs: number;
    headersTimeout: number;
    requestTimeout: number;
    authDeadlineMs: number;
    auth: GatewayAuthConfig$1 | undefined;
    ui: ResolvedGatewayUiConfig | null;
    operatorUi: ResolvedGatewayUiConfig | null;
    uiApp: hono.Hono<hono_types.BlankEnv, hono_types.BlankSchema, "/">;
    defaults: GatewayDefaults$1 | undefined;
    routes: ((req: node_http.IncomingMessage, res: node_http.ServerResponse, context: {
        gateway: unknown;
        url: URL;
    }) => boolean | Promise<boolean>) | null;
    /**
     * Absolute workspace root for disk-backed registry reads (e.g. the
     * `listPrompts` RPC, which walks `<workspaceRoot>/.smithers/prompts/`).
     * `null` ⇒ fall back to `process.cwd()`. Set from `options.workspaceRoot`.
     * @type {string | null}
     */
    workspaceRoot: string | null;
    browser: {
        create: ({ source, viewport }: {
            source: any;
            viewport?: {
                width: number;
                height: number;
            } | undefined;
        }) => Promise<{
            sessionId: any;
            source: any;
            status: any;
            revision: any;
            page: {
                url: any;
                title: any;
                canGoBack: boolean;
                canGoForward: boolean;
            } | null;
            viewport: any;
            control: {
                owner: any;
            };
        }>;
        act: (params: any) => Promise<any>;
        context: ({ sessionId, sinceRevision, include }: {
            sessionId: any;
            sinceRevision: any;
            include?: never[] | undefined;
        }) => Promise<any>;
        pick: ({ sessionId, point }: {
            sessionId: any;
            point: any;
        }) => Promise<any>;
        close: (sessionId: any) => Promise<{
            closed: boolean;
            sessionId?: undefined;
        } | {
            closed: boolean;
            sessionId: any;
        }>;
        list: () => Promise<{
            sessionId: any;
            source: any;
            status: any;
            revision: any;
            page: {
                url: any;
                title: any;
                canGoBack: boolean;
                canGoForward: boolean;
            } | null;
            viewport: any;
            control: {
                owner: any;
            };
        }[]>;
        subscribe: (kind: any, listener: any) => () => any;
        setFrameSubscribers: (sessionId: any, count: any) => Promise<void>;
        get: (id: any) => any;
        shutdown: () => Promise<void>;
        BrowserError: {
            new (code: any, message: any, details: any): {
                name: string;
                code: any;
                details: any;
                message: string;
                stack?: string;
                cause?: unknown;
                readonly "~effect/Runtime/errorExitCode"?: number;
                readonly "~effect/Runtime/errorReported"?: boolean;
                readonly "~effect/ErrorReporter/ignore"?: boolean;
                readonly "~effect/ErrorReporter/severity"?: effect_LogLevel.Severity;
                readonly "~effect/ErrorReporter/attributes"?: effect_Record.ReadonlyRecord<string, unknown>;
            };
            isError(error: unknown): error is Error;
            isError(value: unknown): value is Error;
            captureStackTrace(targetObject: object, constructorOpt?: Function): void;
            captureStackTrace(targetObject: object, constructorOpt?: Function): void;
            prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
            stackTraceLimit: number;
        };
    };
    workflows: Map<any, any>;
    /**
     * Host-owned workspace workflow rescan. It is intentionally invoked only
     * after a concrete key misses the in-memory registry.
     * @type {((workflowKey: string) => void | Promise<void>) | null}
     */
    workflowRegistryRefresh: ((workflowKey: string) => void | Promise<void>) | null;
    workflowRegistryStatus: null;
    workflowRegistryReady: null;
    /** @type {Map<string, Promise<void>>} */
    workflowRegistryRefreshes: Map<string, Promise<void>>;
    /**
     * Register-time rewind recovery touches the workflow database after
     * `register()` returns. Track those jobs so `close()` is a real I/O barrier:
     * callers may safely close or remove their backend once it resolves.
     * @type {Set<Promise<void>>}
     */
    startupRecoveryJobs: Set<Promise<void>>;
    /**
     * Background <UI>/<TUI> discovery. register() never renders a workflow
     * synchronously: renders are queued and drained one per macrotask so a slow
     * or throwing workflow can neither block startup nor starve /health.
     * @type {Array<{ key: string, workflow: SmithersWorkflow, entryFile: string | undefined, resolve: () => void }>}
     */
    viewDiscoveryQueue: Array<{
        key: string;
        workflow: SmithersWorkflow;
        entryFile: string | undefined;
        resolve: () => void;
    }>;
    /** @type {Map<string, { workflow: SmithersWorkflow, promise: Promise<void> }>} */
    viewDiscoveryPending: Map<string, {
        workflow: SmithersWorkflow;
        promise: Promise<void>;
    }>;
    /**
     * Keys whose discovery render already ran (success OR failure), mapped to
     * the workflow identity that was rendered. A render runs at most once per
     * registration identity — a throwing render is skipped after one warn and
     * never retried in a hot loop.
     * @type {Map<string, SmithersWorkflow>}
     */
    viewDiscoveryCompleted: Map<string, SmithersWorkflow>;
    viewDiscoveryScheduled: boolean;
    /** Instance copy so tests can shrink the slow-render warn budget. */
    viewDiscoverySlowMs: number;
    /** @type {{ reports: UsageReport[], cachedAtMs: number } | null} */
    usageReportsCache: {
        reports: UsageReport[];
        cachedAtMs: number;
    } | null;
    /** @type {Promise<UsageReport[]> | null} */
    usageReportsInFlight: Promise<UsageReport[]> | null;
    connections: Set<any>;
    /**
     * Subset of `connections` still awaiting a successful `connect` RPC.
     * Pre-auth sockets hold a slot in this bounded pool instead of consuming
     * authenticated `maxConnections` capacity; a successful `connect` promotes
     * them out and close / failed authentication releases the slot (#1008).
     * @type {Set<Record<string, unknown>>}
     */
    preAuthConnections: Set<Record<string, unknown>>;
    runRegistry: Map<any, any>;
    activeRuns: Map<any, any>;
    inflightRuns: Map<any, any>;
    /**
     * Resume attempts keyed by run id.
     * @type {Map<string, Promise<void>>}
     */
    inflightResumes: Map<string, Promise<void>>;
    devtoolsSubscribers: Map<any, any>;
    /** @type {Set<Promise<void>>} */
    devtoolsStreamJobs: Set<Promise<void>>;
    runEventWindows: Map<any, any>;
    runEventSubscriberCounts: Map<any, any>;
    runEventSubscriberTotal: number;
    /** Active streamRunEvents subscriber count per user identity (userId ?? tokenId ?? role). @type {Map<string, number>} */
    runEventSubscribersByUser: Map<string, number>;
    runEventStreamMaxSubscribers: number;
    runEventStreamMaxSubscribersPerUser: number;
    runEventStreamMaxSubscribersPerConnection: number;
    runEventStreamMaxSubscribersPerRun: number;
    terminalRunEventWindows: Map<any, any>;
    terminalRunEventWindowTimers: Map<any, any>;
    apiStreamSeq: number;
    apiStreamFrames: any[];
    apiStreamFrameBytes: number;
    apiStreamSubscribers: Set<any>;
    apiStreamPendingCollections: Set<any>;
    apiStreamPendingResolvers: any[];
    apiStreamFlushTimer: null;
    apiStreamMaxSubscribers: number;
    apiStreamMaxSubscribersPerUser: number;
    apiStreamMaxSubscribersPerConnection: number;
    /** Active SSE subscriber count per user identity (userId ?? tokenId ?? role). @type {Map<string, number>} */
    apiStreamSubscribersByUser: Map<string, number>;
    /** Active SSE subscriber count per declared connection id (`x-request-id`). @type {Map<string, number>} */
    apiStreamSubscribersByConnection: Map<string, number>;
    /** One shared heartbeat interval for every SSE subscriber (never one per subscriber). */
    apiStreamHeartbeatTimer: null;
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
    idleTimeoutMs: number;
    /** @type {(() => void | Promise<void>) | null} */
    onIdle: (() => void | Promise<void>) | null;
    lastActivityMs: number;
    /** @type {ReturnType<typeof setInterval> | null} */
    idleTimer: ReturnType<typeof setInterval> | null;
    idleFired: boolean;
    hasActiveCrons: boolean;
    hasPendingTimers: boolean;
    cronSweepInFlight: boolean;
    trustedProxies: {
        cidrs: {
            bytes: Uint8Array;
            prefix: number;
        }[];
        unix: boolean;
    } | null;
    unixSocketListener: boolean;
    trustAnyHost: boolean;
    whatHappenedNarrator: any;
    /** @type {Map<string, { payload: Record<string, unknown> }>} */
    whatHappenedCache: Map<string, {
        payload: Record<string, unknown>;
    }>;
    hijackPty: ((params: {
        runId: string;
        nodeId?: string;
    }) => {
        command: string[];
        cwd?: string;
        env?: Record<string, string | undefined>;
    } | null) | null;
    oneshotMonitor: {
        attach(params: {
            runId: string;
            adapter: SmithersDb$4;
        }): Promise<Record<string, unknown>>;
        steer(params: {
            runId: string;
            message: string;
            adapter: SmithersDb$4;
        }): Promise<Record<string, unknown>>;
        restart(params: {
            runId: string;
            adapter: SmithersDb$4;
        }): Promise<Record<string, unknown>>;
    } | null;
    /** @type {Set<{ runId?: string; dispose: () => void }>} */
    ptySessions: Set<{
        runId?: string;
        dispose: () => void;
    }>;
    gatewayClosing: boolean;
    identity: {
        backend?: string;
        version?: string;
    } | null;
    /**
     * Identity block advertised on `GET /health`, the `health` RPC, and the WS
     * hello. Lets a client verify it reached the gateway for the workspace it
     * resolved locally instead of trusting whichever process owns the port.
     */
    buildIdentity(): {
        workspaceRoot: string | null;
        backend: string | null;
        version: string | null;
        pid: number;
        startedAtMs: number;
    };
    workflowRegistryProgress(): {
        workflowsLoaded: number;
        workflowsTotal: number;
    };
    /** Wait for a host-owned registry load before returning aggregate data. */
    awaitWorkflowRegistryReady(): Promise<void>;
    /**
     * Give the host one chance to register an unknown workflow. Concurrent
     * requests for the same key share a single rescan, and loader failures are
     * warnings rather than request/server failures.
     * @param {string} workflowKey
     * @returns {Promise<boolean>}
     */
    refreshWorkflowRegistryOnMiss(workflowKey: string): Promise<boolean>;
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
    resolvedUiFor(key: string, entry: RegisteredWorkflow): GatewayUiConfig | null;
    /**
     * @returns {GatewayUiMount[]}
     */
    getUiMounts(): GatewayUiMount[];
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
    workflowUiMountRedirect(workflowKey: string, url: URL): string | null;
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
    }): Promise<string>;
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
    handleAuthSession(req: IncomingMessage, res: ServerResponse$1): Promise<void>;
    /**
     * @param {IncomingMessage} req
     * @param {ServerResponse} res
     */
    handleUiHttp(req: IncomingMessage, res: ServerResponse$1): Promise<boolean>;
    /**
     * @param {IncomingMessage} req
     * @param {ServerResponse} res
     */
    handleRootRequest(req: IncomingMessage, res: ServerResponse$1): Promise<void>;
    /**
     * @param {string} key
     * @param {RegisteredWorkflow} entry
     */
    workflowSummary(key: string, entry: RegisteredWorkflow): {
        hasUi: boolean;
        uiPath: any;
        system: boolean;
        description?: string | undefined;
        readableName?: string | undefined;
        key: string;
    };
    /**
     * @param {boolean | undefined} hasUi
     * @param {boolean | undefined} [includeSystem] System (internal plumbing) workflows are hidden unless true.
     */
    listWorkflowSummaries(hasUi: boolean | undefined, includeSystem?: boolean | undefined): {
        hasUi: boolean;
        uiPath: any;
        system: boolean;
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
     * @returns {number}
     */
    getRunEventSubscriberCount(runId: string): number;
    /**
     * @param {string} runId
     */
    deleteRunEventWindow(runId: string): void;
    /**
     * @param {string} runId
     */
    clearTerminalRunEventWindowTimer(runId: string): void;
    /**
     * @param {string} runId
     */
    scheduleTerminalRunEventWindowRelease(runId: string): void;
    /**
     * @param {string} runId
     * @returns {boolean}
     */
    releaseTerminalRunEventWindow(runId: string): boolean;
    /**
     * @param {string} runId
     */
    markRunEventWindowTerminal(runId: string): void;
    enforceRunEventWindowLimit(): void;
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
     * First cap a run-event subscription would violate, or null when it fits.
     * The caller checks this immediately before registration, with no await in
     * between, so rejection happens before a stream map, heartbeat, or counter
     * is allocated.
     * @param {ConnectionState} connection
     * @param {string} runId
     * @returns {{ scope: "global" | "user" | "connection" | "run"; limit: number } | null}
     */
    runEventStreamCapViolation(connection: ConnectionState, runId: string): {
        scope: "global" | "user" | "connection" | "run";
        limit: number;
    } | null;
    /**
     * @param {ConnectionState} connection
     * @param {string} streamId
     * @param {string} runId
     * @param {boolean} [replayPending]
     * @returns {() => void}
     */
    registerRunEventSubscriber(connection: ConnectionState, streamId: string, runId: string, replayPending?: boolean): () => void;
    /**
     * Start the connection's shared run-event heartbeat timer. Each WebSocket
     * connection owns at most ONE heartbeat interval no matter how many run
     * event streams it registers; every tick emits one `run.heartbeat` frame
     * per active stream. No-op while the timer is already running; the timer
     * stops when the last stream unregisters (or the connection tears down).
     * @param {ConnectionState} connection
     */
    startRunEventHeartbeat(connection: ConnectionState): void;
    /**
     * @param {ConnectionState} connection
     */
    stopRunEventHeartbeat(connection: ConnectionState): void;
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
     * @param {boolean} [replay]
     */
    sendRunEventStreamFrame(connection: ConnectionState, streamId: string, frame: Record<string, unknown>, replay?: boolean): void;
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
    buildRunSnapshot(runId: string): Promise<{
        failedChildren?: number;
        failedChildKeys?: string[];
        runState?: _smthrs_db_runState.RunStateView | undefined;
        workflowKey: string;
        summary: {};
        runId: string;
        parentRunId: string | null;
        workflowName: string;
        workflowPath: string | null;
        workflowHash: string | null;
        status: string;
        createdAtMs: number;
        startedAtMs: number | null;
        finishedAtMs: number | null;
        heartbeatAtMs: number | null;
        runtimeOwnerId: string | null;
        cancelRequestedAtMs: number | null;
        cancelRequestId: string | null;
        cancelRequestSource: string | null;
        cancelRequestDetail: string | null;
        cancelRequestSignal: string | null;
        cancelRequestClientIdentity: string | null;
        cancelRequestClientPid: number | null;
        pauseRequestedAtMs?: number | null;
        hijackRequestedAtMs: number | null;
        hijackTarget: string | null;
        vcsType: string | null;
        vcsRoot: string | null;
        vcsRevision: string | null;
        errorJson: string | null;
        configJson: string | null;
    } | null>;
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
     * @param {Record<string, unknown>} frame
     */
    recordApiStreamFrame(frame: Record<string, unknown>): void;
    /**
     * @param {Record<string, unknown>} subscriber
     */
    drainApiStreamSubscriber(subscriber: Record<string, unknown>): void;
    /**
     * @param {Record<string, unknown>} subscriber
     * @param {string} text
     * @param {number} bytes
     */
    enqueueApiStreamText(subscriber: Record<string, unknown>, text: string, bytes?: number): void;
    /**
     * @param {Record<string, unknown>} subscriber
     * @param {Record<string, unknown>} frame
     */
    sendApiStreamFrame(subscriber: Record<string, unknown>, frame: Record<string, unknown>): void;
    /**
     * @param {string[]} collections
     * @returns {Promise<number>}
     */
    queueApiInvalidation(collections: string[]): Promise<number>;
    flushApiInvalidation(): void;
    /**
     * First cap an SSE subscription would violate, or null when it fits.
     * Checked before headers are written so rejected requests get a real
     * 429 JSON body instead of a half-open stream.
     * @param {string} userKey
     * @param {string} connectionKey
     * @returns {{ scope: "global" | "user" | "connection"; limit: number } | null}
     */
    apiStreamCapViolation(userKey: string, connectionKey: string): {
        scope: "global" | "user" | "connection";
        limit: number;
    } | null;
    ensureApiStreamHeartbeat(): void;
    stopApiStreamHeartbeatIfIdle(): void;
    /**
     * @param {IncomingMessage} req
     * @param {ServerResponse} res
     */
    handleApiStream(req: IncomingMessage, res: ServerResponse$1): Promise<void>;
    /**
     * @param {string} method
     * @param {Record<string, unknown>} params
     * @returns {Promise<SmithersDb | null>}
     */
    adapterForApiMutation(method: string, params: Record<string, unknown>): Promise<SmithersDb$4 | null>;
    /**
     * @param {string} httpMethod
     * @param {URL} url
     * @param {Record<string, unknown>} body
     * @returns {{ method: string; params: Record<string, unknown>; mutation?: boolean; direct?: "events" } | null}
     */
    apiRouteForRequest(httpMethod: string, url: URL, body: Record<string, unknown>): {
        method: string;
        params: Record<string, unknown>;
        mutation?: boolean;
        direct?: "events";
    } | null;
    /**
     * @param {Record<string, unknown>} params
     * @returns {Promise<Record<string, unknown>[]>}
     */
    listApiRunEvents(params: Record<string, unknown>): Promise<Record<string, unknown>[]>;
    /**
     * @param {IncomingMessage} req
     * @param {ServerResponse} res
     */
    handleHttpApi(req: IncomingMessage, res: ServerResponse$1): Promise<void>;
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
     * Queue a background <UI>/<TUI> discovery render for a registered workflow.
     * At most one render ever runs per registration identity: a workflow whose
     * render throws is skipped after one warn and never retried.
     * @param {string} key
     * @param {SmithersWorkflow} workflow
     * @param {string | undefined} entryFile
     */
    enqueueWorkflowViewDiscovery(key: string, workflow: SmithersWorkflow, entryFile: string | undefined): void;
    scheduleWorkflowViewDiscoveryDrain(): void;
    drainWorkflowViewDiscovery(): void;
    /**
     * @param {{ key: string; workflow: SmithersWorkflow; entryFile: string | undefined; resolve: () => void }} item
     */
    runWorkflowViewDiscovery(item: {
        key: string;
        workflow: SmithersWorkflow;
        entryFile: string | undefined;
        resolve: () => void;
    }): void;
    /**
     * Wait for a workflow's discovery render, pulling it out of the background
     * queue and rendering it now when a request needs its view immediately.
     * @param {string} key
     */
    awaitWorkflowViewDiscovery(key: string): Promise<void>;
    /** Wait for every queued discovery render, drained one per macrotask. */
    awaitAllWorkflowViewDiscovery(): Promise<void>;
    /** Settle every queued discovery without rendering (gateway shutdown). */
    cancelWorkflowViewDiscovery(): void;
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
    handlePtyHijackUpgrade(req: IncomingMessage, socket: node_stream.Duplex, head: Buffer, wsServer: WebSocketServer, url: URL): Promise<void>;
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
    startPtyHijackSession(ws: ws.WebSocket, params: {
        runId: string;
        nodeId?: string;
        cols: number;
        rows: number;
    }): void;
    /**
     * Best-effort recovery after a PTY hijack process died without cleanly
     * returning control (tab closed, socket dropped, launcher crashed). Only
     * acts when the run is still parked by the hijack; a run the operator
     * already resumed/cancelled is left alone.
     * @param {string} runId
     */
    resumeRunAfterHijackHalt(runId: string): Promise<void>;
    /**
     * @param {{ port?: number; host?: string; path?: string }} [options]
     */
    listen(options?: {
        port?: number;
        host?: string;
        path?: string;
    }): Promise<node_http.Server<typeof node_http.IncomingMessage, typeof node_http.ServerResponse>>;
    /**
     * @param {{ killRuns?: boolean }} [options]
     */
    close(options?: {
        killRuns?: boolean;
    }): Promise<void>;
    ticketWatchers: Map<any, any> | null | undefined;
    startScheduler(): void;
    /**
     * Record client activity for idle spin-down (spec decision 14). Called on
     * every RPC (HTTP + WS) and on each new WS connection. If the daemon had
     * already fired onIdle but a client came back, re-arm the monitor.
     */
    markActivity(): void;
    /**
     * Whether the daemon has nothing to do: no attached WS clients, no in-flight
     * runs, and no registered crons or pending durable timers. Schedules count as
     * "busy" so an autostarted daemon that owns a schedule does not idle-exit and
     * silently stop firing it.
     * @returns {boolean}
     */
    isIdle(): boolean;
    startIdleMonitor(): void;
    stopIdleMonitor(): void;
    checkIdle(): Promise<void>;
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
     * @param {{ resume?: boolean; maxConcurrency?: number; allowNetwork?: boolean; maxOutputBytes?: number; toolTimeoutMs?: number; startedBy?: import("@smthrs/driver/RunStartedBy").RunStartedBy }} [options]
     */
    startRun(workflowKey: string, input: Record<string, unknown>, auth: RunStartAuthContext, runId?: string, options?: {
        resume?: boolean;
        maxConcurrency?: number;
        allowNetwork?: boolean;
        maxOutputBytes?: number;
        toolTimeoutMs?: number;
        startedBy?: _smthrs_driver_RunStartedBy.RunStartedBy;
    }): Promise<{
        runId: string;
        workflow: string;
        system: boolean;
    }>;
    /**
     * @param {string} runId
     * @param {string} workflowKey
     * @param {SmithersDb} adapter
     * @param {RunStartAuthContext} auth
     */
    resumeRunIfNeeded(runId: string, workflowKey: string, adapter: SmithersDb$4, auth: RunStartAuthContext): Promise<void>;
    /**
     * @param {string} runId
     * @param {string} workflowKey
     * @param {SmithersDb} adapter
     * @param {RunStartAuthContext} auth
     */
    resumeRunInBackground(runId: string, workflowKey: string, adapter: SmithersDb$4, auth: RunStartAuthContext): void;
    /**
     * Authenticated WS connection count. `connections` holds every open RPC
     * websocket while `preAuthConnections` tracks the subset still awaiting a
     * successful `connect`, so the difference is the authenticated pool that
     * `maxConnections` bounds (#1008).
     * @returns {number}
     */
    authenticatedConnectionCount(): number;
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
    isRequestOriginAllowed(req: IncomingMessage): boolean;
    /**
     * For cookie-authenticated requests, whether the browser `Origin` is trusted:
     * absent/"null" (non-browser), on the configured allow-list, or same-host as
     * the request `Host` (the gateway's own origin). Cross-origin cookie auth is
     * refused even with an empty allow-list, because the SameSite=Lax cookie is
     * an ambient credential a sibling same-site origin can trigger.
     * @param {IncomingMessage} req
     * @returns {boolean}
     */
    isCookieOriginTrusted(req: IncomingMessage): boolean;
    /**
     * The immediate transport peer of `req`: the address of the socket that is
     * actually connected to this process.
     *
     * Deliberately NOT derived from `X-Forwarded-For` (or any other header):
     * those are supplied by the very caller whose provenance is in question, so
     * reading the peer from them would make the trust check circular. Behind a
     * proxy chain (`client -> edge -> internal proxy -> gateway`) the peer is the
     * LAST hop, the one that opened this connection — only that hop belongs in
     * `trustedProxies`, and the earlier hops in `X-Forwarded-For` are just data
     * the trusted proxy vouched for. A request whose socket reports no remote
     * address arrived over a Unix-domain socket, whose peer set is bounded by the
     * socket file's filesystem permissions rather than by an address.
     * @param {IncomingMessage} req
     * @returns {{ kind: "ip"; address: string } | { kind: "unix" }}
     */
    requestPeer(req: IncomingMessage): {
        kind: "ip";
        address: string;
    } | {
        kind: "unix";
    };
    /**
     * Whether `req`'s transport peer is a configured trusted proxy, the only
     * condition under which trusted-proxy identity headers may be honored (#785).
     * @param {IncomingMessage} req
     * @returns {boolean}
     */
    isTrustedProxyPeer(req: IncomingMessage): boolean;
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
    isHostAllowed(req: IncomingMessage): boolean;
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
     * @param {ConnectionState} connection
     * @returns {ConnectionEventWriterState}
     */
    getConnectionEventWriter(connection: ConnectionState): ConnectionEventWriterState;
    /**
     * Observable buffered event bytes for a connection: what the socket itself
     * reports (bufferedAmount) plus what the bounded writer is still holding.
     * @param {ConnectionState} connection
     * @returns {number}
     */
    getConnectionBufferedEventBytes(connection: ConnectionState): number;
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
    writeConnectionEventFrame(connection: ConnectionState, writer: ConnectionEventWriterState, data: string, event: string): void;
    /**
     * Drain the connection writer's queue against the socket's buffered bytes.
     * Mirrors drainRunEventStream: a congested socket re-arms a short retry
     * instead of dropping frames; the byte cap (enforced at enqueue time) is
     * what bounds memory and trips the per-connection disconnect.
     * @param {ConnectionState} connection
     * @param {ConnectionEventWriterState} writer
     */
    drainConnectionEventWriter(connection: ConnectionState, writer: ConnectionEventWriterState): void;
    /**
     * Per-connection overflow behavior: a consumer that stays congested past the
     * socket high-water mark AND fills the byte-bounded queue is disconnected
     * outright (close 1013 Try Again Later) — the socket's close handler tears
     * down every stream on the connection, and nothing further buffers for it.
     * @param {ConnectionState} connection
     * @param {ConnectionEventWriterState} writer
     * @param {string} event
     */
    disconnectConnectionForEventBackpressure(connection: ConnectionState, writer: ConnectionEventWriterState, event: string): void;
    /**
     * @param {string} event
     * @param {unknown} [payload]
     */
    browserSubscriberCount(sessionId: any): number;
    broadcastEvent(event: any, payload: any): void;
    buildSnapshot(): Promise<{
        runs: any[];
        approvals: {
            runId: string;
            workflowKey: string;
            nodeId: string;
            iteration: number;
            requestTitle: any;
            requestSummary: string | null;
            requestedAtMs: number | null;
            approvalMode: "gate" | "decision" | "select" | "rank";
            options: {
                key: string;
                label: string;
                summary?: string;
            }[];
            allowedScopes: string[];
            allowedUsers: string[];
            autoApprove: Record<string, unknown> | null;
        }[];
        stateVersion: number;
    }>;
    /**
     * @param {SmithersWorkflow} workflow
     * @returns {SmithersDb}
     */
    adapterForWorkflow(workflow: SmithersWorkflow): SmithersDb$4;
    adapterCache: Map<any, any> | undefined;
    adapterByStore: Map<any, any> | undefined;
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
    resolveRunWorkflowKey(row: {
        configJson?: string;
        workflowName?: string;
        workflowPath?: string;
    }, registeredKeys: Set<string>, fallbackKey: string): string;
    /**
     * @param {string} [status]
     * @param {string} [workflow]
     * @param {number} [offset] Rows to skip after the newest-first sort (server-side pagination).
     * @param {boolean} [includeSystem] Include internal and historical unstamped runs.
     * @param {string} [parentRunId] Return only direct children of this run.
     */
    listRunsAcrossWorkflows(limit?: number, status?: string, workflow?: string, offset?: number, includeSystem?: boolean, parentRunId?: string): Promise<any[]>;
    /**
     * Cross-run memory facts for the `listMemoryFacts` RPC. Memory is global (keyed
     * by namespace+key, not per-run), so iterate each DISTINCT workflow DB exactly
     * once — shared-DB workflows share an adapter — and union the rows, deduping on
     * `${namespace}\u0000${key}` so a fact stored in a shared DB is returned once.
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
     * through the `@smthrs/accounts` package's `listAccounts()` and
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
     * Raw registered accounts for host-side provider probes. This method must
     * never be returned directly over the wire because API-key accounts include
     * their credential.
     */
    registeredAccountsFromRegistry(): {
        label: string;
        provider: "claude-code" | "antigravity" | "codex" | "kimi" | "anthropic-api" | "openai-api" | "gemini-api";
        configDir?: string;
        apiKey?: string;
        model?: string;
        addedAt?: string;
    }[];
    /**
     * Injection seam for tests; production delegates to the usage package.
     * @param {ReturnType<Gateway["registeredAccountsFromRegistry"]>} accounts
     * @param {{ fresh?: boolean }} options
     * @returns {Promise<UsageReport[]>}
     */
    fetchUsageReports(accounts: ReturnType<Gateway["registeredAccountsFromRegistry"]>, options: {
        fresh?: boolean;
    }): Promise<UsageReport[]>;
    /**
     * Provider rate-limit and subscription-usage reports. Normal polling shares
     * one in-flight request and reuses its result for 60 seconds; `fresh` skips
     * the Gateway cache while still honoring provider safety in the usage package.
     * @param {{ fresh?: boolean }} [options]
     * @returns {Promise<UsageReport[]>}
     */
    listUsageReports(options?: {
        fresh?: boolean;
    }): Promise<UsageReport[]>;
    /**
     * Every persisted TokenUsageReported attempt event for a run. Unlike the
     * live event collections this reads the complete durable history and is not
     * bounded by a client replay/ring window.
     * @param {string} runId
     * @returns {Promise<{ runId: string; events: Array<Record<string, string | number>> } | null>}
     */
    listRunTokenUsage(runId: string): Promise<{
        runId: string;
        events: Array<Record<string, string | number>>;
    } | null>;
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
    listScoresForRunsAcrossStores(query: {
        runIds: string[];
        nodeId?: string;
        scorerId?: string;
        scorerName?: string;
        source?: string;
        order: "scoredAtAsc" | "scoredAtDesc";
        offset: number;
        limit: number;
    }): Promise<{
        missingRunId: string;
    } | {
        rows: Array<Record<string, unknown>>;
        total: number;
    }>;
    /**
     * Read and decode one exact persisted score row. Missing runs and missing
     * score ids remain distinct so the typed RPC errors stay precise; malformed
     * JSON throws `Internal`.
     * @param {string} runId
     * @param {string} scoreId
     * @returns {Promise<{ missing: "run" | "score" } | { detail: Record<string, unknown> }>}
     */
    getScoreDetailForRun(runId: string, scoreId: string): Promise<{
        missing: "run" | "score";
    } | {
        detail: Record<string, unknown>;
    }>;
    /**
     * The ONE adapter that backs the ticket WRITE RPCs (create/update/delete) and
     * the file-watcher. `_smithers_docs` is a SINGLE global table (not per-run,
     * not per-workflow), so writes must land in one deterministic DB — the first
     * registered workflow's adapter. `listTickets` still reads across every
     * distinct adapter (so a doc in any shared DB surfaces), but a write has to
     * pick one; picking the first registered keeps create→list→update→delete
     * consistent. Returns `null` only when no workflow is registered yet.
     * @returns {import("@smthrs/db/adapter").SmithersDb | null}
     */
    primaryDocsAdapter(): _smthrs_db_adapter.SmithersDb | null;
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
        runId: string;
        workflowKey: string;
        nodeId: string;
        iteration: number;
        requestTitle: any;
        requestSummary: string | null;
        requestedAtMs: number | null;
        approvalMode: "gate" | "decision" | "select" | "rank";
        options: {
            key: string;
            label: string;
            summary?: string;
        }[];
        allowedScopes: string[];
        allowedUsers: string[];
        autoApprove: Record<string, unknown> | null;
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
    listCrons(): Promise<{
        workflow: any;
    }[]>;
    /**
     * @param {string} cronId
     */
    findCron(cronId: string): Promise<{
        cron: Record<string, unknown>;
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
     * @returns {string | null}
     */
    terminalRunIdFromSmithersEvent(event: SmithersEvent$1): string | null;
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
    browserCall(frame: any, operation: any): Promise<ResponseFrame$1>;
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
    userKey: string;
    outboundQueue: Record<string, unknown>[];
    flushPending: boolean;
    backpressureDisconnected: boolean;
    replayPending: boolean;
};
type ConnectionEventWriterState = {
    queue: Array<{
        data: string;
        bytes: number;
        event: string;
    }>;
    queuedBytes: number;
    flushPending: boolean;
    disconnected: boolean;
};
type GatewayAuthConfig = GatewayAuthConfig$1;
type GatewayOperatorUiConfig = GatewayOperatorUiConfig$1;
type GatewayOptions = GatewayOptions$1;
type GatewayWebhookConfig = GatewayWebhookConfig$1;
type IncomingMessage = node_http.IncomingMessage;
type RequestFrame = RequestFrame$1;
type ResponseFrame = ResponseFrame$1;
type ServerResponse$1 = node_http.ServerResponse;
type SmithersWorkflow = _smthrs_components_SmithersWorkflow.SmithersWorkflow<unknown>;
type SmithersEvent$1 = _smthrs_observability_SmithersEvent.SmithersEvent;
type UsageReport = _smthrs_usage.UsageReport;
type GatewayMetricLabels = Record<string, string | number | null | undefined>;
type GatewayTransport = "ws" | "http";
type GatewayRequestContext = {
    connectionId?: string;
    requestId?: string;
    clientPid?: number | null;
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
    runEventHeartbeatTimer?: ReturnType<typeof setInterval> | null;
    lastActivity?: number;
    closed?: boolean;
    eventWriter?: ConnectionEventWriterState | null;
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
    key: string;
    schedule?: string;
    webhook?: GatewayWebhookConfig;
    ui?: ResolvedGatewayUiConfig | null;
    tui?: ResolvedWorkflowTuiConfig | null;
    system?: boolean;
    entryFile?: string;
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
    inline?: {
        kind: "literal";
        tree: unknown;
    } | {
        kind: "component";
        source: string;
        exportName?: string;
    };
};
type ResolvedWorkflowTuiConfig = {
    kind: "tui";
    title?: string;
    props?: Record<string, unknown>;
    entry?: string;
    source?: string;
    exportName?: string;
    inline?: {
        kind: "literal";
        tree: unknown;
    } | {
        kind: "component";
        source: string;
        exportName?: string;
    };
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
    /**
     * Opt out of the unauthenticated Host/Origin rebinding+CSRF defense for a
     * deliberate remote unauthenticated bind (the CLI `--insecure` flag). Ignored
     * when `authToken` is set (the token is the gate). `SMITHERS_SERVE_TRUST_ANY_HOST`
     * is an equivalent env opt-out.
     */
    insecure?: boolean;
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
declare function runFork<A, E, R>(effect: Effect.Effect<A, E, R>): effect_Fiber.Fiber<A, E>;
/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
declare function runSync<A, E, R>(effect: Effect.Effect<A, E, R>): A;

declare const NODE_OUTPUT_MAX_BYTES: number;

declare const NODE_OUTPUT_WARN_BYTES: 1048576;

/** @typedef {import("@smthrs/protocol/errors").NodeOutputErrorCode} NodeOutputErrorCode */
declare class NodeOutputRouteError extends Error {
    /**
     * @param {NodeOutputErrorCode} code
     * @param {string} message
     */
    constructor(code: NodeOutputErrorCode, message: string);
    /** @type {NodeOutputErrorCode} */
    code: NodeOutputErrorCode;
}
type NodeOutputErrorCode = _smthrs_protocol_errors.NodeOutputErrorCode;

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
 * @param {Map<string, { iteration?: number; kind?: string; agentSummary?: DevToolsAgentSummary; maxAttempts?: number }>} [taskIndex]
 * @returns {DevToolsNode}
 */
declare function parseXmlToDevToolsRoot(xml: unknown, onWarning?: (warning: SnapshotSerializerWarning$1) => void, taskIndex?: Map<string, {
    iteration?: number;
    kind?: string;
    agentSummary?: DevToolsAgentSummary;
    maxAttempts?: number;
}>): DevToolsNode;
/**
 * @param {{
 *   runId: string;
 *   frameNo: number;
 *   xmlJson: string;
 *   taskIndexJson?: string | null;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 * }} input
 * @returns {DevToolsSnapshot}
 */
declare function snapshotFromFrameRow(input: {
    runId: string;
    frameNo: number;
    xmlJson: string;
    taskIndexJson?: string | null;
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
 * Attach each task node's CURRENT lifecycle state (latest iteration wins) from
 * the run's `_smithers_nodes` rows. The frame tree is pure structure; without
 * this, every consumer of the snapshot renders live runs as all-queued (#817).
 * Nodes with no row yet (never scheduled) keep an absent `state`.
 *
 * @param {DevToolsNode} root
 * @param {Array<Record<string, unknown>>} nodeRows
 * @returns {void}
 */
declare function attachNodeStatesToDevToolsRoot(root: DevToolsNode, nodeRows: Array<Record<string, unknown>>): void;
/**
 * Attach the agent that ACTUALLY executed each task node (engine/model/agentId
 * from the latest eligible attempt's persisted `metaJson` — the same metadata
 * the hijack candidates read, see ../hijackCandidates.js) plus the task's
 * initial prompt. Eligibility is scoped to attempts started at or before the
 * requested frame and to the task's captured iteration, so historical frames
 * do not display metadata from future retries or loop iterations. Declared
 * assignments (`task.agentSummary`) come from the frame's task index instead;
 * this covers running/settled nodes and runs recorded before declared-agent
 * capture. Only the newest eligible attempt per node and iteration is parsed —
 * attempt metaJson can carry whole conversations, so parsing every row would
 * be wasteful.
 *
 * @param {DevToolsNode} root
 * @param {Array<Record<string, unknown>>} attemptRows
 * @param {number} [frameCreatedAtMs]
 * @returns {void}
 */
declare function attachAgentAttemptsToDevToolsRoot(root: DevToolsNode, attemptRows: Array<Record<string, unknown>>, frameCreatedAtMs?: number): void;
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
/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smthrs/protocol/devtools").DevToolsNode} DevToolsNode */
/** @typedef {import("@smthrs/protocol/devtools").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("@smthrs/protocol/devtools").DevToolsNodeType} DevToolsNodeType */
/** @typedef {import("@smthrs/devtools/snapshotSerializer").SnapshotSerializerWarning} SnapshotSerializerWarning */
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
/**
 * Upper bound for the task prompt carried on a snapshot node. Attempt metadata
 * keeps the full text (see `smithers node detail`); the snapshot only needs
 * enough for the inspector's Prompt panel, and frames stream to every
 * subscribed client, so unbounded prompts are not allowed through.
 */
declare const DEVTOOLS_TASK_PROMPT_MAX_CHARS: 4000;
type DevToolsAgentRef = _smthrs_protocol_devtools.DevToolsAgentRef;
type DevToolsAgentSummary = _smthrs_protocol_devtools.DevToolsAgentSummary;
type SmithersDb$3 = _smthrs_db_adapter.SmithersDb;
type DevToolsNode = _smthrs_protocol_devtools.DevToolsNode;
type DevToolsSnapshot = _smthrs_protocol_devtools.DevToolsSnapshot;
type DevToolsNodeType = _smthrs_protocol_devtools.DevToolsNodeType;
type SnapshotSerializerWarning$1 = _smthrs_devtools_snapshotSerializer.SnapshotSerializerWarning;

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
    /** True when computed from the live working copy of an in-progress attempt. */
    live?: boolean;
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

declare const RUN_ID_PATTERN: RegExp;

/**
 * @param {string} pointer
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
declare function resolveCommitPointer(pointer: string, cwd: string): Promise<string | null>;
/**
 * @param {{
 *   runId: unknown;
 *   nodeId: unknown;
 *   iteration: unknown;
 *   resolveRun: (runId: string) => Promise<{ adapter: SmithersDb } | null>;
 *   emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
 *   computeDiffBundleImpl?: (baseRef: string, cwd: string, seq?: number) => Promise<import("@smthrs/engine/effect/DiffBundle").DiffBundle>;
 *   computeDiffBundleBetweenRefsImpl?: (baseRef: string, targetRef: string, cwd: string, seq?: number) => Promise<import("@smthrs/engine/effect/DiffBundle").DiffBundle>;
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
    computeDiffBundleImpl?: (baseRef: string, cwd: string, seq?: number) => Promise<_smthrs_engine_effect_DiffBundle.DiffBundle>;
    computeDiffBundleBetweenRefsImpl?: (baseRef: string, targetRef: string, cwd: string, seq?: number) => Promise<_smthrs_engine_effect_DiffBundle.DiffBundle>;
    resolveCommitPointerImpl?: (pointer: string, cwd: string) => Promise<string | null>;
    nowMs?: () => number;
    stat?: boolean;
}): Promise<GetNodeDiffRouteResult>;
type SmithersDb$2 = _smthrs_db_adapter.SmithersDb;
type AttemptRow = _smthrs_db_adapter.AttemptRow;
type GetNodeDiffRouteResult = GetNodeDiffRouteResult$1;
type DiffSummary = DiffSummary$1;

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smthrs/db/adapter").AttemptRow} AttemptRow */
/** @typedef {import("./GetNodeDiffRouteResult.js").GetNodeDiffRouteResult} GetNodeDiffRouteResult */
/** @typedef {import("./DiffSummary.js").DiffSummary} DiffSummary */
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

/**
 * Compute the final run diff directly between the run base and terminal VCS
 * revisions. Each checkout lane is reduced to its terminal tree; cached node
 * bundles are used only when the terminal checkout has been reaped.
 */
declare function getRunDiffRoute({ runId: rawRunId, resolveRun, computeDiffBundleBetweenRefsImpl, computeDiffBundleImpl, resolveCommitPointerImpl, }: {
    runId: any;
    resolveRun: any;
    computeDiffBundleBetweenRefsImpl?: typeof computeDiffBundleBetweenRefs | undefined;
    computeDiffBundleImpl?: typeof computeDiffBundle | undefined;
    resolveCommitPointerImpl?: typeof resolveCommitPointer | undefined;
}): Promise<{
    ok: boolean;
    payload: any;
} | {
    ok: boolean;
    error: {
        code: any;
        message: string;
    };
}>;
declare const RUN_DIFF_MAX_BYTES: number;

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
    /**
     * Why the node failed (from the latest attempt's stored error), present only
     * when `status` is "failed" and an error was recorded.
     */
    error?: {
        name?: string;
        code?: string;
        message: string;
        attempt?: number;
    } | null;
};

/**
 * Resolve per-node output row plus schema hints for DevTools rendering.
 *
 * @param {{
 *   runId: unknown;
 *   nodeId: unknown;
 *   iteration: unknown;
 *   resolveRun: (runId: string) => Promise<{ workflow: import("@smthrs/components/SmithersWorkflow").SmithersWorkflow<unknown>; adapter: import("@smthrs/db/adapter").SmithersDb } | null>;
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
        workflow: _smthrs_components_SmithersWorkflow.SmithersWorkflow<unknown>;
        adapter: _smthrs_db_adapter.SmithersDb;
    } | null>;
    selectOutputRowImpl?: typeof selectOutputRow;
    emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
}): Promise<NodeOutputResponse>;
type NodeOutputResponse = NodeOutputResponse$1;

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smthrs/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("@smthrs/time-travel/jumpToFrame").JumpResult} JumpResult */
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
 *   force?: unknown;
 *   noRevert?: unknown;
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
    force?: unknown;
    noRevert?: unknown;
    caller?: string;
    pauseRunLoop?: () => Promise<void> | void;
    resumeRunLoop?: () => Promise<void> | void;
    emitEvent?: (event: SmithersEvent) => Promise<void> | void;
    captureReconcilerState?: () => Promise<unknown> | unknown;
    restoreReconcilerState?: (snapshot: unknown) => Promise<void> | void;
    rebuildReconcilerState?: (xmlJson: string) => Promise<void> | void;
    onLog?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => Promise<void> | void;
}): Promise<JumpResult>;

type SmithersDb$1 = _smthrs_db_adapter.SmithersDb;
type SmithersEvent = _smthrs_observability_SmithersEvent.SmithersEvent;
type JumpResult = _smthrs_time_travel_jumpToFrame.JumpResult;

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
/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smthrs/protocol/devtools").DevToolsEvent} DevToolsEvent */
/** @typedef {import("@smthrs/protocol/devtools").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("@smthrs/devtools/snapshotSerializer").SnapshotSerializerWarning} SnapshotSerializerWarning */
declare const DEVTOOLS_REBASELINE_INTERVAL: 50;
declare const DEVTOOLS_BACKPRESSURE_LIMIT: 1000;
declare const DEVTOOLS_POLL_INTERVAL_MS: 25;
type SmithersDb = _smthrs_db_adapter.SmithersDb;
type DevToolsEvent = _smthrs_protocol_devtools.DevToolsEvent;
type SnapshotSerializerWarning = _smthrs_devtools_snapshotSerializer.SnapshotSerializerWarning;

/**
 * @param {ServerOptions} [opts]
 */
declare function startServerEffect(opts?: ServerOptions): Effect.Effect<node_http.Server<typeof node_http.IncomingMessage, typeof node_http.ServerResponse>, never, never>;
/**
 * @param {ServerOptions} [opts]
 */
declare function startServer(opts?: ServerOptions): node_http.Server<typeof node_http.IncomingMessage, typeof node_http.ServerResponse>;

declare namespace __serverTestInternals {
    export { buildMirrorOnProgress };
    export { getDbIdentity };
    export { isSameDb };
    export { scheduleRunCleanup };
    export { clearRunCleanupTimer };
}
type ServerResponse = node_http.ServerResponse;
type ServerOptions = ServerOptions$1;
type ApprovalRequestRecord = ApprovalRequestRecord$1;

/**
 * @param {SmithersDb | null} adapter
 * @param {string} runId
 * @param {string} workflowName
 * @param {string} workflowPath
 * @param {string} configJson
 */
declare function buildMirrorOnProgress(adapter: SmithersDb$4 | null, runId: string, workflowName: string, workflowPath: string, configJson: string): ((event: any) => void) | undefined;
/**
 * @param {unknown} db
 * @returns {string | undefined}
 */
declare function getDbIdentity(db: unknown): string | undefined;
/**
 * @param {unknown | null} serverDb
 * @param {unknown} workflowDb
 * @returns {boolean}
 */
declare function isSameDb(serverDb: unknown | null, workflowDb: unknown): boolean;
/**
 * @param {Map<string, RunRecord>} runRegistry
 * @param {string} runId
 */
declare function scheduleRunCleanup(runRegistry: Map<string, RunRecord>, runId: string): void;
/**
 * @param {RunRecord | undefined} record
 */
declare function clearRunCleanupTimer(record: RunRecord | undefined): void;

export { type ApprovalRequestRecord, type AttemptRow, type ConnectRequest, type ConnectionEventWriterState, type ConnectionState, DEVTOOLS_BACKPRESSURE_LIMIT, DEVTOOLS_EMPTY_ROOT_ID, DEVTOOLS_MAX_FRAME_NO, DEVTOOLS_POLL_INTERVAL_MS, DEVTOOLS_REBASELINE_INTERVAL, DEVTOOLS_RUN_ID_PATTERN, DEVTOOLS_TASK_PROMPT_MAX_CHARS, DEVTOOLS_TREE_MAX_DEPTH, type DevToolsAgentRef, type DevToolsAgentSummary, type DevToolsEvent, type DevToolsNode, type DevToolsNodeType, DevToolsRouteError, type DiffSummary, EXTENSION_BACKPRESSURE_DISCONNECT_CODE, EXTENSION_METHOD_NOT_FOUND_CODE, EXTENSION_METHOD_PREFIX, EXTENSION_PAYLOAD_MAX_BYTES, EXTENSION_STREAM_METHOD_PREFIX, EXTENSION_STREAM_OUTBOUND_QUEUE_LIMIT, EXTENSION_WS_BUFFERED_HIGH_WATER_BYTES, type EventFrame, GATEWAY_FRAME_ID_MAX_LENGTH, GATEWAY_METHOD_NAME_MAX_LENGTH, GATEWAY_RPC_INPUT_MAX_BYTES, GATEWAY_RPC_INPUT_MAX_DEPTH, GATEWAY_RPC_MAX_ARRAY_LENGTH, GATEWAY_RPC_MAX_DEPTH, GATEWAY_RPC_MAX_PAYLOAD_BYTES, GATEWAY_RPC_MAX_STRING_LENGTH, GATEWAY_SESSION_COOKIE, Gateway, type GatewayAuthConfig, type GatewayDefaults, type GatewayExtensionAction, type GatewayExtensionContext, type GatewayExtensionDefinition, type GatewayExtensionResource, type GatewayExtensionStream, type GatewayExtensionStreamContext, GatewayExtensions, type GatewayMetricLabels, type GatewayOperatorUiConfig, type GatewayOptions, type GatewayRegisterOptions, type GatewayRequestContext, type GatewayScope, type GatewayTokenGrant, type GatewayTransport, type GatewayUiConfig, type GatewayUiMount, type GatewayWebhookConfig, type GatewayWebhookRunConfig, type GatewayWebhookSignalConfig, type GetNodeDiffRouteResult, type HelloResponse, ITERATION_MAX, type IncomingMessage, type IntegrationsConfig, type IntegrationsWebhookSourceConfig, type JumpResult, NODE_ID_PATTERN, NODE_OUTPUT_MAX_BYTES, NODE_OUTPUT_WARN_BYTES, type NodeOutputErrorCode, type NodeOutputResponse, NodeOutputRouteError, RUN_DIFF_MAX_BYTES, RUN_ID_PATTERN, type RegisteredWorkflow, type RequestFrame, type ResolvedExtension, type ResolvedGatewayUiConfig, type ResolvedRun, type ResolvedWorkflowTuiConfig, type ResponseFrame, type RunEventStreamState, type RunStartAuthContext, type ServeOptions, type ServerOptions, type ServerResponse, type SmithersWorkflow, type UsageReport, __serverTestInternals, approvalDecision, assertGatewayInputDepthWithinBounds, attachAgentAttemptsToDevToolsRoot, attachNodeStatesToDevToolsRoot, clampFrameStartedByPrompt, createBrowserSessionRegistry, createServeApp, emptyDevToolsRoot, extensionMethodName, getDevToolsSnapshotRoute, getGatewayInputDepth, getNodeDiffRoute, getNodeOutputRoute, getRunDiffRoute, isExtensionMethod, jumpToFrameRoute, parseGatewayRequestFrame, parseXmlToDevToolsRoot, resolveCommitPointer, runFork, runPromise, runSync, snapshotFromFrameRow, startServer, startServerEffect, statusForRpcError, streamDevToolsRoute, summarizeBundle, validateFrameNoInput, validateFromSeqInput, validateGatewayMethodName, validateRequestedFrameNo, validateRunId };
