/**
 * Provider-neutral composition for injected OpenTelemetry providers.
 *
 * @since 0.1.0
 */
import * as OtelLogger from "@effect/opentelemetry/OtelLogger"
import * as OtelMetrics from "@effect/opentelemetry/OtelMetrics"
import * as OtelTracer from "@effect/opentelemetry/OtelTracer"
import type * as Api from "@opentelemetry/api"
import type { LoggerProvider } from "@opentelemetry/sdk-logs"
import type { MetricReader } from "@opentelemetry/sdk-metrics"
import * as Layer from "effect/Layer"
import {
  type Configuration as ResourceConfiguration,
  type InvalidResourceConfiguration,
  layer as resourceLayer
} from "./Resource.ts"

/**
 * Injected providers used by the provider-neutral OTEL layer.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly resource: ResourceConfiguration
  readonly tracerProvider?: Api.TracerProvider | undefined
  readonly loggerProvider?: LoggerProvider | undefined
  readonly metricReader?: MetricReader | ReadonlyArray<MetricReader> | undefined
  readonly loggerMergeWithExisting?: boolean | undefined
  readonly metricTemporality?: OtelMetrics.TemporalityPreference | undefined
}

/**
 * Composes Effect tracer, logger, and metric bridges from already-created
 * OpenTelemetry providers/readers. No exporter is allocated by this module.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerOtel = (options: Options): Layer.Layer<never, InvalidResourceConfiguration> => {
  const resource = resourceLayer(options.resource)
  const tracer = options.tracerProvider === undefined
    ? Layer.empty
    : Layer.provide(
      OtelTracer.layer,
      Layer.succeed(OtelTracer.OtelTracerProvider, options.tracerProvider)
    )
  const logger = options.loggerProvider === undefined
    ? Layer.empty
    : Layer.provide(
      OtelLogger.layer({ mergeWithExisting: options.loggerMergeWithExisting }),
      Layer.succeed(OtelLogger.OtelLoggerProvider, options.loggerProvider)
    )
  const metricReader = options.metricReader
  const metrics = metricReader === undefined || (Array.isArray(metricReader) && metricReader.length === 0)
    ? Layer.empty
    : OtelMetrics.layer(
      () => metricReader as unknown as MetricReader | readonly [MetricReader, ...Array<MetricReader>],
      {
        temporality: options.metricTemporality
      }
    )
  return Layer.mergeAll(tracer, logger, metrics).pipe(Layer.provideMerge(resource))
}

/**
 * A no-op OTEL layer for callers that want an explicit optional slot.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop: Layer.Layer<never> = Layer.empty
