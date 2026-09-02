import { Cause, Effect, Layer, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as BrowserOtel from "../src/BrowserOtel.ts"
import * as NodeOtel from "../src/NodeOtel.ts"
import * as Otel from "../src/Otel.ts"
import * as Otlp from "../src/Otlp.ts"
import * as Resource from "../src/Resource.ts"

const failureOf = async <A>(layer: Layer.Layer<A, Resource.InvalidResourceConfiguration>) => {
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer)))
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Success") throw new Error("expected resource refusal")
  const failure = Result.getOrUndefined(Cause.findError(exit.cause))
  expect(failure).toBeInstanceOf(Resource.InvalidResourceConfiguration)
  return failure as Resource.InvalidResourceConfiguration
}

const layersFor = (resource: unknown) => {
  const configuration = resource as {
    readonly serviceName?: string
    readonly serviceVersion?: string
    readonly attributes?: Record<string, unknown>
  }
  return [
    Resource.layer(resource as never),
    Otel.layerOtel({ resource: resource as never }),
    BrowserOtel.layerOtel({ resource: resource as never }),
    NodeOtel.layerOtel({ endpoint: "http://127.0.0.1:4318", resource: resource as never }),
    Otlp.layerFetch({
      baseUrl: "http://127.0.0.1:4318",
      ...(configuration.serviceName === undefined ? {} : { serviceName: configuration.serviceName }),
      ...(configuration.serviceVersion === undefined ? {} : { serviceVersion: configuration.serviceVersion }),
      ...(configuration.attributes === undefined ? {} : { attributes: configuration.attributes })
    })
  ] as const
}

describe("Resource configuration", () => {
  it("gives every public layer the same rejection and offending path", async () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: Resource.maximumAttributes + 1 }, (_, index) => [`key-${index}`, index])
    )
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["serviceName", { serviceName: "" }],
      ["serviceName", { serviceName: "\ud800" }],
      ["serviceVersion", { serviceName: "service", serviceVersion: `v${String.fromCharCode(0)}1` }],
      ["attributes.bad", { serviceName: "service", attributes: { bad: {} } }],
      ["attributes.bad", { serviceName: "service", attributes: { bad: Number.NaN } }],
      ["attributes.bad", { serviceName: "service", attributes: { bad: ["one", 2] } }],
      ["attributes", { serviceName: "service", attributes: tooMany }]
    ]

    for (const [path, configuration] of cases) {
      for (const layer of layersFor(configuration)) {
        const failure = await failureOf(layer)
        expect(failure.code).toBe("invalid_resource_configuration")
        expect(failure.path).toContain(path)
        expect(failure.message).not.toContain(JSON.stringify(configuration))
      }
      expect(() => Resource.configToAttributes(configuration as never)).toThrow(
        Resource.InvalidResourceConfiguration
      )
    }
  })

  it("accepts well-formed astral text and every supported attribute shape", async () => {
    const configuration = {
      serviceName: "service-😀",
      serviceVersion: "v1",
      attributes: {
        text: "hello-😀",
        number: 42,
        enabled: true,
        texts: ["a", "b"],
        numbers: [1, 2],
        booleans: [true, false]
      }
    } as const
    for (const layer of layersFor(configuration)) {
      const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer)))
      expect(exit._tag).toBe("Success")
    }
    expect(Resource.configToAttributes(configuration)).toMatchObject({
      "service.name": "service-😀",
      "service.version": "v1",
      text: "hello-😀"
    })
  })

  it("accepts exact resource ceilings and rejects the next value", async () => {
    const exact = {
      serviceName: "s".repeat(Resource.maximumIdentityLength),
      attributes: {
        ["k".repeat(Resource.maximumAttributeKeyLength)]: "v".repeat(Resource.maximumAttributeStringLength)
      }
    }
    expect(await Effect.runPromise(Resource.decode(exact))).toMatchObject({ serviceName: exact.serviceName })

    for (
      const candidate of [
        { ...exact, serviceName: `${exact.serviceName}x` },
        { serviceName: "s", attributes: { [`${Object.keys(exact.attributes)[0]}x`]: "v" } },
        { serviceName: "s", attributes: { key: `${Object.values(exact.attributes)[0]}x` } }
      ]
    ) {
      const exit = await Effect.runPromiseExit(Resource.decode(candidate))
      expect(exit._tag).toBe("Failure")
    }
  })

  it("omits absent optional fields in the SDK projection", () => {
    expect(Resource.toOpenTelemetryConfiguration({ serviceName: "service" })).toEqual({
      serviceName: "service"
    })
  })

  it("attributes a top-level malformed configuration without retaining it", async () => {
    const exit = await Effect.runPromiseExit(Resource.decode(null))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Result.getOrUndefined(Cause.findError(exit.cause))
      expect(failure).toMatchObject({
        code: "invalid_resource_configuration",
        path: "resource",
        message: "OpenTelemetry resource resource is invalid"
      })
    }
  })
})
