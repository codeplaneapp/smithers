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

  it("normalizes the one value JSON cannot represent, and refuses array holes", () => {
    // The QuickJS binding encodes in-realm, so it hands the host `0` for a
    // script's `-0`. The in-process binding must agree, or the two runners
    // journal different payloads for the same script.
    const crossed = ScriptRunner.jsonBoundary(-0)
    expect(crossed._tag).toBe("Ok")
    if (crossed._tag === "Ok") expect(Object.is(crossed.value, 0)).toBe(true)

    // A hole is not a value. `JSON.stringify` would rewrite it to null; this
    // boundary refuses rather than change a value it accepts.
    expect(ScriptRunner.jsonBoundary([1, , 3])._tag).toBe("Refused")
  })

  it("copies an own __proto__ key as an own key, never as the copy's prototype", () => {
    // `Object.create(null)` passes the prototype check by design, and such a
    // value can carry an own `__proto__`. Plain assignment into the copy
    // would invoke Object.prototype's setter: the key would vanish and the
    // copy's prototype would become an object the walk validated as data.
    const source = Object.create(null) as Record<string, unknown>
    source["__proto__"] = { polluted: true }
    const crossed = ScriptRunner.jsonBoundary(source)
    expect(crossed._tag).toBe("Ok")
    if (crossed._tag === "Ok") {
      const copied = crossed.value as Record<string, unknown>
      expect(Object.keys(copied)).toEqual(["__proto__"])
      expect(Object.getPrototypeOf(copied)).toBe(Object.prototype)
      expect(Object.getOwnPropertyDescriptor(copied, "__proto__")?.value).toEqual({ polluted: true })
    }
  })

  it("refuses rather than throws on depth and size", () => {
    // Both bounds exist so a pathological value is a REFUSAL the script can
    // observe. Overflowing the walk's own stack, or handing a value on to a
    // `JSON.stringify` that throws `Invalid string length`, would be an
    // untyped defect that kills the run instead.
    let deep: unknown = null
    for (let index = 0; index <= ScriptRunner.maxJsonDepth; index = index + 1) deep = { deep }
    expect(ScriptRunner.jsonBoundary(deep)._tag).toBe("Refused")
    let shallow: unknown = null
    for (let index = 0; index < ScriptRunner.maxJsonDepth - 1; index = index + 1) shallow = { shallow }
    expect(ScriptRunner.jsonBoundary(shallow)._tag).toBe("Ok")

    expect(ScriptRunner.jsonBoundary("x".repeat(ScriptRunner.maxJsonSize))._tag).toBe("Refused")
    expect(ScriptRunner.jsonBoundary({ [`k`.repeat(ScriptRunner.maxJsonSize)]: 1 })._tag).toBe("Refused")
  })

  it("reads every property exactly once, so a changing accessor cannot smuggle a subtree", () => {
    // The old boundary validated one read and then serialized a SECOND, so a
    // getter that answered differently the second time crossed unvalidated.
    let reads = 0
    const shifty = {
      get a() {
        reads = reads + 1
        return reads === 1 ? 1 : { nested: "never validated" }
      }
    }
    expect(ScriptRunner.jsonBoundary(shifty)).toEqual({ _tag: "Ok", value: { a: 1 } })
    expect(reads).toBe(1)
  })

  it("converts a throwing accessor or trap into a refusal, never a throw", () => {
    const exploding = Object.defineProperty({}, "boom", {
      enumerable: true,
      get: () => {
        throw new Error("getter blew up")
      }
    })
    expect(ScriptRunner.jsonBoundary(exploding)._tag).toBe("Refused")

    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new Error("ownKeys blew up")
      }
    })
    expect(ScriptRunner.jsonBoundary(hostile)._tag).toBe("Refused")
  })

  it("renders failure values the way the realm dump renders them", () => {
    expect(ScriptRunner.failureMessage(new Error("kaput"))).toBe("kaput")
    expect(ScriptRunner.failureMessage({ message: "dumped" })).toBe("dumped")
    expect(ScriptRunner.failureMessage("bare")).toBe("bare")
  })
})
