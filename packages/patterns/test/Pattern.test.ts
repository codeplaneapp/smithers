import { describe, it } from "@effect/vitest"
import { Effects, Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Pattern from "../src/Pattern.ts"
import { PatternError } from "../src/PatternError.ts"

const effect = (
  reads: ReadonlyArray<string>,
  writes: ReadonlyArray<string> = []
): Effects.Declaration =>
  Effects.make({
    reads,
    writes,
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  })

const details = (flow: Flow.Any) =>
  flow as Flow.Any & {
    readonly name?: string | undefined
    readonly capabilities: ReadonlyArray<string>
    readonly effects: Effects.Declaration | undefined
  }

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

describe("Pattern", () => {
  it("fails typed when a required slot has no binding", () => {
    const required = Pattern.slot({ input: Schema.String, output: Schema.String })

    try {
      Pattern.bind(required)
      throw new Error("expected Pattern.bind to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(PatternError)
      expect(error).toMatchObject({ code: "missing_slot" })
    }
  })

  it("uses a compatible default and rejects incompatible bindings", () => {
    const fallback = Flow.make({
      name: "fallback",
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const declaration = Pattern.slot({
      input: Schema.String,
      output: Schema.String,
      default: fallback
    })

    expect(Pattern.bind(declaration)).toBe(fallback)
    expect(() =>
      Pattern.bind(
        declaration,
        Flow.make({
          input: Schema.Number,
          output: Schema.String,
          body: (input) => Node.succeed(String(input))
        })
      )
    ).toThrow(PatternError)
  })

  it("derives decorator-chain names and clips capabilities at every layer", () => {
    const search = Flow.make({
      name: "search",
      input: Schema.String,
      output: Schema.String,
      capabilities: ["fs:read", "net:get"],
      effects: effect(["workspace/**"]),
      body: (input) => Node.succeed(input)
    })
    const withAudit: Pattern.Decorator = (inner) =>
      Flow.make({
        name: `withAudit(${details(inner).name})`,
        input: inner.input,
        output: inner.output,
        capabilities: ["fs:read", "audit:write"],
        effects: effect(["workspace/file"]),
        body: (input) => call(inner, input)
      })
    const withTrace: Pattern.Decorator = (inner) =>
      Flow.make({
        name: `withTrace(${details(inner).name})`,
        input: inner.input,
        output: inner.output,
        capabilities: ["fs:read", "trace:write"],
        effects: effect(["workspace/file"]),
        body: (input) => call(inner, input)
      })

    const decorated = Pattern.decorateAll(search, [withAudit, withTrace])

    expect(details(decorated).name).toBe("withTrace(withAudit(search))")
    expect(details(decorated).capabilities).toEqual(["fs:read"])
    expect(details(decorated).effects?.reads).toEqual(["workspace/file"])
  })

  it("reports clipping and refuses to launder a wider effect envelope", () => {
    const template = Flow.make({
      input: Schema.String,
      output: Schema.String,
      capabilities: ["fs:read"],
      effects: effect(["workspace/**"]),
      body: (input) => Node.succeed(input)
    })
    const supplied = Flow.make({
      input: Schema.String,
      output: Schema.String,
      capabilities: ["fs:read", "net:admin"],
      effects: Effects.make({
        reads: ["workspace/item", "secret/item"],
        writes: ["secret/item"],
        mode: "expected",
        onConflict: "fail",
        tier: "irreversible"
      }),
      body: (input) => Node.succeed(input)
    })
    const report = Pattern.clipped(template, supplied)

    expect(report).toEqual({
      capabilities: ["net:admin"],
      reads: ["secret/item"],
      writes: ["secret/item"],
      mode: true,
      tier: true
    })
    expect(() => Pattern.decorate(template, () => supplied)).toThrow(PatternError)
  })
})
