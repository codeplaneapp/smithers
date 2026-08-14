import { Server } from 'node:http';
import { GatewayScope } from '@smthrs/gateway/auth/scopes';

type SmithersElectricProxyMetricSnapshot$1 = {
    shapeOpens: number;
    shapeOpenRejected: number;
    activeShapes: number;
    replayGaps: number;
    largeFrames: number;
    forwardedBytes: number;
    upstreamErrors: number;
    lastSyncLagMs: number | null;
};
type SmithersElectricProxyMetrics$1 = {
    snapshot(): SmithersElectricProxyMetricSnapshot$1;
    incShapeOpen(): void;
    incShapeOpenRejected(): void;
    incReplayGap(): void;
    incLargeFrame(): void;
    incUpstreamError(): void;
    addForwardedBytes(bytes: number): void;
    setActiveShapes(count: number): void;
    observeSyncLag(ms: number): void;
    renderPrometheus(): string;
};

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
type SmithersElectricProxyEvent$1 = {
    type: "electric.shape.open" | "electric.shape.rejected" | "electric.shape.forwarded" | "electric.upstream.error" | "electric.write.commit" | "electric.write.rejected";
    principalId: string;
    table?: string;
    shape?: string;
    reason?: string;
    requiredScope?: string;
    status?: number;
    durationMs?: number;
    forwardedBytes?: number;
    lagMs?: number;
    txid?: number | null;
    method?: string;
};
type SmithersElectricProxySpan$1 = {
    name: string;
    attributes: Record<string, unknown>;
};
type SmithersElectricProxyObserver$1 = {
    event?: (event: SmithersElectricProxyEvent$1) => void;
    span?: (span: SmithersElectricProxySpan$1) => void;
};

type SmithersElectricShapeDefinition$2 = {
    name: string;
    table: string;
    requiredScope: GatewayScope;
    whereTemplate?: string;
    runIdColumn?: string;
    workspaceIdColumn?: string;
    userPrivateColumn?: string;
    tablePattern?: RegExp;
    description?: string;
};

type SmithersElectricAuthContext$1 = {
    principalId?: string;
    userId?: string;
    tokenId?: string;
    scopes: readonly string[];
    grantedRunIds?: readonly string[];
    grantedWorkspaceIds?: readonly string[];
    /**
     * Single-user local-cloud installs (one tenant, no per-run partitioning) can
     * opt OUT of run/workspace scoping by setting this. Absent or false, the
     * proxy fails CLOSED: a run/workspace-scoped shape with no concrete grant
     * array is rejected rather than forwarded unscoped. Cloud auth must derive
     * concrete grants and leave this unset.
     */
    unscoped?: boolean;
};
type SmithersElectricScopeDecision$1 = {
    event: "smithers-electric.scope";
    allowed: boolean;
    reason: string;
    table: string;
    shape: string;
    requiredScope: GatewayScope;
    principalId: string;
};
type SmithersElectricProxyOptions$2 = {
    electricUrl: string;
    authenticate: (request: Request) => Promise<SmithersElectricAuthContext$1 | null> | SmithersElectricAuthContext$1 | null;
    fetchClient?: typeof fetch;
    now?: () => number;
    rateLimits?: {
        openPerMinute?: number;
        activeMax?: number;
    };
    maxFrameBytes?: number;
    catalog?: readonly SmithersElectricShapeDefinition$2[];
    /**
     * Explicit allowlist of workflow output-table names that may be opened as
     * run-scoped shapes. Empty (the default) exposes NO output tables. Derive
     * this from the real output-table registry — never a regex catch-all.
     */
    outputTables?: readonly string[];
    /**
     * Reclaim an active-shape slot whose stream never started draining after this
     * many ms. Without it, a client that opens shapes but never reads or cancels
     * the body holds active slots forever and self-DoSes with permanent 429s.
     */
    activeTtlMs?: number;
    metrics?: SmithersElectricProxyMetrics$1;
    observer?: SmithersElectricProxyObserver$1;
    log?: (decision: SmithersElectricScopeDecision$1) => void;
};
type SmithersElectricProxy$2 = {
    fetch(request: Request): Promise<Response>;
    metrics: SmithersElectricProxyMetrics$1;
};

type ServeSmithersElectricProxyOptions$1 = {
    proxy: SmithersElectricProxy$2;
    port?: number;
    host?: string;
};
type SmithersElectricProxyServer$1 = {
    server: Server;
    port: number;
    close(): Promise<void>;
};

/**
 * Build the auth, scope, rate-limit, and observability proxy that fronts an
 * ElectricSQL shape endpoint for Smithers clients.
 *
 * @param {SmithersElectricProxyOptions} options
 * @returns {SmithersElectricProxy}
 */
