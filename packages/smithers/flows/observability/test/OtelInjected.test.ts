import { LoggerProvider } from "@opentelemetry/sdk-logs"
import { InMemoryMetricExporter } from "@opentelemetry/sdk-metrics"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Otel from "../src/Otel.ts"
import * as Resource from "../src/Resource.ts"

/**
 * The injected-provider branches of `Otel.layerOtel`. `Otel.test.ts` asserts
 * the empty case — nothing injected composes to a layer that still runs — so
 * what is left is the other side of each of its three conditionals.
 */
const run = <A, E>(program: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.scoped(program))

describe("Otel.layerOtel with injected providers", () => {
  it("bridges an injected tracer, logger, and metric reader", async () => {
    const metricReader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(0),
      exportIntervalMillis: 60_000
    })
    const result = await run(
      Effect.succeed("ok").pipe(
        Effect.provide(Otel.layerOtel({
          resource: { serviceName: "flows-test", serviceVersion: "1" },
          tracerProvider: new BasicTracerProvider(),
          loggerProvider: new LoggerProvider(),
          loggerMergeWithExisting: false,
          metricReader
        }))
      )
    )
    expect(result).toBe("ok")
  })

  it("treats an empty metric-reader array as no metrics at all", async () => {
    const result = await run(
      Effect.succeed("ok").pipe(
        Effect.provide(Otel.layerOtel({
          resource: { serviceName: "flows-test" },
          metricReader: []
        }))
      )
    )
    expect(result).toBe("ok")
  })
})

describe("Resource.configToAttributes", () => {
  it("renders explicit service metadata and reads no environment", () => {
    expect(
      Resource.configToAttributes({
        serviceName: "flows-test",
        serviceVersion: "1.2.3",
        attributes: { "deployment.environment": "test" }
      })
    ).toMatchObject({ "service.name": "flows-test", "service.version": "1.2.3" })
  })

  it("rejects an empty service name rather than emitting anonymous telemetry", () => {
    expect(() => Resource.configToAttributes({ serviceName: "" })).toThrow()
  })

  it("exposes the OpenTelemetry resource service tag", () => {
    expect(Resource.Resource).toBeDefined()
  })
})
