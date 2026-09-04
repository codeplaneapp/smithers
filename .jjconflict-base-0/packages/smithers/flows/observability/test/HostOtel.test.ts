import { Effect, Metric } from "effect"
import { createServer, type Server } from "node:http"
import { describe, expect, it } from "vitest"
import * as BrowserOtel from "../src/BrowserOtel.ts"
import * as NodeOtel from "../src/NodeOtel.ts"

/**
 * The host-specific SDK wiring, exercised through the one thing it promises:
 * building the layer constructs the exporters, and closing the scope shuts
 * them down. Nothing here networks — the OTLP exporters buffer until their
 * batch interval, and the scope closes first.
 *
 * These layers are reached by subpath (`@smthrs/observability/NodeOtel`)
 * rather than from the root entry, which stays free of `node:` imports so the
 * package keeps bundling for the browser.
 */
describe("NodeOtel.layerOtel", () => {
  it("builds and releases the three-signal layer", async () => {
    const result = await Effect.runPromise(
      Effect.succeed("ok").pipe(
        Effect.provide(NodeOtel.layerOtel({
          endpoint: "http://localhost:4318/",
          resource: { serviceName: "flows-test", serviceVersion: "1" }
        })),
        Effect.scoped
      )
    )
    expect(result).toBe("ok")
  })

  it("honours an explicit metric export interval", async () => {
    const result = await Effect.runPromise(
      Effect.succeed("ok").pipe(
        Effect.provide(NodeOtel.layerOtel({
          endpoint: "http://localhost:4318",
          resource: { serviceName: "flows-test" },
          exportIntervalMillis: 60_000,
          shutdownTimeout: "10 millis"
        })),
        Effect.scoped
      )
    )
    expect(result).toBe("ok")
  })

  /**
   * The one piece of logic this module owns is which signal goes to which
   * OTLP path, and asserting `Endpoint.signalUrl` alone leaves the wiring
   * unverified: permuting the `"traces"`, `"metrics"`, and `"logs"` literals
   * sends every record to a collector path that rejects it while the layer
   * still builds, releases, and reports success. So this drives a real
   * collector and reads back which payload arrived where. The OTLP/HTTP JSON
   * body names its own signal (`resourceSpans`, `resourceMetrics`,
   * `resourceLogs`), which is what makes a swap visible rather than just the
   * set of paths, which a swap preserves.
   */
  it("posts each signal to its own path on a real collector", async () => {
    const received: Array<{ readonly path: string; readonly keys: ReadonlyArray<string> }> = []
    const server: Server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        received.push({
          path: request.url ?? "",
          keys: Object.keys(body as Record<string, unknown>)
        })
        response.writeHead(200, { "content-type": "application/json" })
        response.end("{}")
      })
    })

    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          if (address === null || typeof address === "string") reject(new Error("no ephemeral port"))
          else resolve(address.port)
        })
      })

      const counter = Metric.counter("flows-test/host-otel/records")
      await Effect.runPromise(
        Effect.gen(function*() {
          yield* Effect.void.pipe(Effect.withSpan("host-otel-span"))
          yield* Effect.logInfo("host otel record")
          yield* Metric.update(counter, 1)
        }).pipe(
          Effect.provide(NodeOtel.layerOtel({
            endpoint: `http://127.0.0.1:${port}`,
            resource: { serviceName: "flows-test", serviceVersion: "1" },
            // Release, not the interval, is the deterministic flush: closing
            // the scope force-flushes both batch processors and collects the
            // metric reader once.
            exportIntervalMillis: 60_000,
            shutdownTimeout: "10 seconds"
          })),
          Effect.scoped
        )
      )

      for (let attempt = 0; attempt < 200 && received.length < 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      const bySignal = new Map(received.map((request) => [request.keys.join(","), request.path]))
      expect(Object.fromEntries(bySignal)).toEqual({
        resourceSpans: "/v1/traces",
        resourceMetrics: "/v1/metrics",
        resourceLogs: "/v1/logs"
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe("BrowserOtel.layerOtel", () => {
  it("builds and releases a layer with no caller-supplied processors", async () => {
    const result = await Effect.runPromise(
      Effect.succeed("ok").pipe(
        Effect.provide(BrowserOtel.layerOtel({
          resource: { serviceName: "flows-test", serviceVersion: "1" }
        })),
        Effect.scoped
      )
    )
    expect(result).toBe("ok")
  })
})
