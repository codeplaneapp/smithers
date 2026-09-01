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

const bindInput = (expected: Schema.Top, actual: Schema.Top): Flow.Any =>
  Pattern.bind(
    Pattern.slot({ input: expected, output: Schema.Unknown }),
    Flow.make({
      input: actual,
      output: Schema.Unknown,
      body: (input) => Node.succeed(input)
    })
  )

describe("Pattern", () => {
  it("fails typed when a required slot has no binding", () => {
    const required = Pattern.slot({ input: Schema.String, output: Schema.String })

    try {
      Pattern.bind(required)
      throw new Error("expected Pattern.bind to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(PatternError)
      expect(error).toMatchObject({
        code: "missing_slot",
        message: "A required flow slot was not bound and has no default"
      })
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
    ).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The bound flow has an incompatible input schema: expected String, received Number"
      })
    )
  })

  it("refuses a slot default that violates its own schemas", () => {
    const incompatible = Flow.make({
      input: Schema.Number,
      output: Schema.Number,
      body: (input) => Node.succeed(input)
    })

    expect(() => Pattern.slot({ input: Schema.String, output: Schema.String, default: incompatible })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The slot default has an incompatible input schema: expected String, received Number"
      })
    )
  })

  it("reports a schema conversion failure separately from incompatibility", () => {
    const NonProjectable = Schema.String.pipe(
      Schema.check(
        Schema.makeFilter(() => true, {
          toJsonSchema: () => {
            throw new Error("no JSON Schema representation")
          }
        })
      )
    )
    const declaration = Pattern.slot({ input: Schema.String, output: Schema.String })
    const supplied = Flow.make({
      input: NonProjectable,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })

    expect(() => Pattern.bind(declaration, supplied)).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The bound flow input schemas cannot be compared because the actual input schema (String) has no JSON Schema form"
      })
    )

    expect(() =>
      Pattern.slot({
        input: NonProjectable,
        output: Schema.String,
        default: Flow.make({
          input: Schema.String,
          output: Schema.String,
          body: (input) => Node.succeed(input)
        })
      })
    ).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The slot default input schemas cannot be compared because the expected input schema (String) has no JSON Schema form"
      })
    )
  })

  it("names the first JSON Schema path when Struct field types differ", () => {
    const expected = Schema.Struct({ name: Schema.String, age: Schema.String })
    const actual = Schema.Struct({ name: Schema.String, age: Schema.Number })

    expect(() => bindInput(expected, actual)).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The bound flow has an incompatible input schema: both schemas are Objects and they first differ at schema.properties.age.anyOf"
      })
    )
  })

  it("names a Struct field present on only one side in either direction", () => {
    const narrow = Schema.Struct({ name: Schema.String })
    const wide = Schema.Struct({ name: Schema.String, extra: Schema.String })
    const refusal = {
      code: "invalid_decorator",
      message:
        "The bound flow has an incompatible input schema: both schemas are Objects and they first differ at schema.properties.extra"
    }

    expect(() => bindInput(narrow, wide)).toThrow(expect.objectContaining(refusal))
    expect(() => bindInput(wide, narrow)).toThrow(expect.objectContaining(refusal))
  })

  it("names ordered-array length and element differences", () => {
    const two = Schema.Union([Schema.Literal("a"), Schema.Literal("b")])
    const three = Schema.Union([Schema.Literal("a"), Schema.Literal("b"), Schema.Literal("c")])
    const changed = Schema.Union([Schema.Literal("a"), Schema.Literal("c")])

    expect(() => bindInput(two, three)).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The bound flow has an incompatible input schema: both schemas are Union and they first differ at schema.enum"
      })
    )
    expect(() => bindInput(two, changed)).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The bound flow has an incompatible input schema: both schemas are Union and they first differ at schema.enum[1]"
      })
    )
  })

  it("names a same-tag scalar leaf difference", () => {
    expect(() => bindInput(Schema.Literal("a"), Schema.Literal("b"))).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The bound flow has an incompatible input schema: both schemas are Literal and they first differ at schema.enum[0]"
      })
    )
  })

  it("accepts distinct schemas with identical JSON Schema documents", () => {
    const expected = Schema.Struct({ value: Schema.Null, name: Schema.String })
    const actual = Schema.Struct({ value: Schema.Null, name: Schema.String })

    expect(() => bindInput(expected, actual)).not.toThrow()
  })

  it("ignores object-key declaration order when schemas are otherwise identical", () => {
    const expected = Schema.Struct({
      alpha: Schema.optionalKey(Schema.String),
      beta: Schema.optionalKey(Schema.Number)
    })
    const actual = Schema.Struct({
      beta: Schema.optionalKey(Schema.Number),
      alpha: Schema.optionalKey(Schema.String)
    })

    expect(() => bindInput(expected, actual)).not.toThrow()
  })

  it("checks input contravariance and output covariance against an independent seeded oracle", () => {
    type Kind = "never" | "top" | "string" | "number"
    interface SchemaCase {
      readonly kind: Kind
      readonly schema: Schema.Top
    }
    const cases: ReadonlyArray<SchemaCase> = [
      { kind: "never", schema: Schema.Never },
      { kind: "top", schema: Schema.Unknown },
      { kind: "top", schema: Schema.Any },
      { kind: "string", schema: Schema.String },
      {
        kind: "string",
        schema: Schema.String.pipe(Schema.check(Schema.makeFilter(() => true)))
      },
      { kind: "number", schema: Schema.Number }
    ]
    const acceptedInputs: Readonly<Record<Kind, ReadonlyArray<Kind>>> = {
      never: ["never", "top", "string", "number"],
      top: ["top"],
      string: ["top", "string"],
      number: ["top", "number"]
    }
    const acceptedOutputs: Readonly<Record<Kind, ReadonlyArray<Kind>>> = {
      never: ["never"],
      top: ["never", "top", "string", "number"],
      string: ["never", "string"],
      number: ["never", "number"]
    }
    let seed = 0x5eedc0de
    const pick = (): SchemaCase => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return cases[seed % cases.length]!
    }
    const generated = Array.from({ length: 128 }, () => [pick(), pick()] as const)

    for (const [expected, actual] of generated) {
      const inputFlow = Flow.make({
        input: actual.schema,
        output: Schema.Unknown,
        body: (input) => Node.succeed(input)
      })
      const inputSlot = Pattern.slot({ input: expected.schema, output: Schema.Unknown })
      if (acceptedInputs[expected.kind].includes(actual.kind)) {
        expect(Pattern.bind(inputSlot, inputFlow)).toBe(inputFlow)
      } else {
        expect(() => Pattern.bind(inputSlot, inputFlow)).toThrow(
          expect.objectContaining({
            code: "invalid_decorator",
            message:
              `The bound flow has an incompatible input schema: expected ${expected.schema.ast._tag}, received ${actual.schema.ast._tag}`
          })
        )
      }

      const outputFlow = Flow.make({
        input: Schema.Never,
        output: actual.schema,
        body: (input) => Node.succeed(input)
      })
      const outputSlot = Pattern.slot({ input: Schema.Never, output: expected.schema })
      if (acceptedOutputs[expected.kind].includes(actual.kind)) {
        expect(Pattern.bind(outputSlot, outputFlow)).toBe(outputFlow)
      } else {
        expect(() => Pattern.bind(outputSlot, outputFlow)).toThrow(
          expect.objectContaining({
            code: "invalid_decorator",
            message:
              `The bound flow has an incompatible output schema: expected ${expected.schema.ast._tag}, received ${actual.schema.ast._tag}`
          })
        )
      }
    }
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
    expect(() => Pattern.decorate(template, () => supplied)).toThrow(
      expect.objectContaining({
        code: "envelope_conflict",
        message: "Decorator \"decorate(anonymous)\" widens the wrapped flow's declared effect envelope"
      })
    )
  })

  it("reports clipping when only the supplied declaration covers a path", () => {
    const template = Flow.make({
      input: Schema.String,
      output: Schema.String,
      effects: effect(["workspace/item"]),
      body: (input) => Node.succeed(input)
    })
    const supplied = Flow.make({
      input: Schema.String,
      output: Schema.String,
      effects: effect(["workspace/**"]),
      body: (input) => Node.succeed(input)
    })

    expect(Pattern.clipped(template, supplied).reads).toEqual(["workspace/**"])
  })

  it("reports every supplied effect when the template declares no envelope", () => {
    const template = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const supplied = Flow.make({
      input: Schema.String,
      output: Schema.String,
      effects: Effects.make({
        reads: ["workspace/item"],
        writes: ["workspace/out"],
        mode: "expected",
        onConflict: "serialize",
        tier: "compensable"
      }),
      body: (input) => Node.succeed(input)
    })

    expect(Pattern.clipped(template, supplied)).toMatchObject({
      reads: ["workspace/item"],
      writes: ["workspace/out"],
      mode: true,
      tier: true
    })
  })

  it("intersects omitted and narrowed tiers under both effect modes", () => {
    const flow = (declaration: Effects.Declaration) =>
      Flow.make({
        input: Schema.String,
        output: Schema.String,
        effects: declaration,
        body: (input) => Node.succeed(input)
      })
    const withoutTier = (reads: ReadonlyArray<string>, mode: "expected" | "hermetic") =>
      Effects.make({ reads, writes: [], mode, onConflict: "serialize" })
    const tiered = (
      reads: ReadonlyArray<string>,
      mode: "expected" | "hermetic",
      tier: "sealed" | "irreversible"
    ) => Effects.make({ reads, writes: [], mode, onConflict: "serialize", tier })

    expect(Pattern.clipped(
      flow(withoutTier(["workspace/allowed"], "hermetic")),
      flow(withoutTier(["workspace/outside"], "expected"))
    )).toMatchObject({ reads: ["workspace/outside"], mode: true, tier: false })
    expect(Pattern.clipped(
      flow(tiered(["workspace/allowed"], "expected", "irreversible")),
      flow(tiered(["workspace/outside"], "expected", "sealed"))
    )).toMatchObject({ reads: ["workspace/outside"], mode: false, tier: false })
    expect(Pattern.clipped(
      flow(tiered(["workspace/allowed"], "expected", "irreversible")),
      flow(tiered(["workspace/outside"], "hermetic", "sealed"))
    )).toMatchObject({ reads: ["workspace/outside"], mode: false, tier: false })
  })

  it("refuses decorators that return a non-flow or change either schema", () => {
    const template = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })

    expect(() => Pattern.decorate(template, () => "not-a-flow" as unknown as Flow.Any)).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "A flow decorator must return a Flow" })
    )
    expect(() =>
      Pattern.decorate(template, () =>
        Flow.make({
          input: Schema.Number,
          output: Schema.String,
          body: (input) => Node.succeed(String(input))
        }))
    ).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The flow decorator result has an incompatible input schema: expected String, received Number"
      })
    )
    expect(() =>
      Pattern.decorate(template, () =>
        Flow.make({
          input: Schema.String,
          output: Schema.Number,
          body: () => Node.succeed(1)
        }))
    ).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The flow decorator result has an incompatible output schema: expected String, received Number"
      })
    )
  })
})
