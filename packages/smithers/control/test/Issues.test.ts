/**
 * The bounded diagnostics every control failure crosses the wire with.
 *
 * `internal/issues.ts` exists so a rejected value never travels with the error
 * that rejected it: an `InvalidInput` or `PersistenceError` reaches an operator
 * over RPC and onto CLI stderr, and a token or a multi-megabyte payload copied
 * into `issue` would reach them too. Every case here therefore asserts two
 * things at once, a location a reader can act on and the absence of the value
 * that produced it.
 *
 * The walk is also a resource bound. A schema error is a tree a caller
 * influences, so the depth cap is what keeps a pathological one from turning
 * error rendering into the denial of service the error was reporting.
 */
import { CanonicalError } from "@smthrs/canonical"
import { Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { canonicalIssue, cappedIssue, schemaIssuePath } from "../src/internal/issues.ts"

/** The `Schema.SchemaError` a decode produced, for the walk to render. */
const errorOf = async <S extends Schema.Top>(schema: S, input: unknown): Promise<Schema.SchemaError> => {
  const result = await Effect.runPromise(
    Effect.result(Schema.decodeUnknownEffect(schema)(input) as Effect.Effect<unknown, Schema.SchemaError>)
  )
  if (Result.isSuccess(result)) throw new Error("the probe schema accepted its input")
  return result.failure
}

const encodeErrorOf = async <S extends Schema.Top>(schema: S, input: unknown): Promise<Schema.SchemaError> => {
  const result = await Effect.runPromise(
    Effect.result(Schema.encodeUnknownEffect(schema)(input) as Effect.Effect<unknown, Schema.SchemaError>)
  )
  if (Result.isSuccess(result)) throw new Error("the probe schema accepted its input")
  return result.failure
}

describe("cappedIssue", () => {
  it("joins a location and a reason", () => {
    expect(cappedIssue("$.input.token", "must be a string")).toBe("$.input.token: must be a string")
  })

  it("truncates a long reason to a bounded, elided sentence", () => {
    const issue = cappedIssue("$", "x".repeat(4096))
    expect(issue.length).toBe(512)
    expect(issue.endsWith("...")).toBe(true)
  })
})

describe("canonicalIssue", () => {
  it("keeps canonical's own path and stable code", () => {
    const issue = canonicalIssue(
      new CanonicalError("canonical_unsupported_value", "a Date is not JSON", "$.input.when")
    )
    expect(issue).toBe("$.input.when: canonical_unsupported_value")
    // The detail sentence is canonical's, and it is the half that can quote a
    // value, so it stays out of the error that travels.
    expect(issue).not.toContain("a Date is not JSON")
  })

  it("says only that canonicalization failed when the cause is a stranger", () => {
    // A stranger carries no path this package can trust, and its message may
    // quote the value: neither reaches the wire.
    expect(canonicalIssue(new Error("secret-token-abc123 could not be serialized"))).toBe(
      "$: canonicalization failed"
    )
    expect(canonicalIssue(undefined)).toBe("$: canonicalization failed")
  })
})

describe("schemaIssuePath", () => {
  it("names the rejected object field and not its value", async () => {
    const error = await errorOf(Schema.Struct({ token: Schema.Number }), { token: "sk-live-secret" })
    const path = schemaIssuePath(error)
    expect(path).toBe("$.token")
    expect(path).not.toContain("sk-live-secret")
  })

  it("indexes a rejected array element", async () => {
    const error = await errorOf(Schema.Array(Schema.String), [42])
    expect(schemaIssuePath(error)).toBe("$[0]")
  })

  it("walks through a failed refinement to the value it refined", async () => {
    const error = await errorOf(
      Schema.Struct({ limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
      { limit: 0 }
    )
    expect(schemaIssuePath(error)).toBe("$.limit")
  })

  it("walks through a failed transformation", async () => {
    const error = await errorOf(Schema.Struct({ card: Schema.fromJsonString(Schema.String) }), { card: "{" })
    expect(schemaIssuePath(error)).toBe("$.card")
  })

  it("walks through a failed encoding", async () => {
    const error = await encodeErrorOf(Schema.Struct({ size: Schema.FiniteFromString }), { size: Number.NaN })
    expect(schemaIssuePath(error)).toBe("$.size")
  })

  it("reports the enclosing location when a union rejects without naming a member", async () => {
    const error = await errorOf(Schema.Struct({ id: Schema.Union([Schema.String, Schema.Number]) }), { id: true })
    expect(schemaIssuePath(error)).toBe("$.id")
  })

  it("stops walking a pathologically deep error instead of following it down", async () => {
    let schema: Schema.Top = Schema.String
    let value: unknown = 1
    for (let depth = 0; depth < 70; depth++) {
      schema = Schema.Struct({ a: schema as Schema.Codec<unknown> })
      value = { a: value }
    }
    const path = await errorOf(schema, value).then(schemaIssuePath)
    // The walk spends one iteration per composite and one per pointer, so its
    // 64-iteration budget renders 32 segments of a 70-deep error and stops.
    expect(path).toBe(`$${".a".repeat(32)}`)
  })
})