declare function createSmithersElectricProxy(options: SmithersElectricProxyOptions$1): SmithersElectricProxy$1;
type SmithersElectricProxy$1 = SmithersElectricProxy$2;
type SmithersElectricProxyOptions$1 = SmithersElectricProxyOptions$2;

/**
 * Build the in-process metrics registry for the Electric proxy: counters and
 * gauges for shape opens/rejections, active streams, replay gaps, frame-bound
 * violations, forwarded bytes, upstream errors, and sync lag, plus a Prometheus
 * text rendering for the proxy's `/metrics` route.
 *
 * @returns {import("./SmithersElectricProxyMetrics.ts").SmithersElectricProxyMetrics}
 */
declare function createSmithersElectricProxyMetrics(): SmithersElectricProxyMetrics$1;

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
declare function emitSmithersElectricEvent(observer: SmithersElectricProxyObserver$1 | undefined, event: SmithersElectricProxyEvent$1): void;

/**
 * Run the Smithers Electric proxy as a real Node HTTP server. This is the
 * runnable cloud entry point that fronts `electricsql/electric` with auth,
 * scope, grant-based where filling, rate limits, frame bounds, and
 * metrics/spans (the `/metrics` and `/healthz` routes are served by the proxy).
 *
 * @param {import("./ServeSmithersElectricProxyOptions.ts").ServeSmithersElectricProxyOptions} options
 * @returns {Promise<import("./ServeSmithersElectricProxyOptions.ts").SmithersElectricProxyServer>}
 */
declare function serveSmithersElectricProxy(options: ServeSmithersElectricProxyOptions$1): Promise<SmithersElectricProxyServer$1>;

/**
 * Build a run-scoped shape entry for one workflow output table. Output tables
 * are NOT a regex catch-all (that would expose any identifier-named table that
 * happens to carry a `run_id` column); the proxy must be handed the explicit
 * allowlist of real output-table names — derived from the output-table
 * registry — so only enumerated tables are reachable, each still scoped by
 * `run_id IN ({run_ids})`.
 *
 * @param {string} table
 * @returns {SmithersElectricShapeDefinition}
 */
declare function outputTableShape(table: string): SmithersElectricShapeDefinition$1;
/**
 * Compose the base `_smithers_*` shape catalog with explicit per-table entries
 * for the supplied output-table allowlist. Passing `[]` (the default) means no
 * output table is reachable at all.
 *
 * @param {readonly string[]} outputTables
 * @returns {readonly SmithersElectricShapeDefinition[]}
 */
declare function smithersElectricCatalogWithOutputTables(outputTables: readonly string[]): readonly SmithersElectricShapeDefinition$1[];
/** @typedef {import("./SmithersElectricShapeDefinition.ts").SmithersElectricShapeDefinition} SmithersElectricShapeDefinition */
/** @type {readonly SmithersElectricShapeDefinition[]} */
declare const smithersElectricShapeCatalog: readonly SmithersElectricShapeDefinition$1[];
type SmithersElectricShapeDefinition$1 = SmithersElectricShapeDefinition$2;

type SmithersElectricAuthContext = SmithersElectricAuthContext$1;
type SmithersElectricProxy = SmithersElectricProxy$2;
type SmithersElectricProxyOptions = SmithersElectricProxyOptions$2;
type SmithersElectricScopeDecision = SmithersElectricScopeDecision$1;
type SmithersElectricProxyMetrics = SmithersElectricProxyMetrics$1;
type SmithersElectricProxyMetricSnapshot = SmithersElectricProxyMetricSnapshot$1;
type SmithersElectricShapeDefinition = SmithersElectricShapeDefinition$2;
type SmithersElectricProxyObserver = SmithersElectricProxyObserver$1;
type SmithersElectricProxyEvent = SmithersElectricProxyEvent$1;
type SmithersElectricProxySpan = SmithersElectricProxySpan$1;
type ServeSmithersElectricProxyOptions = ServeSmithersElectricProxyOptions$1;
type SmithersElectricProxyServer = SmithersElectricProxyServer$1;

export { type ServeSmithersElectricProxyOptions, type SmithersElectricAuthContext, type SmithersElectricProxy, type SmithersElectricProxyEvent, type SmithersElectricProxyMetricSnapshot, type SmithersElectricProxyMetrics, type SmithersElectricProxyObserver, type SmithersElectricProxyOptions, type SmithersElectricProxyServer, type SmithersElectricProxySpan, type SmithersElectricScopeDecision, type SmithersElectricShapeDefinition, createSmithersElectricProxy, createSmithersElectricProxyMetrics, emitSmithersElectricEvent, outputTableShape, serveSmithersElectricProxy, smithersElectricCatalogWithOutputTables, smithersElectricShapeCatalog };
