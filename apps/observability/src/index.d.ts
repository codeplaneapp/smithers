import { LogLevel, Effect, Context, Layer, FiberRef } from 'effect';
import * as effect_Tracer from 'effect/Tracer';
import { M as MetricsServiceShape$1, a as MetricLabels$1, b as MetricsSnapshot$1, S as SmithersEvent$1, c as SmithersMetricDefinition$1 } from './rewindSandboxesReverted-DNiqPX1B.js';
export { d as activeNodes, e as activeRuns, f as approvalPending, g as approvalWaitDuration, h as approvalsDenied, i as approvalsGranted, j as approvalsRequested, k as attemptDuration, l as cacheHits, m as cacheMisses, n as dbQueryDuration, o as dbRetries, p as dbTransactionDuration, q as dbTransactionRetries, r as dbTransactionRollbacks, s as errorsTotal, t as eventsEmittedTotal, u as externalWaitAsyncPending, v as hotReloadDuration, w as hotReloadFailures, x as hotReloads, y as httpRequestDuration, z as httpRequests, A as metricsServiceAdapter, B as nodeDuration, C as nodeRetriesTotal, D as nodesFailed, E as nodesFinished, F as nodesStarted, G as processHeapUsedBytes, H as processMemoryRssBytes, I as processUptimeSeconds, J as promptSizeBytes, K as replaysStarted, L as responseSizeBytes, N as rewindDurationMs, O as rewindFramesDeleted, P as rewindRollbackTotal, Q as rewindSandboxesReverted, R as rewindTotal, T as runDuration, U as runForksCreated, V as runsAncestryDepth, W as runsCancelledTotal, X as runsCarriedStateBytes, Y as runsContinuedTotal, Z as runsFailedTotal, _ as runsFinishedTotal, $ as runsResumedTotal, a0 as runsTotal, a1 as sandboxActive, a2 as sandboxBundleSizeBytes, a3 as sandboxCompletedTotal, a4 as sandboxCreatedTotal, a5 as sandboxDurationMs, a6 as sandboxPatchCount, a7 as sandboxTransportDurationMs, a8 as schedulerConcurrencyUtilization, a9 as schedulerQueueDepth, aa as schedulerWaitDuration, ab as scorerEventsFailed, ac as scorerEventsFinished, ad as scorerEventsStarted, ae as smithersMetricCatalog, af as snapshotDuration, ag as snapshotsCaptured, ah as timerDelayDuration, ai as timersCancelled, aj as timersCreated, ak as timersFired, al as timersPending, am as toPrometheusMetricName, an as tokensCacheReadTotal, ao as tokensCacheWriteTotal, ap as tokensContextWindowBucketTotal, aq as tokensContextWindowPerCall, ar as tokensInputPerCall, as as tokensInputTotal, at as tokensOutputPerCall, au as tokensOutputTotal, av as tokensReasoningTotal, aw as toolCallErrorsTotal, ax as toolCallsTotal, ay as toolDuration, az as toolOutputTruncatedTotal, aA as trackSmithersEvent, aB as updateProcessMetrics, aC as vcsDuration } from './rewindSandboxesReverted-DNiqPX1B.js';
import * as effect_Metric from 'effect/Metric';
import * as BunContext from '@effect/platform-bun/BunServices';

type SmithersLogFormat$1 = "json" | "pretty" | "string" | "logfmt";

type ResolvedSmithersObservabilityOptions$2 = {
    readonly enabled: boolean;
    readonly endpoint: string;
    readonly headers: Record<string, string> | undefined;
    readonly serviceName: string;
    readonly logFormat: SmithersLogFormat$1;
    readonly logLevel: LogLevel.LogLevel;
    readonly installLogger: boolean;
};

type SmithersObservabilityService$1 = {
    readonly options: ResolvedSmithersObservabilityOptions$2;
    readonly annotate: (attributes: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
    readonly withSpan: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: Readonly<Record<string, unknown>>) => Effect.Effect<A, E, Exclude<R, effect_Tracer.ParentSpan>>;
};

