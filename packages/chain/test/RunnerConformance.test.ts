import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as Author from "../src/Author.ts"
import * as Catalog from "../src/Catalog.ts"
import type * as Outcome from "../src/Outcome.ts"
import * as QuickJsRunner from "../src/QuickJsRunner.ts"
import * as Script from "../src/Script.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"
import { flow, runChain } from "./harness.ts"

const runners: ReadonlyArray<
  readonly [string, Layer.Layer<ScriptRunner.ScriptRunner, ScriptRunner.ScriptFailure>]
> = [
  ["in-process", ScriptRunner.layerInProcess],
  ["quickjs", QuickJsRunner.layer()]
]

const runWith = <E>(
  layer: Layer.Layer<ScriptRunner.ScriptRunner, ScriptRunner.ScriptFailure>,
  text: string,
  handler: (request: ScriptRunner.Request) => Effect.Effect<unknown, E>
): Promise<Outcome.Outcome> =>
  Effect.runPromise(
    Effect.flatMap(ScriptRunner.ScriptRunner, (runner) => runner.run(Script.make(text), handler)).pipe(
      Effect.provide(layer)
    ) as Effect.Effect<Outcome.Outcome, never, never>
  )

const failWith = <E>(
  layer: Layer.Layer<ScriptRunner.ScriptRunner, ScriptRunner.ScriptFailure>,
  text: string,
  handler: (request: ScriptRunner.Request) => Effect.Effect<unknown, E>
): Promise<unknown> =>
  Effect.runPromise(
    Effect.flip(
      Effect.flatMap(ScriptRunner.ScriptRunner, (runner) => runner.run(Script.make(text), handler))
    ).pipe(Effect.provide(layer)) as Effect.Effect<unknown, never, never>
  )

const echo = (request: ScriptRunner.Request): Effect.Effect<unknown> =>
  Effect.succeed({ name: request.name, payload: request.payload })

