import { Cause, Effect, Layer, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Endpoint from "../src/Endpoint.ts"
import * as NodeOtel from "../src/NodeOtel.ts"
import * as Otlp from "../src/Otlp.ts"

const resource = { serviceName: "flows-test", serviceVersion: "1" } as const

const failureOf = async <A, E>(layer: Layer.Layer<A, E>) => {
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer)))
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Success") throw new Error("expected an endpoint refusal")
  const failure = Result.getOrUndefined(Cause.findError(exit.cause))
  expect(failure).toBeInstanceOf(Endpoint.InvalidExporterEndpoint)
  return failure as Endpoint.InvalidExporterEndpoint
}

describe("Endpoint", () => {
  /**
   * The exporter absorbs delivery failure by design, so a builder that accepts
   * a bad endpoint produces a layer indistinguishable from a working one. Both
   * public builders refuse the same set during acquisition instead.
   */
  it("refuses every endpoint that could never deliver, on both public builders", async () => {
    const rejected = [
      "",
      "  ",
      "collector.invalid:4318",
      "/v1/traces",
      "ftp://collector.invalid:4318",
      "file:///var/run/collector",
      "http://user:secret@collector.invalid:4318",
      "http://:secret@collector.invalid:4318",
      `http://collector.invalid/${"p".repeat(Endpoint.maximumEndpointLength)}`
    ]

    for (const endpoint of rejected) {
      const fromOtlp = await failureOf(Otlp.layerFetch({ baseUrl: endpoint }))
      expect(fromOtlp.code).toBe("invalid_exporter_endpoint")
      expect(fromOtlp.path).toBe("baseUrl")
      if (endpoint.trim() !== "") expect(fromOtlp.message).not.toContain(endpoint)

      const fromNode = await failureOf(NodeOtel.layerOtel({ endpoint, resource }))
      expect(fromNode.code).toBe("invalid_exporter_endpoint")
      expect(fromNode.path).toBe("endpoint")
    }
  })

  it("rejects a non-string endpoint without inspecting it as a URL", async () => {
    const failure = await failureOf(Otlp.layerFetch({ baseUrl: null as never }))
    expect(failure.path).toBe("baseUrl")
  })

  it("accepts an absolute collector URL and normalizes repeated trailing separators", () => {
    expect(Endpoint.normalize("http://collector.invalid:4318")).toBe("http://collector.invalid:4318")
    expect(Endpoint.normalize("http://collector.invalid:4318/")).toBe("http://collector.invalid:4318")
    expect(Endpoint.normalize("http://collector.invalid:4318//")).toBe("http://collector.invalid:4318")
    expect(Endpoint.normalize("https://collector.invalid/base/")).toBe("https://collector.invalid/base")
  })

  it("posts each signal below the decoded endpoint", () => {
    expect(
      (["traces", "metrics", "logs"] as const).map((signal) =>
        Endpoint.signalUrl("http://collector.invalid:4318//", signal)
      )
    ).toEqual([
      "http://collector.invalid:4318/v1/traces",
      "http://collector.invalid:4318/v1/metrics",
      "http://collector.invalid:4318/v1/logs"
    ])
    expect(Endpoint.signalUrl("https://collector.invalid/base", "traces")).toBe(
      "https://collector.invalid/base/v1/traces"
    )
  })

  it("decodes an acceptable endpoint into its normalized form", async () => {
    expect(await Effect.runPromise(Endpoint.decode("https://collector.invalid:4318//", "baseUrl"))).toBe(
      "https://collector.invalid:4318"
    )
  })
})
