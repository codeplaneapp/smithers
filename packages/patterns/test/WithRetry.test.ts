import { describe, it } from "@effect/vitest"
import { Effects, Flow, Graph, Node } from "@smthrs/core"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as WithRetry from "../src/WithRetry.ts"

const sealed = Effects.make({
  reads: [],
  writes: [],
  mode: "hermetic",
  onConflict: "serialize",
  tier: "sealed"
})

describe("WithRetry", () => {
  it("does not encode retries as success continuations", () => {
    const inner = Flow.make({
      name: "search",
      input: Schema.String,
      output: Schema.String,
      effects: sealed,
      body: () => Node.dynamic({ output: Schema.String })
    })
    const retried = WithRetry.withRetry(inner, { attempts: 3 })
    const graph = Graph.build(retried, "query")

    expect((retried as typeof inner).name).toBe("withRetry(search, attempts=3)")
    expect(Graph.nodes(graph).filter((node) => node.kind === "Dynamic")).toHaveLength(1)
    expect(Graph.nodes(graph).filter((node) => node.kind === "AndThen")).toHaveLength(1)
  })

  it("folds attempts into stable declaration identity", () => {
    const inner = Flow.make({
      name: "search",
      input: Schema.String,
      output: Schema.String,
      effects: sealed,
      body: () => Node.dynamic({ output: Schema.String })
    })
    const twice = WithRetry.withRetry(inner, { attempts: 2 }) as typeof inner
    const twiceAgain = WithRetry.withRetry(inner, { attempts: 2 }) as typeof inner
    const three = WithRetry.withRetry(inner, { attempts: 3 }) as typeof inner

    expect(twice.implementation).toEqual(twiceAgain.implementation)
    expect(twice.implementation).not.toEqual(three.implementation)
  })

  it("rejects invalid attempt bounds", () => {
    const inner = Flow.make({
      input: Schema.Void,
      output: Schema.Void,
      effects: sealed,
      body: () => Node.succeed(undefined)
    })

    expect(() => WithRetry.withRetry(inner, { attempts: 0 })).toThrow(PatternError)
    expect(() => WithRetry.withRetry(inner, { attempts: Number.POSITIVE_INFINITY })).toThrow(PatternError)
  })

  it.effect("retries typed failures and propagates fiber interruption", () =>
    Effect.gen(function*() {
      let attempts = 0
      const value = yield* WithRetry.retryEffect(
        Effect.suspend(() => {
          attempts++
          return attempts < 3 ? Effect.fail("retry") : Effect.succeed("ok")
        }),
        { attempts: 3 }
      )
      expect(value).toBe("ok")
      expect(attempts).toBe(3)

      const exit = yield* Effect.exit(
        WithRetry.retryEffect(Effect.failCause(Cause.interrupt()), { attempts: 4 })
      )
      expect(exit._tag).toBe("Failure")
      expect(attempts).toBe(3)
    }))
})
