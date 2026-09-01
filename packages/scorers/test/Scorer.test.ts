import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Scorer from "../src/Scorer.ts"
import { ScorerError } from "../src/ScorerError.ts"

const quality = (overrides: Partial<Scorer.MakeOptions> = {}) =>
  Scorer.make({
    id: "packages/scorers/test/Scorer/quality",
    version: "1",
    name: "quality",
    score: () => Effect.succeed({ score: 1 }),
    ...overrides
  })

const declarationFailure = (build: () => unknown): ScorerError => {
  try {
    build()
  } catch (error) {
    if (error instanceof ScorerError) return error
    throw error
  }
  throw new Error("expected a declaration failure")
}

describe("Scorer", () => {
  it("has an independent declaration key and validates scores", async () => {
    const scorer = quality()
    expect(scorer.scorerKey).toMatch(/^[0-9a-f]{64}$/)
    await expect(
      Effect.runPromise(Scorer.validate({ score: 2, reason: "bad" }))
    ).rejects.toMatchObject({ code: "invalid_score" })
  })

  it("uses explicit identity and canonical configuration, never closure source", () => {
    const make = (score: number, config: unknown) =>
      Scorer.make({
        id: "packages/scorers/test/Scorer/configured",
        version: "2",
        config,
        score: () => Effect.succeed({ score })
      })
    expect(make(0, { b: 2, a: 1 }).scorerKey).toBe(make(1, { a: 1, b: 2 }).scorerKey)
    expect(make(0, { a: 1 }).scorerKey).not.toBe(make(0, { a: 2 }).scorerKey)
  })

  it("freezes the scorer key for a fixed declaration", () => {
    // A canonicalization or hashing change orphans every observation already
    // stored under the old key, so it must fail here rather than silently
    // start a second identity for the same scorer.
    const scorer = Scorer.make({
      id: "packages/scorers/test/Scorer/frozen",
      version: "1",
      config: { rubric: "exact", threshold: 0.5 },
      score: () => Effect.succeed({ score: 1 })
    })
    expect(scorer.scorerKey).toBe("38fd2f0ee22ca194504029c045badc60f34eb53a6137384fc58581ce135875a0")
  })

  it.each([
    ["a function member", { rubric: () => 1 }, "config.rubric is function"],
    ["a symbol member", { rubric: Symbol("x") }, "config.rubric is symbol"],
    ["an undefined member", { rubric: undefined }, "config.rubric is undefined"],
    ["a bigint member", { rubric: 1n }, "config.rubric is bigint"],
    ["a non-finite member", { rubric: Number.POSITIVE_INFINITY }, "config.rubric is a non-finite number"],
    ["a nested lost member", { nested: { deep: [1, () => 1] } }, "config.nested.deep[1] is function"]
  ])("refuses a configuration carrying %s", (_name, config, expected) => {
    const failure = declarationFailure(() =>
      Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toContain(expected)
  })

  it("refuses a configuration with a symbol key or a cycle", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(
      declarationFailure(() =>
        Scorer.make({ id: "id", version: "1", config: cyclic, score: () => Effect.succeed({ score: 1 }) })
      ).message
    ).toContain("config.self is circular")
    expect(
      declarationFailure(() =>
        Scorer.make({
          id: "id",
          version: "1",
          config: { [Symbol("hidden")]: 1 },
          score: () => Effect.succeed({ score: 1 })
        })
      ).message
    ).toContain("has a symbol-keyed property")
  })

  it("refuses a configuration whose member throws when read", () => {
    const config = {
      get rubric(): unknown {
        throw new TypeError("no")
      }
    }
    expect(
      declarationFailure(() =>
        Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
      )
        .message
    ).toContain("config.rubric throws when read")
    const array = [1]
    Object.defineProperty(array, "0", {
      get: () => {
        throw new TypeError("no")
      }
    })
    expect(
      declarationFailure(() =>
        Scorer.make({ id: "id", version: "1", config: array, score: () => Effect.succeed({ score: 1 }) })
      ).message
    ).toContain("config[0] throws when read")
  })

  it.each([
    ["a Map", { index: new Map([["a", 1]]) }],
    ["a class instance", { at: new (class Marker {})() }]
  ])("normalizes the canonical refusal of %s", (_name, config) => {
    // `@smthrs/canonical` refuses these outright rather than collapsing them to
    // `{}`, so the walk lets them through and the catch has to convert the raw
    // SchemaError into this package's own failure.
    const failure = declarationFailure(() =>
      Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toBe("A scorer configuration could not be canonicalized")
  })

  it("normalizes a canonicalization failure the lossless walk cannot see", () => {
    // A `toJSON` is legitimate, so the walk stops at it; the failure it raises
    // must still arrive as a scorer error, not as a raw SchemaError.
    const config = {
      toJSON: () => {
        throw new TypeError("no")
      }
    }
    const failure = declarationFailure(() =>
      Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toBe("A scorer configuration could not be canonicalized")
    expect(failure.cause).toBeDefined()
  })

  it.each([
    ["a member defining toJSON", { at: new Date(0) }],
    ["a nested array of plain values", { weights: [1, 2, { a: null }] }],
    ["an explicit null", null]
  ])("accepts a configuration carrying %s", (_name, config) => {
    const scorer = Scorer.make({
      id: "id",
      version: "1",
      config,
      score: () => Effect.succeed({ score: 1 })
    })
    expect(scorer.scorerKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    ["id", { id: " ", version: "1" }, "A scorer id must not be empty"],
    ["version", { id: "id", version: "" }, "A scorer version must not be empty"]
  ])("names the blank %s", (_name, options, expected) => {
    const failure = declarationFailure(() => Scorer.make({ ...options, score: () => Effect.succeed({ score: 1 }) }))
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toBe(expected)
  })

  it("distinguishes an untrimmed id from its trimmed form", () => {
    expect(quality({ id: " padded " }).scorerKey).not.toBe(quality({ id: "padded" }).scorerKey)
  })

  it.each([0, 1, 0.5])("accepts the boundary score %s", async (score) => {
    await expect(Effect.runPromise(Scorer.validate({ score }))).resolves.toEqual({ score })
  })

  it.each([
    -0.0001,
    1.0001,
    Number.NaN,
    Number.POSITIVE_INFINITY
  ])("rejects the out-of-contract score %s and names it", async (score) => {
    const failure = await Effect.runPromise(Effect.flip(Scorer.validate({ score })))
    expect(failure.code).toBe("invalid_score")
    expect(failure.message).toContain(`received ${String(score)}`)
    expect(failure.cause).toBeDefined()
  })

  it("reports a result that carries no score at all", async () => {
    const failure = await Effect.runPromise(Effect.flip(Scorer.validate({ reason: "none" })))
    expect(failure.code).toBe("invalid_score")
    expect(failure.message).toBe("A scorer result must carry a finite score in [0, 1]")
  })

  it("survives a result whose score cannot be read", async () => {
    const hostile = new Proxy({}, {
      has: () => true,
      get: () => {
        throw new TypeError("no")
      }
    })
    const failure = await Effect.runPromise(Effect.flip(Scorer.validate(hostile)))
    expect(failure.code).toBe("invalid_score")
  })
})