describe.each(runners)("runner conformance: %s", (_name, layer) => {
  it("settles calls one at a time, in issue order", async () => {
    const outcome = await runWith(
      layer,
      [
        `const [a, b] = await Promise.all([ctx.call("first"), ctx.call("second", 2)])`,
        `const c = await ctx.call("third", { deep: true })`,
        `return done([a, b, c])`
      ].join("\n"),
      echo
    )
    expect(outcome).toEqual({
      _tag: "Done",
      value: [
        { name: "first", payload: null },
        { name: "second", payload: 2 },
        { name: "third", payload: { deep: true } }
      ]
    })
  })

  it("returns to and park outcomes, park defaulting its message", async () => {
    const to = await runWith(layer, `return to({ text: "next", digest: "d" })`, echo)
    expect(to).toEqual({ _tag: "To", script: { digest: "d", text: "next" } })
    const park = await runWith(layer, `return park("timer")`, echo)
    expect(park).toEqual({ _tag: "Park", reason: { code: "timer", message: "" } })
  })

  it("settles race losers durably", async () => {
    const seen: Array<string> = []
    const handler = (request: ScriptRunner.Request) => {
      seen.push(request.name)
      return echo(request)
    }
    const outcome = await runWith(
      layer,
      `const winner = await Promise.race([ctx.call("a"), ctx.call("b")])\nreturn done(winner)`,
      handler
    )
    expect(outcome).toEqual({ _tag: "Done", value: { name: "a", payload: null } })
    expect(seen).toEqual(["a", "b"])
  })

  it("fails on a script that throws", async () => {
    const error = await failWith(layer, `throw new Error("kaput")`, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toContain("kaput")
  })

  it("fails on a script that does not parse", async () => {
    const error = await failWith(layer, `const const`, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("compile")
  })

  it("fails on a non-outcome return", async () => {
    const error = await failWith(layer, `return { nope: true }`, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("invalid_outcome")
  })

  it("aborts the run on a handler failure and refuses to be swallowed", async () => {
    const seen: Array<string> = []
    const handler = (request: ScriptRunner.Request) => {
      seen.push(request.name)
      return request.name === "boom" ? Effect.fail("handler down") : echo(request)
    }
    const error = await failWith(
      layer,
      [
        `try { await Promise.all([ctx.call("boom"), ctx.call("stale")]) } catch (both) {}`,
        `return done("swallowed")`
      ].join("\n"),
      handler
    )
    expect(error).toBe("handler down")
    expect(seen).toEqual(["boom"])
  })

  it("round-trips a missing payload as null and an undefined result as null", async () => {
    const outcome = await runWith(
      layer,
      `const value = await ctx.call("void")\nreturn done([value])`,
      () => Effect.succeed(undefined)
    )
    expect(outcome).toEqual({ _tag: "Done", value: [null] })
  })

  it("treats a bare done() as done(null)", async () => {
    const outcome = await runWith(layer, `return done()`, echo)
    expect(outcome).toEqual({ _tag: "Done", value: null })
  })

  it("rejects a non-string call name identically", async () => {
    const outcome = await runWith(
      layer,
      `const message = await ctx.call(42).catch(function (error) { return error.message })\nreturn done(message)`,
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: "ctx.call expects a call name as its first argument" })
  })

  it("rejects a non-serializable call input identically", async () => {
    const outcome = await runWith(
      layer,
      [
        `const fromFn = await ctx.call("x", function () {}).catch(function (error) { return error.message })`,
        `const fromNaN = await ctx.call("x", NaN).catch(function (error) { return error.message })`,
        `return done([fromFn, fromNaN])`
      ].join("\n"),
      echo
    )
    expect(outcome).toEqual({
      _tag: "Done",
      value: ["ctx.call input must be JSON-serializable", "ctx.call input must be JSON-serializable"]
    })
  })

  it("rejects a non-serializable handler result identically", async () => {
    const outcome = await runWith(
      layer,
      `const message = await ctx.call("big").catch(function (error) { return error.message })\nreturn done(message)`,
      () => Effect.succeed({ count: 10n })
    )
    expect(outcome).toEqual({ _tag: "Done", value: `the "big" call result is not JSON-serializable` })
  })

  it("carries a primitive throw as the failure message", async () => {
    const error = await failWith(layer, `throw "kaput-string"`, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toBe("kaput-string")
  })

  it("reports thrown Error messages identically", async () => {
    const error = await failWith(layer, `throw new Error("kaput")`, echo) as ScriptRunner.ScriptFailure
    expect(error.message).toBe("kaput")
  })

  it("fails a script that awaits something that never settles", async () => {
    const error = await failWith(
      layer,
      `await new Promise(function () {})\nreturn done(null)`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toContain("never settles")
  })
})

describe("QuickJs sealed realm", () => {
  const layer = QuickJsRunner.layer()

  it("deletes the realm's nondeterminism and host escapes", async () => {
    const outcome = await runWith(
      layer,
      `return done([typeof Date, typeof Math.random, typeof require, typeof process, typeof fetch])`,
      echo
    )
    expect(outcome).toEqual({
      _tag: "Done",
      value: ["undefined", "undefined", "undefined", "undefined", "undefined"]
    })
  })

  it("fails closed when a script escapes the async wrapper", async () => {
    const error = await failWith(
      layer,
      `})(); (function () { throw new TypeError("escaped the wrapper") })(); (async () => {`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toContain("escaped the wrapper")
  })

  it("classifies an escape throwing a fake SyntaxError as runtime, not compile", async () => {
    const escape =
      `})(); (function () { var error = new Error("spoofed"); error.name = "SyntaxError"; throw error })(); (async () => {`
    const error = await failWith(layer, escape, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toBe("spoofed")
  })

  it("clamps a below-floor memory budget instead of aborting natively", async () => {
    const outcome = await runWith(
      QuickJsRunner.layer({ memoryBytes: 1024 }),
      `return done("booted")`,
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: "booted" })
  })

  it("interrupts a runaway synchronous loop under a step budget", async () => {
    const error = await failWith(
      QuickJsRunner.layer({ steps: 1_000 }),
      `while (true) {}`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
  })

  it("reports a step-budget interrupt raised by a post-await job", async () => {
    const error = await failWith(
      QuickJsRunner.layer({ steps: 1_000 }),
      `await Promise.resolve()\nwhile (true) {}`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
  })

  it.each(["1e999", "not-json"])("host-validates call input encoded as %s by replaced realm JSON", async (encoded) => {
    let calls = 0
    const outcome = await runWith(
      layer,
      [
        `const stringify = globalThis.JSON.stringify`,
        `globalThis.JSON.stringify = function () { return ${JSON.stringify(encoded)} }`,
        `const message = await ctx.call("x", {}).catch(function (error) { return error.message })`,
        `globalThis.JSON.stringify = stringify`,
        `return done(message)`
      ].join("\n"),
      () =>
        Effect.sync(() => {
          calls++
          return null
        })
    )
    expect(outcome).toEqual({ _tag: "Done", value: "ctx.call input must be JSON-serializable" })
    expect(calls).toBe(0)
  })

  it("reports a job-queue interrupt that is outside the script promise", async () => {
    const error = await failWith(
      QuickJsRunner.layer({ steps: 1_000 }),
      [
        `Promise.resolve().then(function () { while (true) {} })`,
        `await new Promise(function () {})`,
        `return done(null)`
      ].join("\n"),
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
  })

  it("interrupts a runaway synchronous loop under the production defaults", async () => {
    const error = await failWith(
      QuickJsRunner.layer(),
      `while (true) {}`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
  })

  it("allows an explicit opt-out from both production resource limits", async () => {
    const outcome = await runWith(
      QuickJsRunner.layer({ memoryBytes: undefined, steps: undefined }),
      `return done("unbounded")`,
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: "unbounded" })
  })

  it("disposes a pending bridge promise when the host handler is interrupted", async () => {
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<never>()
      const fiber = yield* Effect.forkChild(
        Effect.flatMap(ScriptRunner.ScriptRunner, (runner) =>
          runner.run(
            Script.make(`await ctx.call("blocked")\nreturn done(null)`),
            () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(blocked)))
          )).pipe(Effect.provide(QuickJsRunner.layer()))
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    })))

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })

  it("stops a runaway allocation under a memory budget", async () => {
    const error = await failWith(
      QuickJsRunner.layer({ memoryBytes: 256 * 1024 }),
      `let s = "x"\nwhile (true) s += s\nreturn done(null)`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
  })

  it("fails a return the realm cannot serialize as an outcome", async () => {
    const error = await failWith(layer, `return function () {}`, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("invalid_outcome")
  })

  it("journals time and randomness through the one door, replaying identically", async () => {
    const script = flow(
      `const now = await ctx.call("sys/now")`,
      `const random = await ctx.call("sys/random")`,
      `return done([now, random])`
    )
    const first = await runChain({
      author: Author.layerMock([script]),
      entries: Catalog.withSystem([]),
      runner: QuickJsRunner.layer()
    })
    const [now, random] = (first.outcome as Outcome.Done).value as [number, number]
    expect(typeof now).toBe("number")
    expect(typeof random).toBe("number")
    expect(random).toBeGreaterThanOrEqual(0)
    expect(random).toBeLessThan(1)

    const replay = await runChain({
      author: Author.layerMock([]),
      entries: Catalog.withSystem([]),
      initial: first.events,
      runner: ScriptRunner.layerNoop()
    })
    expect(replay.outcome).toEqual(first.outcome)
    expect(replay.events).toEqual(first.events)
  })
})