type SmithersObservabilityOptions$4 = {
    readonly enabled?: boolean;
    readonly endpoint?: string;
    readonly headers?: Record<string, string>;
    readonly serviceName?: string;
    readonly logFormat?: SmithersLogFormat$1;
    readonly logLevel?: LogLevel.LogLevel | string;
    readonly installLogger?: boolean;
};

type CorrelationContext$5 = {
    runId: string;
    nodeId?: string;
    iteration?: number;
    attempt?: number;
    workflowName?: string;
    parentRunId?: string;
    traceId?: string;
    spanId?: string;
};

type CorrelationPatch$5 = Partial<CorrelationContext$5> | undefined | null;

declare class MetricsService extends Context.ServiceClass.Shape<"MetricsService", MetricsServiceShape$1> {
}

declare class SmithersObservability extends Context.ServiceClass.Shape<"SmithersObservability", SmithersObservabilityService$1> {
}

declare const prometheusContentType: "text/plain; version=0.0.4; charset=utf-8";

declare namespace smithersSpanNames {
    let run: string;
    let task: string;
    let agent: string;
    let tool: string;
}

/**
 * @returns {import("effect/Tracer").AnySpan | undefined}
 */
declare function getCurrentSmithersTraceSpan(): effect_Tracer.AnySpan | undefined;

/**
 * @returns {| Readonly<Record<string, string>> | undefined}
 */
declare function getCurrentSmithersTraceAnnotations(): Readonly<Record<string, string>> | undefined;

/**
 * @typedef {Readonly<Record<string, unknown>>} SmithersSpanAttributesInput
 */
/**
 * @param {SmithersSpanAttributesInput} [attributes]
 * @returns {Record<string, unknown>}
 */
declare function makeSmithersSpanAttributes(attributes?: SmithersSpanAttributesInput): Record<string, unknown>;
type SmithersSpanAttributesInput = Readonly<Record<string, unknown>>;

/**
 * @param {Readonly<Record<string, unknown>>} [attributes]
 * @returns {Effect.Effect<void>}
 */
declare function annotateSmithersTrace(attributes?: Readonly<Record<string, unknown>>): Effect.Effect<void>;

/**
 * @template A, E, R
 * @param {string} name
 * @param {Effect.Effect<A, E, R>} effect
 * @param {Readonly<Record<string, unknown>>} [attributes]
 * @param {Omit<import("effect/Tracer").SpanOptions, "attributes" | "kind"> & { readonly kind?: import("effect/Tracer").SpanKind; }} [_options]
 * @returns {Effect.Effect<A, E, Exclude<R, import("effect/Tracer").ParentSpan>>}
 */
declare function withSmithersSpan<A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: Readonly<Record<string, unknown>>, _options?: Omit<effect_Tracer.SpanOptions, "attributes" | "kind"> & {
    readonly kind?: effect_Tracer.SpanKind;
}): Effect.Effect<A, E, Exclude<R, effect_Tracer.ParentSpan>>;

/**
 * @returns {string}
 */
declare function renderPrometheusMetrics(): string;

/**
 * @param {SmithersObservabilityOptions} [options]
 * @returns {ResolvedSmithersObservabilityOptions}
 */
declare function resolveSmithersObservabilityOptions(options?: SmithersObservabilityOptions$3): ResolvedSmithersObservabilityOptions$1;
type ResolvedSmithersObservabilityOptions$1 = ResolvedSmithersObservabilityOptions$2;
type SmithersObservabilityOptions$3 = SmithersObservabilityOptions$4;

declare const smithersMetrics: {
    [k: string]: effect_Metric.Metric<any, any, any>;
};

/** @type {Layer.Layer<MetricsService, never, never>} */
declare const MetricsServiceLive: Layer.Layer<MetricsService, never, never>;

/** @typedef {import("./SmithersObservabilityOptions.ts").SmithersObservabilityOptions} SmithersObservabilityOptions */
/**
 * @param {SmithersObservabilityOptions} [options]
 */
declare function createSmithersOtelLayer(options?: SmithersObservabilityOptions$2): Layer.Layer<never, never, never>;
type SmithersObservabilityOptions$2 = SmithersObservabilityOptions$4;

