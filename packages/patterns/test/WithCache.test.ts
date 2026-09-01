import { describe, expectTypeOf, it } from "@effect/vitest"
import { Digest, Effects, Flow, Graph, Node } from "@smthrs/core"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import type * as Context from "effect/Context"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as WithCache from "../src/WithCache.ts"

describe("WithCache", () => {
  it("rejects an unsealed inner flow", () => {
    const inner = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })

    try {
      WithCache.withCache(inner)
      throw new Error("expected withCache to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(PatternError)
      expect(error).toMatchObject({
        code: "invalid_decorator",
        message: "withCache requires an explicitly hermetic, sealed flow"
      })
    }
  })

  it("marks the wrapper sealed without emitting an unconsumed marker", () => {
    const inner = Flow.make({
      name: "read",
      input: Schema.String,
      output: Schema.String,
      effects: Effects.make({
        reads: ["workspace/**"],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize"
      }),
      body: () => Node.dynamic({ output: Schema.String })
    })
    const cached = WithCache.withCache(inner)
    const graph = Graph.build(cached, "file")
    expect((cached as typeof inner).name).toBe("withCache(read)")
    expect((cached as typeof inner).effects).toMatchObject({ mode: "hermetic", tier: "sealed" })
    expect(Graph.nodes(graph).some((node) => JSON.stringify(node.keyMaterial).includes("StepKeyCache"))).toBe(false)
    expect(Graph.nodes(graph).filter((node) => node.kind === "Dynamic")).toHaveLength(1)
  })

  it("accepts a declared policy alongside the inner flow", () => {
    expectTypeOf(WithCache.withCache).parameters.toEqualTypeOf<
      [inner: Flow.Any, options?: WithCache.Options | undefined]
    >()
  })
})

const sealedRead = () =>
  Flow.make({
    name: "read",
    input: Schema.String,
    output: Schema.String,
    effects: Effects.make({
      reads: ["workspace/**"],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize"
    }),
    body: () => Node.dynamic({ output: Schema.String })
  })

describe("WithCache policy", () => {
  it("names every declared field in the wrapper", () => {
    const cached = WithCache.withCache(sealedRead(), { ttlMs: 1000, scope: "run", version: "v2" })
    expect((cached as ReturnType<typeof sealedRead>).name).toBe("withCache(read, ttlMs=1000, scope=run, version=v2)")
  })

  it("names only the fields the caller declared", () => {
    const cached = WithCache.withCache(sealedRead(), { scope: "flow" })
    expect((cached as ReturnType<typeof sealedRead>).name).toBe("withCache(read, scope=flow)")
  })

  it("leaves an undeclared policy at the pre-policy declaration", () => {
    const cached = WithCache.withCache(sealedRead())
    expect((cached as ReturnType<typeof sealedRead>).name).toBe("withCache(read)")
    expect((cached as ReturnType<typeof sealedRead>).implementation).toEqual(
      (WithCache.withCache(sealedRead(), {}) as ReturnType<typeof sealedRead>).implementation
    )
  })

  it("folds the policy into declaration key material", () => {
    const inner = sealedRead()
    const oneSecond = WithCache.withCache(inner, { ttlMs: 1000 }) as typeof inner
    const oneSecondAgain = WithCache.withCache(inner, { ttlMs: 1000 }) as typeof inner
    const twoSeconds = WithCache.withCache(inner, { ttlMs: 2000 }) as typeof inner
    const runScoped = WithCache.withCache(inner, { ttlMs: 1000, scope: "run" }) as typeof inner
    const versioned = WithCache.withCache(inner, { ttlMs: 1000, version: "v2" }) as typeof inner

    expect(oneSecond.implementation).toEqual(oneSecondAgain.implementation)
    expect(oneSecond.implementation).not.toEqual(twoSeconds.implementation)
    expect(oneSecond.implementation).not.toEqual(runScoped.implementation)
    expect(oneSecond.implementation).not.toEqual(versioned.implementation)
  })

  it("refuses a time to live no clock reading satisfies", () => {
    for (const ttlMs of [0, -1, 1.5]) {
      expect(() => WithCache.withCache(sealedRead(), { ttlMs })).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: `withCache ttlMs must be a positive safe integer, received ${ttlMs}`
        })
      )
    }
  })

  it("refuses a blank version", () => {
    expect(() => WithCache.withCache(sealedRead(), { version: " " })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "withCache version must name a revision, not blank text"
      })
    )
  })

  it("refuses every non-cacheable effect envelope with its exact code", () => {
    const inner = (mode: "expected" | "hermetic", tier: "sealed" | "compensable") =>
      Flow.make({
        input: Schema.String,
        output: Schema.String,
        effects: Effects.make({ reads: [], writes: [], mode, onConflict: "serialize", tier }),
        body: (input) => Node.succeed(input)
      })

    for (const flow of [inner("expected", "sealed"), inner("hermetic", "compensable")]) {
      expect(() => WithCache.withCache(flow)).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: "withCache requires an explicitly hermetic, sealed flow"
        })
      )
    }
  })
})

/** The annotation bag a built flow carries; `Flow.Any` hides the field. */
const annotationsOf = (flow: Flow.Any): Context.Context<never> =>
  (flow as unknown as { readonly annotations: Context.Context<never> }).annotations

/** The canonical digest of everything `/keys` hashes for a built graph. */
const keyDigest = (flow: Flow.Any): string => {
  const material = Graph.keyMaterial(Graph.build(flow, "file"))
  if (Result.isFailure(material)) throw material.failure
  return Digest.canonical(material.success.map((entry) => entry.material))
}

describe("WithCache policy annotation", () => {
  it("annotates the wrapper with the policy the engine reads at dispatch", () => {
    const cached = WithCache.withCache(sealedRead(), { ttlMs: 1000, scope: "run", version: "v2" })
    // Read back through @smthrs/flow's reader, not this module's: the two keys
    // are declared separately and only their identifier makes them one, so a
    // drift in either identifier fails here rather than silently making every
    // declared policy inert at dispatch.
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(cached))).toEqual({ ttlMs: 1000, scope: "run" })
    expect(WithCache.policyOf(annotationsOf(cached))).toEqual({ ttlMs: 1000, scope: "run" })
  })

  it("carries only the durable fields, because version is identity and not an instruction", () => {
    const versionOnly = WithCache.withCache(sealedRead(), { version: "v2" })
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(versionOnly))).toBeUndefined()
    const ttlOnly = WithCache.withCache(sealedRead(), { ttlMs: 250 })
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(ttlOnly))).toEqual({ ttlMs: 250 })
  })

  it("annotates nothing when the caller declares no policy", () => {
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(WithCache.withCache(sealedRead())))).toBeUndefined()
  })

  it("keeps the annotation through the seal the combinator applies", () => {
    const decorated = WithCache.make({ scope: "flow" })(sealedRead())
    const sealed = WithCache.withCache(sealedRead(), { scope: "flow" })
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(decorated))).toEqual({ scope: "flow" })
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(sealed))).toEqual({ scope: "flow" })
  })

  it("gives two declarations differing only in version different key material", () => {
    const inner = sealedRead()
    const first = keyDigest(WithCache.withCache(inner, { version: "v1" }))
    const firstAgain = keyDigest(WithCache.withCache(inner, { version: "v1" }))
    const second = keyDigest(WithCache.withCache(inner, { version: "v2" }))
    // The digest is over what `/keys` hashes, so a step key derived from it
    // moves with the version and a row recorded under v1 is unreachable at v2.
    expect(first).toBe(firstAgain)
    expect(first).not.toBe(second)
  })
})
