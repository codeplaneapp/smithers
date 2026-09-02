/**
 * Observability for flows: the default OTLP export wiring plus the
 * Effect-native logger, metric, and OpenTelemetry resource layers.
 *
 * The store packages define and update their own metric handles
 * (`JournalMetrics`, `RunStoreMetrics`, `CacheStoreMetrics`,
 * `ArtifactStoreMetrics`, `DatabaseMetrics`) and open spans through Effect's
 * tracer; this package is the exporter they deliberately leave out. `Otlp`
 * only composes what `effect` already ships, so it is browser-bundleable. The
 * remaining modules are the fuller stack folded in from the agent workspace:
 * a structured `Logger`, a `JournalLogger` that mirrors log events into the
 * run journal, `Metric` helpers, the `Resource` descriptor, and the `Otel`
 * layer the OpenTelemetry SDK wiring installs behind.
 *
 * `NodeOtel` and `BrowserOtel` are deliberately NOT re-exported here. Each
 * resolves a host-specific OpenTelemetry SDK. `NodeOtel` reaches Node
 * built-ins through `@effect/opentelemetry/NodeSdk`, so re-exporting either
 * would put a `node:` import in the root entry and break the browser bundle
 * this package guarantees. Import them by subpath instead:
 * `@smthrs/observability/NodeOtel`.
 *
 * @since 0.1.0
 */

/**
 * @category layers
 * @since 0.1.0
 * @slop
 */
export * as Otlp from "./Otlp.ts"

/**
 * @category observability
 * @since 0.1.0
 * @slop
 */
export * as JournalLogger from "./JournalLogger.ts"

/**
 * @category observability
 * @since 0.1.0
 * @slop
 */
export * as Logger from "./Logger.ts"

/**
 * @category observability
 * @since 0.1.0
 * @slop
 */
export * as Metric from "./Metric.ts"

/**
 * @category observability
 * @since 0.1.0
 * @slop
 */
export * as Otel from "./Otel.ts"

/**
 * @category observability
 * @since 0.1.0
 * @slop
 */
export * as Resource from "./Resource.ts"
