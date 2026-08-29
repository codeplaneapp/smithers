import { Effect } from "effect"
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
