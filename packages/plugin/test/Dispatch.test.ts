import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import type { FirstHook, ParallelHook, SequentialHook } from "../src/Hooks.ts"
import * as Hooks from "../src/Hooks.ts"
import type { FlowsHooks, FlowsPlugin } from "../src/index.ts"
import * as Plugins from "../src/Plugins.ts"
import * as Resolve from "../src/Resolve.ts"

type Decision = "transient" | "permanent" | { readonly shareable: true }

declare module "../src/index.ts" {
  interface FlowsHooks {
    readonly testSequential: SequentialHook<(value: string) => Effect.Effect<unknown, any>>
    readonly testParallel: ParallelHook<(value: string) => Effect.Effect<void, any>>
    readonly testFirst: FirstHook<(value: string) => Effect.Effect<Option.Option<Decision>, any>>
  }
}

const dispatchHooks = {
  ...Hooks.engineHooks,
  testSequential: "sequential",
  testParallel: "parallel",
  testFirst: "first"
} as const satisfies Record<string, Hooks.HookKind>

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect as Effect.Effect<A, E>)

const dispatcherFor = async (plugins: ReadonlyArray<FlowsPlugin<FlowsHooks>>) =>
  Plugins.make(await run(Resolve.resolve(plugins, { hooks: dispatchHooks })))

describe("Plugins layers", () => {
  it("provides a dispatcher over a resolved list, and a plugin-free one", async () => {
    const seen: Array<string> = []
    const resolved = await run(Resolve.resolve([
      { name: "a", hooks: { testParallel: () => Effect.sync(() => void seen.push("a")) } }
    ], { hooks: dispatchHooks }))
    const program = Plugins.Plugins.pipe(
      Effect.flatMap((dispatcher) => dispatcher.parallel("testParallel", "value"))
    )
    expect(await run(program.pipe(Effect.provide(Plugins.layer(resolved))))).toEqual([])
    expect(seen).toEqual(["a"])
    expect(await run(program.pipe(Effect.provide(Plugins.layerNoop)))).toEqual([])
    expect(seen).toEqual(["a"])
  })
})

describe("sequential dispatch", () => {
  it("runs every handler in resolved order, one at a time, collecting results", async () => {
    const trace: Array<string> = []
    const verdict = (name: string, answer: "fail" | "tolerate"): FlowsPlugin<FlowsHooks> => ({
      name,
      hooks: {
        testSequential: () =>
          Effect.sync(() => {
            trace.push(`enter:${name}`)
            return answer
          }).pipe(Effect.tap(() => Effect.sync(() => trace.push(`exit:${name}`))))
      }
    })
    const dispatcher = await dispatcherFor([verdict("a", "tolerate"), verdict("b", "fail"), verdict("c", "tolerate")])
    const results = await run(
      dispatcher.sequential("testSequential", "value")
    )
    expect(results).toEqual(["tolerate", "fail", "tolerate"])
    // every handler observes the event, and none interleaves with another
    expect(trace).toEqual(["enter:a", "exit:a", "enter:b", "exit:b", "enter:c", "exit:c"])
    expect(results.includes("fail")).toBe(true)
  })

  it("fails the caller with hook_failed and stops at the failing handler", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      { name: "ok", hooks: { testSequential: () => Effect.sync(() => void seen.push("ok")) } },
      { name: "bad", hooks: { testSequential: () => Effect.die(new Error("boom")) } },
      { name: "never", hooks: { testSequential: () => Effect.sync(() => void seen.push("never")) } }
    ])
    const error = await run(
      dispatcher.sequential("testSequential", "value").pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
    expect(error.plugin).toBe("bad")
    expect(error.hook).toBe("testSequential")
    expect(seen).toEqual(["ok"])
  })

  it("wraps a synchronous throw inside a handler", async () => {
    const dispatcher = await dispatcherFor([
      {
        name: "thrower",
        hooks: {
          testSequential: (() => {
            throw new Error("sync boom")
          }) as never
        }
      }
    ])
    const error = await run(
      dispatcher.sequential("testSequential", "value").pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
    expect(error.plugin).toBe("thrower")
  })

  it("propagates a typed failure from a sequential handler", async () => {
    const dispatcher = await dispatcherFor([
      { name: "veto", hooks: { testSequential: () => Effect.fail("nope") } }
    ])
    const error = await run(
      dispatcher.sequential("testSequential", "value").pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
  })
})

describe("parallel dispatch", () => {
  it("runs every observer and isolates a failing one", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      { name: "a", hooks: { testParallel: () => Effect.sync(() => void seen.push("a")) } },
      { name: "b", hooks: { testParallel: () => Effect.fail("observer boom") } },
      { name: "c", hooks: { testParallel: () => Effect.sync(() => void seen.push("c")) } }
    ])
    const errors = await run(dispatcher.parallel("testParallel", "value"))
    expect(seen.sort()).toEqual(["a", "c"])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe("hook_failed")
    expect(errors[0]?.plugin).toBe("b")
  })

  it("surfaces every failure and never fails the caller", async () => {
    const dispatcher = await dispatcherFor([
      { name: "a", hooks: { testParallel: () => Effect.fail("x") } },
      { name: "b", hooks: { testParallel: () => Effect.die("y") } }
    ])
    const errors = await run(dispatcher.parallel("testParallel", "value"))
    expect(errors.map((error) => error.plugin).sort()).toEqual(["a", "b"])
  })
})

describe("first dispatch", () => {
  const classifier = (name: string, answer: Option.Option<Decision>, seen: Array<string>): FlowsPlugin<FlowsHooks> => ({
    name,
    hooks: {
      testFirst: () =>
        Effect.sync(() => {
          seen.push(name)
          return answer
        })
    }
  })

  it("stops at the first Option.some", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      classifier("a", Option.none(), seen),
      classifier("b", Option.some("permanent"), seen),
      classifier("c", Option.some("transient"), seen)
    ])
    const result = await run(dispatcher.first("testFirst", "value"))
    expect(result).toEqual(Option.some("permanent"))
    expect(seen).toEqual(["a", "b"])
  })

  it("returns none so the caller can apply its core default", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([classifier("a", Option.none(), seen)])
    const result = await run(dispatcher.first("testFirst", "value"))
    const classification = Option.getOrElse(result, (): Decision => "transient")
    expect(classification).toBe("transient")
    expect(seen).toEqual(["a"])
  })

  it("respects per-hook order when choosing the winner", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      classifier("normal", Option.some("transient"), seen),
      {
        name: "override",
        hooks: {
          testFirst: {
            order: "pre",
            handler: () =>
              Effect.sync(() => {
                seen.push("override")
                return Option.some<Decision>("permanent")
              })
          }
        }
      }
    ])
    const result = await run(dispatcher.first("testFirst", "value"))
    expect(result).toEqual(Option.some("permanent"))
    expect(seen).toEqual(["override"])
  })

  it("ignores a non-Option answer rather than short-circuiting on it", async () => {
    const dispatcher = await dispatcherFor([
      { name: "rogue", hooks: { testFirst: () => Effect.succeed("nonsense" as never) } },
      { name: "sane", hooks: { testFirst: () => Effect.succeed(Option.some({ shareable: true } as const)) } }
    ])
    const result = await run(dispatcher.first("testFirst", "value"))
    expect(result).toEqual(Option.some({ shareable: true }))
  })

  it("fails with hook_failed when a first handler fails", async () => {
    const dispatcher = await dispatcherFor([
      { name: "bad", hooks: { testFirst: () => Effect.fail("nope") } }
    ])
    const error = await run(
      dispatcher.first("testFirst", "value").pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
  })
})
