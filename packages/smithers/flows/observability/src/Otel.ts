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
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  type Configuration as ResourceConfiguration,
  type InvalidResourceConfiguration,
  layer as resourceLayer,
  Resource
} from "./Resource.ts"

/**
 * Injected providers used by the provider-neutral OTEL layer.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** Validated resource for metrics, tracer scope, and provider factories. */
  readonly resource: ResourceConfiguration
  /** Existing providers retain their resource. Factories must pass the supplied resource to the SDK. */
  readonly tracerProvider?:
    | Api.TracerProvider
    | ((resource: typeof Resource.Service) => Api.TracerProvider)
    | undefined
  /** Existing providers retain their resource. Factories must pass the supplied resource to the SDK. */
  readonly loggerProvider?:
    | LoggerProvider
    | ((resource: typeof Resource.Service) => LoggerProvider)
    | undefined
  readonly metricReader?: MetricReader | ReadonlyArray<MetricReader> | undefined
  readonly loggerMergeWithExisting?: boolean | undefined
  readonly metricTemporality?: OtelMetrics.TemporalityPreference | undefined
}

/**
 * Composes Effect tracer, logger, and metric bridges from already-created
 * OpenTelemetry providers/readers or provider factories. Factories run during
 * layer acquisition after resource validation and receive the metric resource.
 * Already-created providers keep the resource captured at construction; the
 * resource option only sets metrics and tracer instrumentation scope for them.
 * Callers own provider flushing and shutdown, including factory-built providers.
 * No exporter is allocated by this module.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerOtel = (options: Options): Layer.Layer<never, InvalidResourceConfiguration> => {
  const resource = resourceLayer(options.resource)
  const tracerProvider = options.tracerProvider
  const loggerProvider = options.loggerProvider
  const tracer = tracerProvider === undefined
    ? Layer.empty
    : Layer.provide(
      OtelTracer.layer,
      Layer.effect(
        OtelTracer.OtelTracerProvider,
        Effect.map(
          Resource,
          (resource) => typeof tracerProvider === "function" ? tracerProvider(resource) : tracerProvider
        )
      )
    )
  const logger = loggerProvider === undefined
    ? Layer.empty
    : Layer.provide(
      OtelLogger.layer({ mergeWithExisting: options.loggerMergeWithExisting }),
      Layer.effect(
        OtelLogger.OtelLoggerProvider,
        Effect.map(
          Resource,
          (resource) => typeof loggerProvider === "function" ? loggerProvider(resource) : loggerProvider
        )
      )
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
 */
export const layerNoop: Layer.Layer<never> = Layer.empty
