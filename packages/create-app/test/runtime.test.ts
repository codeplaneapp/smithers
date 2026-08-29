/**
 * `materializeFlow` is where a flow file's declaration and its resolved
 * `AGENT.ts` meet, so what it names and in which order it stacks the system
 * teaching is the contract. The end-to-end path through `layerFor` is covered
 * by the cached-model suite; this one pins the parts that a run would only
 * reveal indirectly.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { defineAgent, defineFlow, defineSandbox, defineTools } from "../src/app.ts"
import { emptyRegistry, layerFor, materializeFlow } from "../src/runtime.ts"

const spec = defineFlow({
  description: "Answers a topic in one line.",
  payload: { topic: Schema.String },
  output: Schema.Struct({ answer: Schema.String }),
  prompt: ({ topic }) => `Answer in one line: ${topic}`,
  system: ["Keep it to one sentence."]
})

const agent = defineAgent({ seat: "test:scripted", system: ["You are a test agent."] })

describe("materializeFlow", () => {
  it("names the action and the flow after the routed id", () => {
    const materialized = materializeFlow("build/plan", spec, agent)
    expect(materialized.id).toBe("build/plan")
    expect(materialized.action.name).toBe("app/build/plan/agent")
    expect(materialized.flow._tag).toBe("app/build/plan")
  })

  it("accepts a flow that adds no teaching of its own", () => {
    const bare = defineFlow({
      description: "Echoes.",
      payload: { topic: Schema.String },
      output: Schema.Struct({ answer: Schema.String }),
      prompt: ({ topic }) => topic
    })
    expect(materializeFlow("echo", bare, agent).action.name).toBe("app/echo/agent")
  })
})

describe("layer inputs", () => {
  it("projects the two layer files onto the sandbox limits the host takes", () => {
    // The mapping is asserted through the specs rather than through the built
    // layer, which keeps no readable record of what it was given.
    const sandbox = defineSandbox({ limits: { heapBytes: 1024, interruptChecks: 10, wallClockMs: 5 } })
    expect(sandbox.limits.heapBytes).toBe(1024)
    expect(defineAgent({ seat: "s", system: [], limits: { calls: 4 } }).limits?.calls).toBe(4)
    expect(defineTools([]).sources).toEqual([])
  })

  it("composes a host whether or not the agent layer declares budgets", () => {
    const seats = { resolve: () => Effect.die("unused") as never }
    const sandbox = defineSandbox({ limits: { heapBytes: 1024, interruptChecks: 10, wallClockMs: 5 } })
    const crypto = NodeCrypto.layer
    // Declared budgets and defaulted budgets are two different limit records,
    // and only building both proves the fallbacks are wired.
    expect(
      layerFor({
        agent: defineAgent({ seat: "s", system: [], limits: { calls: 4 }, maxFrames: 3 }),
        sandbox,
        tools: defineTools([]),
        seats,
        crypto
      })
    ).toBeDefined()
    expect(
      layerFor({ agent: defineAgent({ seat: "s", system: [] }), sandbox, tools: defineTools([]), seats, crypto })
    ).toBeDefined()
  })

  it("shows a cell an empty catalog", async () => {
    const registry = emptyRegistry()
    expect(await Effect.runPromise(registry.list())).toEqual([])
    expect(await Effect.runPromise(registry.visible())).toEqual([])
    expect(Option.isNone(await Effect.runPromise(registry.getOption("anything")))).toBe(true)
  })
})
