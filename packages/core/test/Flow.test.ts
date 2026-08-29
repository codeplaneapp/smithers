import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

describe("Flow", () => {
  it("makes callable flow values whose calls build FlowCall nodes without running the body", () => {
    let bodyCalls = 0
    const flow = Flow.make({
      input: Schema.String,
      output: Schema.Number,
      body: () => {
        bodyCalls += 1
        return Node.succeed(1)
      }
    })

    const node = flow("input")

    expect(Flow.isFlow(flow)).toBe(true)
    expect(Node.isNode(node)).toBe(true)
    expect(node.ast).toMatchObject({
      _tag: "FlowCall",
      target: { _tag: "FlowReference" },
      input: "input"
    })
    expect(JSON.stringify(node.ast)).not.toContain("function")
    expect(bodyCalls).toBe(0)
  })

  it("installs a dynamic default body when model or flows are supplied", () => {
    const defaulted = Flow.make({ model: "smart" })
    const callable = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: Node.succeed
    })
    const withModel = Flow.make({
      output: Schema.String,
      model: "smart",
      prompt: "Answer exactly."
    })
    const withFlows = Flow.make({
      output: Schema.String,
      flows: [callable]
    })

    expect(withModel.body).toBeTypeOf("function")
    expect(withFlows.body).toBeTypeOf("function")
    expect(defaulted.input).toBe(Schema.Void)
    expect(defaulted.output).toBe(Schema.Unknown)
    expect(withModel.body?.(undefined).ast).toMatchObject({
      _tag: "Dynamic",
      model: "smart",
      output: Schema.String,
      prompt: "Answer exactly."
    })
    expect(withFlows.body?.(undefined).ast).toMatchObject({
      _tag: "Dynamic",
      flows: [callable],
      output: Schema.String
    })
  })

  it("forwards agent construction to make", () => {
    const config = {
      input: Schema.String,
      output: Schema.String,
      model: "smart",
      prompt: "Review."
    } as const
    const made = Flow.make(config)
    const agent = Flow.agent(config)

    expect(agent.input).toBe(made.input)
    expect(agent.output).toBe(made.output)
    expect(agent.capabilities).toEqual(made.capabilities)
    expect(agent.effects).toBe(made.effects)
    expect(agent.body?.("input").ast).toEqual(made.body?.("input").ast)
  })

  it("accepts unresolved markdown flow names through the same constructor", () => {
    const flow = Flow.make({
      output: Schema.String,
      model: "smart",
      flows: ["search"]
    })

    expect(flow.body?.(undefined).ast).toMatchObject({
      _tag: "Dynamic",
      flows: ["search"]
    })
  })

  it("returns fresh values from immutable combinators", () => {
    const declaration = Effects.make({
      reads: ["src"],
      writes: ["dist"],
      mode: "expected",
      onConflict: "serialize"
    })
    const replacement = Effects.make({
      reads: ["src"],
      writes: ["dist"],
      mode: "hermetic",
      onConflict: "fail"
    })
    const placement = Placement.sandbox({ profile: "test" })
    const original = Flow.make({
      capabilities: ["net"],
      effects: declaration,
      model: "smart"
    })

    const capable = Flow.withCapabilities(original, ["shell"])
    const placed = original.pipe(Flow.within(placement))
    const effected = Flow.withEffects(original, replacement)
    const sealedDirect = Flow.sealed(original)
    const sealedPiped = original.pipe(Flow.sealed())

    expect(capable).not.toBe(original)
    expect(placed).not.toBe(original)
    expect(effected).not.toBe(original)
    expect(sealedDirect).not.toBe(original)
    expect(sealedPiped).not.toBe(original)
    expect(original.capabilities).toEqual(["net"])
    expect(original.effects).toBe(declaration)
    expect(Option.isNone(Annotations.getOption(original.annotations, Annotations.Placement))).toBe(true)
    expect(capable.capabilities).toEqual(["net", "shell"])
    expect(Option.getOrUndefined(Annotations.getOption(placed.annotations, Annotations.Placement))).toEqual(placement)
    expect(effected.effects).toBe(replacement)
    expect(sealedDirect.effects).toEqual(Effects.sealed(declaration))
    expect(sealedPiped.effects).toEqual(Effects.sealed(declaration))
  })

  it("seals an empty effect envelope when no declaration exists", () => {
    const sealed = Flow.make({ model: "smart" }).pipe(Flow.sealed())

    expect(sealed.effects).toEqual(Effects.make({
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    }))
  })

  it("throws a typed missing_body error when a declaration-only flow is called", () => {
    const flow = Flow.make({ name: "declared" })

    expect(flow.body).toBeUndefined()
    expect(() => flow(undefined)).toThrow(Flow.FlowError)
    try {
      flow(undefined)
    } catch (error) {
      expect(error).toBeInstanceOf(Flow.FlowError)
      expect((error as Flow.FlowError).code).toBe("missing_body")
    }
  })

  it("accretes, deduplicates, and sorts capabilities", () => {
    const original = Flow.make({
      capabilities: ["write", "read", "write"],
      model: "smart"
    })
    const updated = original.pipe(Flow.withCapabilities(["admin", "read"]))

    expect(original.capabilities).toEqual(["write", "read", "write"])
    expect(updated.capabilities).toEqual(["admin", "read", "write"])
  })
})
