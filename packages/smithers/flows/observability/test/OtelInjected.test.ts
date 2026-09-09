import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { InMemoryMetricExporter } from "@opentelemetry/sdk-metrics"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Effect, Metric } from "effect"
import { describe, expect, it, vi } from "vitest"
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

  it("exports the configured resource on traces, logs, and metrics", async () => {
    const traceExporter = new InMemorySpanExporter()
    const logExporter = new InMemoryLogRecordExporter()
    const metricExporter = new InMemoryMetricExporter(1)
    let tracerProvider: BasicTracerProvider | undefined
    let loggerProvider: LoggerProvider | undefined
    const makeTracerProvider = vi.fn((resource: typeof Resource.Resource.Service) =>
      tracerProvider = new BasicTracerProvider({
        resource,
        spanProcessors: [new SimpleSpanProcessor(traceExporter)]
      })
    )
    const makeLoggerProvider = vi.fn((resource: typeof Resource.Resource.Service) =>
      loggerProvider = new LoggerProvider({
        resource,
        processors: [new SimpleLogRecordProcessor({ exporter: logExporter })]
      })
    )
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000
    })
    try {
      await run(
        Effect.gen(function*() {
          yield* Effect.void.pipe(Effect.withSpan("resource-test"))
          yield* Effect.logInfo("resource-test")
          yield* Metric.update(Metric.counter("resource-test"), 1)
        }).pipe(
          Effect.provide(Otel.layerOtel({
            resource: {
              serviceName: "requested-service",
              serviceVersion: "9.8.7",
              attributes: { region: "test-region" }
            },
            tracerProvider: makeTracerProvider,
            loggerProvider: makeLoggerProvider,
            metricReader,
            loggerMergeWithExisting: false
          })),
          Effect.provideService(Metric.MetricRegistry, new Map())
        )
      )
      expect(makeTracerProvider).toHaveBeenCalledTimes(1)
      expect(makeLoggerProvider).toHaveBeenCalledTimes(1)
      expect(makeTracerProvider.mock.calls[0]![0]).toBe(makeLoggerProvider.mock.calls[0]![0])
      await tracerProvider!.forceFlush()
      await loggerProvider!.forceFlush()
      const signals = [
        traceExporter.getFinishedSpans(),
        logExporter.getFinishedLogRecords(),
        metricExporter.getMetrics()
      ]
      for (const signal of signals) {
        expect(signal).toHaveLength(1)
        expect(signal[0]!.resource.attributes).toMatchObject({
          "service.name": "requested-service",
          "service.version": "9.8.7",
          region: "test-region"
        })
      }
    } finally {
      await tracerProvider?.shutdown()
      await loggerProvider?.shutdown()
    }
  })

  it("validates the resource before invoking provider factories", async () => {
    const tracerProvider = vi.fn(() => new BasicTracerProvider())
    const loggerProvider = vi.fn(() => new LoggerProvider())
    const layer = Otel.layerOtel({
      resource: { serviceName: "" },
      tracerProvider,
      loggerProvider
    })
    expect(tracerProvider).not.toHaveBeenCalled()
    expect(loggerProvider).not.toHaveBeenCalled()
    await expect(run(Effect.void.pipe(Effect.provide(layer)))).rejects.toBeInstanceOf(
      Resource.InvalidResourceConfiguration
    )
    expect(tracerProvider).not.toHaveBeenCalled()
    expect(loggerProvider).not.toHaveBeenCalled()
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