type TracingServiceShape = {
    readonly withSpan: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: Record<string, unknown>) => Effect.Effect<A, E, R>;
    readonly annotate: (attributes: Record<string, unknown>) => Effect.Effect<void>;
    readonly withCorrelation: <A, E, R>(context: CorrelationPatch$5, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

declare class TracingService extends Context.ServiceClass.Shape<"TracingService", TracingServiceShape> {
}
/** @type {Layer.Layer<TracingService, never, never>} */
declare const TracingServiceLive: Layer.Layer<TracingService, never, never>;

/**
 * @param {SmithersObservabilityOptions} [options]
 */
declare function createSmithersObservabilityLayer(options?: SmithersObservabilityOptions$1): Layer.Layer<MetricsService | TracingService | SmithersObservability | BunContext.BunContext, never, never>;
type SmithersObservabilityOptions$1 = SmithersObservabilityOptions$4;

declare const createSmithersRuntimeLayer: typeof createSmithersObservabilityLayer;

declare const correlationContextFiberRef: FiberRef.FiberRef<undefined>;

type CorrelationContextServiceShape = {
    readonly current: () => Effect.Effect<CorrelationContext$5 | undefined>;
    readonly withCorrelation: <A, E, R>(patch: CorrelationPatch$5, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly toLogAnnotations: (context?: CorrelationContext$5 | null) => Record<string, unknown> | undefined;
};

declare class CorrelationContextService extends Context.ServiceClass.Shape<"CorrelationContextService", CorrelationContextServiceShape> {
}

/** @type {Layer.Layer<CorrelationContextService, never, never>} */
declare const CorrelationContextLive: Layer.Layer<CorrelationContextService, never, never>;

/**
 * @param {CorrelationContext | null} [base]
 * @param {CorrelationPatch} [patch]
 * @returns {CorrelationContext | undefined}
 */
declare function mergeCorrelationContext(base?: CorrelationContext$4 | null, patch?: CorrelationPatch$4): CorrelationContext$4 | undefined;
type CorrelationContext$4 = CorrelationContext$5;
type CorrelationPatch$4 = CorrelationPatch$5;

/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/**
 * @returns {CorrelationContext | undefined}
 */
declare function getCurrentCorrelationContext(): CorrelationContext$3 | undefined;
type CorrelationContext$3 = CorrelationContext$5;

/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/**
 * @returns {Effect.Effect< CorrelationContext | undefined >}
 */
declare function getCurrentCorrelationContextEffect(): Effect.Effect<CorrelationContext$2 | undefined>;
type CorrelationContext$2 = CorrelationContext$5;

/** @typedef {import("./CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */
/**
 * @template T
 * @param {CorrelationPatch} patch
 * @param {() => T} fn
 * @returns {T}
 */
declare function runWithCorrelationContext<T>(patch: CorrelationPatch$3, fn: () => T): T;
type CorrelationPatch$3 = CorrelationPatch$5;

/** @typedef {import("./CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */
/**
 * Bridge the Effect-tracked correlation context onto the imperative
 * AsyncLocalStorage store so plain (non-Effect) `getCurrentCorrelationContext()`
 * reads — e.g. from the imperative logger — see the active run/node correlation
 * while the effect executes.
 *
 * IMPORTANT: run the resulting effect with `Effect.runPromise`/`runFork`, never
 * `Effect.runSync`. The acquire step calls `AsyncLocalStorage.enterWith()`, which
 * mutates the *caller's* async context. Under `runSync` the caller is whatever
 * synchronous context invoked it (e.g. a test-runner's root context); enabling
 * ALS async-hooks there leaks into every subsequent timer/promise on that
 * context. `runPromise`/`runFork` execute on an ephemeral fiber context, keeping
 * the enterWith scoped to that fiber.
 *
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 * @param {CorrelationPatch} patch
 */
declare function withCorrelationContext<A, E, R>(effect: Effect.Effect<A, E, R>, patch: CorrelationPatch$2): Effect.Effect<A, E, R>;
type CorrelationPatch$2 = CorrelationPatch$5;

/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
declare function withCurrentCorrelationContext<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;

/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/**
 * @param {CorrelationContext | null} [context]
 * @returns {Record<string, unknown> | undefined}
 */
declare function correlationContextToLogAnnotations(context?: CorrelationContext$1 | null): Record<string, unknown> | undefined;
type CorrelationContext$1 = CorrelationContext$5;

/**
 * Temporary compatibility shim for legacy, non-Effect callers.
 *
 * Unlike the FiberRef-based core implementation
 * ({@link import("./_coreCorrelation/updateCurrentCorrelationContext.js").updateCurrentCorrelationContext}),
 * which returns an Effect and sets a fresh merged context on the
 * `correlationContextFiberRef`, this shim runs synchronously and applies the
 * patch by **mutating the current context object in place** via
 * `Object.assign(current, next)`. Any references already holding the current
 * context object will observe the mutation. This in-place semantics is
 * intentional and exists only to preserve behavior for callers that captured a
 * context reference before the Effect-based API existed.
 *
 * If there is no current context, the patch is a no-op (nothing is created).
 *
 * @deprecated Prefer the Effect-returning
 * `updateCurrentCorrelationContext` from
 * `@smithers-orchestrator/observability` (the `_coreCorrelation` version),
 * which does not mutate shared state. This shim will be removed once legacy
 * callers migrate.
 *
 * @param {CorrelationPatch} patch
 * @returns {void}
 */
declare function updateCurrentCorrelationContext(patch: CorrelationPatch$1): void;
type CorrelationPatch$1 = CorrelationPatch$5;

/**
 * Install the Effect runtime used by fire-and-forget observability logs.
 * Returns a restore function so tests and embedded hosts can scope overrides.
 *
 * @param {SmithersLogRunner | null} runner
 * @returns {() => void}
 */
declare function setSmithersLogRunner(runner: SmithersLogRunner | null): () => void;
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logDebug(message: string, annotations?: LogAnnotations, span?: string): void;
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logInfo(message: string, annotations?: LogAnnotations, span?: string): void;
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logWarning(message: string, annotations?: LogAnnotations, span?: string): void;
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logError(message: string, annotations?: LogAnnotations, span?: string): void;
type SmithersLogRunner = {
    runFork: (effect: Effect.Effect<void, never, never>) => unknown;
    runPromise: (effect: Effect.Effect<void, never, never>) => Promise<void>;
};
type LogAnnotations = Record<string, unknown> | undefined;

type CorrelationContext = CorrelationContext$5;
type CorrelationPatch = CorrelationPatch$5;
type CorrelationContextPatch = CorrelationPatch;
type MetricLabels = MetricLabels$1;
type MetricsServiceShape = MetricsServiceShape$1;
type MetricsSnapshot = MetricsSnapshot$1;
type ResolvedSmithersObservabilityOptions = ResolvedSmithersObservabilityOptions$2;
type SmithersEvent = SmithersEvent$1;
type SmithersLogFormat = SmithersLogFormat$1;
type SmithersMetricDefinition = SmithersMetricDefinition$1;
type SmithersObservabilityOptions = SmithersObservabilityOptions$4;
type SmithersObservabilityService = SmithersObservabilityService$1;

export { type CorrelationContext, CorrelationContextLive, type CorrelationContextPatch, CorrelationContextService, type CorrelationPatch, type MetricLabels, MetricsService, MetricsServiceLive, type MetricsServiceShape, type MetricsSnapshot, type ResolvedSmithersObservabilityOptions, type SmithersEvent, type SmithersLogFormat, type SmithersMetricDefinition, SmithersObservability, type SmithersObservabilityOptions, type SmithersObservabilityService, TracingService, TracingServiceLive, annotateSmithersTrace, correlationContextFiberRef, correlationContextToLogAnnotations, createSmithersObservabilityLayer, createSmithersOtelLayer, createSmithersRuntimeLayer, getCurrentCorrelationContext, getCurrentCorrelationContextEffect, getCurrentSmithersTraceAnnotations, getCurrentSmithersTraceSpan, logDebug, logError, logInfo, logWarning, makeSmithersSpanAttributes, mergeCorrelationContext, prometheusContentType, renderPrometheusMetrics, resolveSmithersObservabilityOptions, runWithCorrelationContext, setSmithersLogRunner, smithersMetrics, smithersSpanNames, updateCurrentCorrelationContext, withCorrelationContext, withCurrentCorrelationContext, withSmithersSpan };
