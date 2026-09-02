/**
 * Node-only OTLP/HTTP OpenTelemetry setup.
 *
 * @since 0.1.0
 */
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Resource from "./Resource.ts"
import type { Configuration as ResourceConfiguration } from "./Resource.ts"

/**
 * Node OTLP/HTTP layer options.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly endpoint: string
  readonly resource: ResourceConfiguration
  readonly shutdownTimeout?: Duration.Input | undefined
  readonly exportIntervalMillis?: number | undefined
}

const endpointFor = (endpoint: string, signal: "traces" | "metrics" | "logs"): string =>
  `${endpoint.replace(/\/$/, "")}/v1/${signal}`

/**
 * Builds a scoped Node OTLP/HTTP layer for all three telemetry signals.
 * Exporter objects are created only when this layer is built.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerOtel = (options: Options): Layer.Layer<never, Resource.InvalidResourceConfiguration> =>
  Layer.unwrap(
    Effect.map(Resource.decode(options.resource), (decoded) =>
      NodeSdk.layer(() => {
        const resource = Resource.toOpenTelemetryConfiguration(decoded)
        const endpoint = options.endpoint
        const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url: endpointFor(endpoint, "traces") }))
        const logRecordProcessor = new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({ url: endpointFor(endpoint, "logs") })
        })
        const metricReader = options.exportIntervalMillis === undefined
          ? new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: endpointFor(endpoint, "metrics") })
          })
          : new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: endpointFor(endpoint, "metrics") }),
            exportIntervalMillis: options.exportIntervalMillis
          })
        return {
          resource,
          spanProcessor,
          logRecordProcessor,
          metricReader,
          shutdownTimeout: options.shutdownTimeout
        }
      }))
  )
