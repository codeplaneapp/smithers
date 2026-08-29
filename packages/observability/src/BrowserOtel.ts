/**
 * Browser OpenTelemetry setup with explicitly injected providers/readers.
 *
 * @since 0.1.0
 */
import * as WebSdk from "@effect/opentelemetry/WebSdk"
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs"
import type { MetricReader } from "@opentelemetry/sdk-metrics"
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base"
import type * as Layer from "effect/Layer"
import type { Configuration as ResourceConfiguration } from "./Resource.ts"

/**
 * Browser OTEL layer options. Processors and readers are created by the caller,
 * which keeps this module free of Node imports and browser exporter policy.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly resource: ResourceConfiguration
  readonly spanProcessor?: SpanProcessor | ReadonlyArray<SpanProcessor> | undefined
  readonly logRecordProcessor?: LogRecordProcessor | ReadonlyArray<LogRecordProcessor> | undefined
  readonly metricReader?: MetricReader | ReadonlyArray<MetricReader> | undefined
  readonly loggerMergeWithExisting?: boolean | undefined
}

/**
 * Builds a scoped browser OpenTelemetry layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerOtel = (options: Options): Layer.Layer<never> =>
  WebSdk.layer(() => ({
    resource: options.resource,
    spanProcessor: options.spanProcessor,
    logRecordProcessor: options.logRecordProcessor,
    metricReader: options.metricReader,
    loggerMergeWithExisting: options.loggerMergeWithExisting
  }))
