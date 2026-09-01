import { describe, it } from "@effect/vitest"
import { Effects, Flow, Graph, Node } from "@smthrs/core"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
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

    expect(() => WithRetry.withRetry(inner, { attempts: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry attempts must be a positive safe integer, received 0"
      })
    )
    expect(() => WithRetry.withRetry(inner, { attempts: Number.POSITIVE_INFINITY })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry attempts must be a positive safe integer, received Infinity"
      })
    )
    expect(() => WithRetry.retryEffect(Effect.succeed("unused"), { attempts: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry attempts must be a positive safe integer, received 0"
      })
    )
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

  it("folds backoff and non-retryable tags into the name and identity", () => {
    const inner = Flow.make({
      name: "search",
      input: Schema.String,
      output: Schema.String,
      effects: sealed,
      body: () => Node.dynamic({ output: Schema.String })
    })
    const plain = WithRetry.withRetry(inner, { attempts: 4 }) as typeof inner
    const backoff = WithRetry.withRetry(inner, {
      attempts: 4,
      backoff: { initialMs: 100, factor: 2, maxMs: 250 }
    }) as typeof inner
    const slower = WithRetry.withRetry(inner, {
      attempts: 4,
      backoff: { initialMs: 100, factor: 3, maxMs: 250 }
    }) as typeof inner
    const guarded = WithRetry.withRetry(inner, { attempts: 4, nonRetryable: ["patterns/Fatal"] }) as typeof inner

    expect(backoff.name).toBe("withRetry(search, attempts=4, backoff=100x2<=250)")
    expect(guarded.name).toBe("withRetry(search, attempts=4, nonRetryable=patterns/Fatal)")
    expect(backoff.implementation).not.toEqual(plain.implementation)
    expect(backoff.implementation).not.toEqual(slower.implementation)
    expect(guarded.implementation).not.toEqual(plain.implementation)
  })

  it("names an unnamed inner flow anonymous", () => {
    const inner = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: () => Node.dynamic({ output: Schema.String })
    })

    const retried = WithRetry.withRetry(inner, { attempts: 2 }) as typeof inner

    expect(retried.name).toBe("withRetry(anonymous, attempts=2)")
  })

  it("rejects an invalid backoff", () => {
    const inner = Flow.make({
      input: Schema.Void,
      output: Schema.Void,
      effects: sealed,
      body: () => Node.succeed(undefined)
    })

    expect(() => WithRetry.withRetry(inner, { attempts: 2, backoff: { initialMs: 0, factor: 2, maxMs: 10 } }))
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry backoff initialMs must be a positive finite number, received 0"
      }))
    expect(() => WithRetry.withRetry(inner, { attempts: 2, backoff: { initialMs: 10, factor: 0.5, maxMs: 10 } }))
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry backoff factor must be at least 1, received 0.5"
      }))
    expect(() => WithRetry.withRetry(inner, { attempts: 2, backoff: { initialMs: 10, factor: 2, maxMs: 5 } }))
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry backoff maxMs must be at least initialMs, received 5"
      }))
    expect(() => WithRetry.withRetry(inner, { attempts: 2, backoff: { initialMs: Number.NaN, factor: 2, maxMs: 10 } }))
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry backoff initialMs must be a positive finite number, received NaN"
      }))
  })

  it.effect("returns a single-attempt effect without retrying it", () =>
    Effect.gen(function*() {
      let attempts = 0
      const value = yield* WithRetry.retryEffect(
        Effect.sync(() => {
          attempts += 1
          return "once"
        }),
        { attempts: 1 }
      )

      expect(value).toBe("once")
      expect(attempts).toBe(1)
    }))

  // The bound on `initialMs` is "positive and finite", not "at least one
  // millisecond": the ladder is a `Duration`, which carries sub-millisecond
  // waits, and a fast test schedule is a legitimate declaration.
  it("accepts a sub-millisecond initial delay and folds it into the name", () => {
    const inner = Flow.make({
      name: "search",
      input: Schema.String,
      output: Schema.String,
      effects: sealed,
      body: () => Node.dynamic({ output: Schema.String })
    })

    const fast = WithRetry.withRetry(inner, {
      attempts: 2,
      backoff: { initialMs: 0.5, factor: 2, maxMs: 10 }
    }) as typeof inner

    expect(fast.name).toBe("withRetry(search, attempts=2, backoff=0.5x2<=10)")
  })

  it("spaces attempts by a capped exponential backoff", () =>
    Effect.gen(function*() {
      let attempts = 0
      const fiber = yield* WithRetry.retryEffect(
        Effect.suspend(() => {
          attempts = attempts + 1
          return Effect.fail("retry")
        }),
        { attempts: 4, backoff: { initialMs: 100, factor: 2, maxMs: 250 } }
      ).pipe(Effect.forkChild({ startImmediately: true }))

      expect(attempts).toBe(1)
      yield* TestClock.adjust("99 millis")
      expect(attempts).toBe(1)
      yield* TestClock.adjust("1 millis")
      expect(attempts).toBe(2)
      yield* TestClock.adjust("199 millis")
      expect(attempts).toBe(2)
      yield* TestClock.adjust("1 millis")
      expect(attempts).toBe(3)
      yield* TestClock.adjust("249 millis")
      expect(attempts).toBe(3)
      yield* TestClock.adjust("1 millis")
      expect(attempts).toBe(4)

      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise))

  it.effect("attempts a non-retryable failure exactly once", () =>
    Effect.gen(function*() {
      let attempts = 0
      const exit = yield* Effect.exit(
        WithRetry.retryEffect(
          Effect.suspend(() => {
            attempts = attempts + 1
            return Effect.fail({ _tag: "patterns/Fatal" })
          }),
          { attempts: 4, nonRetryable: ["patterns/Fatal"] }
        )
      )

      expect(exit._tag).toBe("Failure")
      expect(attempts).toBe(1)
    }))

  it.effect("still retries a failure whose tag is not listed", () =>
    Effect.gen(function*() {
      let attempts = 0
      const value = yield* WithRetry.retryEffect(
        Effect.suspend(() => {
          attempts = attempts + 1
          return attempts < 3 ? Effect.fail({ _tag: "patterns/Transient" }) : Effect.succeed("ok")
        }),
        { attempts: 4, nonRetryable: ["patterns/Fatal"] }
      )

      expect(value).toBe("ok")
      expect(attempts).toBe(3)
    }))

  it.effect("still retries an untagged failure when non-retryable tags are configured", () =>
    Effect.gen(function*() {
      let attempts = 0
      const value = yield* WithRetry.retryEffect(
        Effect.suspend(() => {
          attempts += 1
          return attempts === 1 ? Effect.fail("transient") : Effect.succeed("ok")
        }),
        { attempts: 2, nonRetryable: ["patterns/Fatal"] }
      )

      expect(value).toBe("ok")
      expect(attempts).toBe(2)
    }))
})
