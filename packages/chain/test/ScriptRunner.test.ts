import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type * as Outcome from "../src/Outcome.ts"
import * as Script from "../src/Script.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"

const echo = (request: ScriptRunner.Request): Effect.Effect<unknown> =>
  Effect.succeed({ name: request.name, payload: request.payload })

describe("ScriptRunner", () => {
  it("fails as noop and accepts overrides", async () => {
    const noop = ScriptRunner.makeNoop()
    const error = await Effect.runPromise(
      Effect.flip(noop.run(Script.make("return done(null)"), echo))
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runner_unavailable")

    const overridden = ScriptRunner.makeNoop({
      run: () => Effect.succeed({ _tag: "Done", value: "canned" } as Outcome.Outcome)
    })
    const outcome = await Effect.runPromise(overridden.run(Script.make(""), echo))
    expect(outcome).toEqual({ _tag: "Done", value: "canned" })
  })

  it("rejects calls issued after an abort (in-process scripts outlive the fiber)", async () => {
    const calls: Array<string> = []
    const handler = (request: ScriptRunner.Request) => {
      calls.push(request.name)
      return request.name === "boom" ? Effect.fail("handler down") : echo(request)
    }
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(
          ScriptRunner.ScriptRunner,
          (runner) =>
            runner.run(
              Script.make(
                [
                  `try { await ctx.call("boom") } catch (first) {`,
                  `  try { await ctx.call("after-abort") } catch (second) {}`,
                  `}`,
                  `return done("swallowed")`
                ].join("\n")
              ),
              handler
            )
        ).pipe(Effect.provide(ScriptRunner.layerInProcess))
      ) as Effect.Effect<unknown, never, never>
    )
    expect(error).toBe("handler down")
    expect(calls).toEqual(["boom"])
  })

  it("decodes only the three outcomes", () => {
    expect(ScriptRunner.decodeOutcome({ _tag: "Done", value: 1 })._tag).toBe("Some")
    expect(ScriptRunner.decodeOutcome({ nope: true })._tag).toBe("None")
  })

  it("refuses non-JSON values at the boundary and copies the rest", () => {
    expect(ScriptRunner.jsonBoundary(undefined)).toEqual({ _tag: "Ok", value: null })
    const source = { deep: { list: [1, "two", true, null] } }
    const crossed = ScriptRunner.jsonBoundary(source)
    expect(crossed).toEqual({ _tag: "Ok", value: source })
    if (crossed._tag === "Ok") expect(crossed.value).not.toBe(source)

    expect(ScriptRunner.jsonBoundary(Number.NaN)._tag).toBe("Refused")
    expect(ScriptRunner.jsonBoundary(10n)._tag).toBe("Refused")
    expect(ScriptRunner.jsonBoundary(() => null)._tag).toBe("Refused")
    expect(ScriptRunner.jsonBoundary(new Date())._tag).toBe("Refused")
    expect(ScriptRunner.jsonBoundary({ meta: undefined })._tag).toBe("Refused")
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(ScriptRunner.jsonBoundary(cycle)._tag).toBe("Refused")
  })

  it("renders failure values the way the realm dump renders them", () => {
    expect(ScriptRunner.failureMessage(new Error("kaput"))).toBe("kaput")
    expect(ScriptRunner.failureMessage({ message: "dumped" })).toBe("dumped")
    expect(ScriptRunner.failureMessage("bare")).toBe("bare")
  })
})
