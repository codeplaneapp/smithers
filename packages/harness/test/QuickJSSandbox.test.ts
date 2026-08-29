/**
 * The QuickJS-WASM binding's own edges.
 *
 * The contract lives in `Sandbox.test.ts` and runs there against this binding.
 * What is pinned here is what belongs to the WebAssembly realm itself: the
 * ceilings it enforces, the shapes that cross its boundary, and its own failure
 * modes.
 */
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema, Scope } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"

const flows: Readonly<Record<string, Cell.FlowProjection>> = {
  "fs/list": new Cell.FlowProjection({
    name: "fs/list",
    description: "List a directory.",
    capabilities: ["fs:read:**"],
    tier: "sealed",
    placement: Option.none(),
    input: Option.none()
  })
}

const succeeds: Sandbox.Handler = () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))

/** A catalog wide enough for its own installation to cost something. */
const wideCatalog = (
  count: number,
  description = "List a directory."
): Readonly<Record<string, Cell.FlowProjection>> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `fs/list${index}`,
      new Cell.FlowProjection({
        name: `fs/list${index}`,
        description,
        capabilities: ["fs:read:**"],
        tier: "sealed",
        placement: Option.none(),
        input: Option.none()
      })
    ])
  )

interface Options {
  readonly call?: Sandbox.Handler | undefined
  readonly limits?: Sandbox.Limits | undefined
}

/**
 * Opens a realm of this binding's own and evaluates one cell in it.
 *
 * `QuickJSSandbox.make` rather than the layer, because these cases drive the
 * binding directly: what they pin is what the realm does with a limit, not what
 * the port does with one before it arrives.
 */
const inRealm = (
  text: string,
  options: Options
): Effect.Effect<Cell.Outcome, Sandbox.SandboxError | Error> =>
  Effect.gen(function*() {
    const sandbox = yield* QuickJSSandbox.make
    const realm = yield* sandbox.openRealm!({
      flows,
      ...(options.limits === undefined ? {} : { limits: options.limits })
    })
    const frame = yield* realm.evaluate({
      cell: Cell.source(text),
      frame: 0,
      call: options.call ?? succeeds,
      limits: options.limits
    })
    return frame.outcome
  }).pipe(Effect.scoped) as Effect.Effect<Cell.Outcome, Sandbox.SandboxError | Error>

/** Runs one cell and reports the whole `Exit`, so a defect is observable too. */
const evaluate = (
  text: string,
  options: Options = {}
): Promise<Exit.Exit<Cell.Outcome, Sandbox.SandboxError | Error>> =>
  Effect.runPromise(Effect.exit(inRealm(text, options)))

/** Runs one cell that is expected to settle with an outcome rather than fail. */
const outcomeOf = async (
  text: string,
  options: Options = {}
): Promise<Cell.Outcome> => {
  const exit = await evaluate(text, options)
  if (Exit.isFailure(exit)) throw new Error(`expected an outcome, got: ${Cause.pretty(exit.cause)}`)
  return exit.value
}

/** Runs one cell and reports the binding's own typed failure as data. */
const resultOf = (text: string, options: Options = {}) => Effect.runPromise(Effect.result(inRealm(text, options)))

describe("QuickJSSandbox limits", () => {
  it("retries a rejected cached module load instead of poisoning the cache", async () => {
    let attempts = 0
    const load = QuickJSSandbox.cacheSuccessful(() => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error("transient")) : Promise.resolve("loaded")
    })
    await expect(load()).rejects.toThrow("transient")
    await expect(load()).resolves.toBe("loaded")
    expect(attempts).toBe(2)
  })

  it("maps a rejected module load into the typed sandbox channel", async () => {
    const cause = new Error("module unavailable")
    await expect(Effect.runPromise(
      QuickJSSandbox.loadModule(() => Promise.reject(cause))
    )).rejects.toMatchObject({
      code: "runtime_failed",
      message: "QuickJS WebAssembly module could not be loaded",
      cause
    })
  })

  it("reads compute time through the injected synchronous clock", async () => {
    let now = 0
    const outcome = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.makeWithClock
      const limits = { timeMs: 2, steps: Number.MAX_SAFE_INTEGER }
      const realm = yield* sandbox.openRealm!({ flows, limits })
      const frame = yield* realm.evaluate({ cell: Cell.source(`while (true) {}`), frame: 0, call: succeeds, limits })
      return frame.outcome
    }).pipe(
      Effect.provideService(QuickJSSandbox.ComputeClock, { now: () => now++ }),
      Effect.scoped,
      Effect.runPromise
    )
    expect(outcome).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
  })

  it("runs at exactly the minimum heap and refuses the byte below it", async () => {
    const atMinimum = await outcomeOf(`ctx.done("ok")`, {
      limits: { memoryBytes: Sandbox.minimumMemoryBytes }
    })
    expect(atMinimum).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "ok" } })

    const below = await resultOf(`ctx.done("ok")`, {
      limits: { memoryBytes: Sandbox.minimumMemoryBytes - 1 }
    })
    expect(below).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "unsupported",
        message: `The memoryBytes limit must be a safe integer of at least ${Sandbox.minimumMemoryBytes} bytes`
      }
    })
  })

  it("stops an unbounded allocation at the heap ceiling while its step budget is untouched", async () => {
    // Memory before steps: the step budget is effectively infinite, so the only
    // thing that can end this cell is the heap.
    const outcome = await outcomeOf(
      `const held = []
       for (let index = 0; index < 1000000; index++) held.push({ index: index, pad: "x".repeat(64) })
       ctx.done(String(held.length))`,
      { limits: { memoryBytes: Sandbox.minimumMemoryBytes, steps: Number.MAX_SAFE_INTEGER } }
    )

    expect(outcome).toStrictEqual(new Cell.Raised({ name: "InternalError", message: "out of memory" }))
  }, 60_000)

  it("stops a cell that never returns at the step ceiling while its heap is untouched", async () => {
    // Steps before memory: the mirror of the case above. The loop allocates
    // nothing, so only the interpreter budget can stop it.
    const outcome = await outcomeOf(
      `let total = 0
       while (true) total = total + 1`,
      { limits: { steps: 100, memoryBytes: Sandbox.defaultLimits.memoryBytes, timeMs: 60_000 } }
    )

    expect(outcome).toStrictEqual(
      new Cell.Rejected({
        code: "limit_exceeded",
        message: "This cell exceeded its limit of 100 interpreter steps"
      })
    )
  })

  it("stops a cell that never returns at the compute clock when no other ceiling can", async () => {
    // The budget is a whole second because the clock starts before the realm
    // does: a ceiling tight enough to expire during the binding's own setup is
    // the separate case two tests below.
    const outcome = await outcomeOf(
      `let total = 0
       while (true) total = total + 1`,
      { limits: { timeMs: 1000, steps: Number.MAX_SAFE_INTEGER, totalMs: 30_000 } }
    )

    expect(outcome).toStrictEqual(
      new Cell.Rejected({
        code: "limit_exceeded",
        message: "This cell exceeded its wall-clock limit of 1000 milliseconds"
      })
    )
  }, 60_000)

  it("charges the prelude to the step budget, so a realm too small for its own catalog never opens", async () => {
    // The catalog is installed by interpreted code, and it is installed once
    // for the run rather than once per frame. A budget this small is therefore
    // spent at the open, before any cell has been asked for — and the run is
    // told so there rather than one frame at a time.
    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function*() {
          const sandbox = yield* QuickJSSandbox.make
          return yield* sandbox.openRealm!({ flows: wideCatalog(400), limits: { steps: 1 } })
        }).pipe(Effect.scoped)
      )
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "runtime_failed",
        message: "The sandbox prelude failed to install",
        cause: { name: "InternalError", message: "interrupted" }
      }
    })
  })

  it("fails the realm when the prelude itself cannot fit the heap", async () => {
    // A prelude that cannot be installed is the binding failing at its job, not
    // the cell failing at its own, so it travels in the error channel — and it
    // travels from the open, before any cell has been asked for.
    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function*() {
          const sandbox = yield* QuickJSSandbox.make
          return yield* sandbox.openRealm!({
            flows: wideCatalog(1, "y".repeat(3 * 1024 * 1024)),
            limits: { memoryBytes: Sandbox.minimumMemoryBytes, steps: Number.MAX_SAFE_INTEGER }
          })
        }).pipe(Effect.scoped)
      )
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "flows/harness/SandboxError",
        code: "runtime_failed",
        message: "The sandbox prelude failed to install",
        cause: { name: "InternalError", message: "out of memory" }
      }
    })
  })

  it("lets a cell that settles synchronously through a zero whole-evaluation ceiling", async () => {
    // `totalMs` bounds waiting, and this cell never waits: it is finished
    // before the ceiling has anything to interrupt.
    const outcome = await outcomeOf(`ctx.done("instant")`, {
      limits: { totalMs: 0 }
    })

    expect(outcome).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "instant" } })
  })

  it("dies instead of reporting a ceiling when a budget of zero stops the prelude's own scaffolding", async () => {
    // Recorded, not endorsed. A zero budget interrupts the property helper the
    // binding evaluates before any cell code exists, and that failure escapes
    // the acquire as a defect rather than as `limit_exceeded`. The runtime is
    // still torn down, which the following frames in this file prove.
    for (const limits of [{ steps: 0 }, { timeMs: 0 }]) {
      const exit = await evaluate(`ctx.done("unreachable")`, { limits })
      expect(Exit.isFailure(exit), JSON.stringify(limits)).toBe(true)
      expect(Cause.pretty((exit as Exit.Failure<never, never>).cause)).toContain("interrupted")
    }
  })
})

describe("QuickJSSandbox realm", () => {
  it("projects a thrown non-object into a stable raised outcome", async () => {
    expect(await outcomeOf(`throw "plain"`)).toStrictEqual(new Cell.Raised({ name: "Error", message: "plain" }))
    expect(await outcomeOf(`throw 42`)).toStrictEqual(new Cell.Raised({ name: "Error", message: "42" }))
    expect(await outcomeOf(`throw null`)).toStrictEqual(new Cell.Raised({ name: "Error", message: "null" }))
  })

  it("projects a thrown object by its name and message, and defaults each one separately", async () => {
    expect(await outcomeOf(`throw { name: "Custom", message: "detail" }`)).toStrictEqual(
      new Cell.Raised({ name: "Custom", message: "detail" })
    )
    // A structure is rendered as the structure it is. `[object Object]` is the
    // defect PROGRAM change 1 names verbatim and it is not reachable from here.
    expect(await outcomeOf(`throw { name: "Custom", message: 7 }`)).toStrictEqual(
      new Cell.Raised({ name: "Custom", message: `{"message":7,"name":"Custom"}` })
    )
    expect(await outcomeOf(`throw { code: 7 }`)).toStrictEqual(
      new Cell.Raised({ name: "Error", message: `{"code":7}` })
    )
  })

  it("names a park reason the contract does not declare, rather than throwing at the cell", async () => {
    // `ctx.park` is checked on the host, not inside the realm: a reason the
    // contract does not declare is a transition the next frame is asked to fix,
    // not a throw that reads like a bug in the cell's own logic.
    const contract = await outcomeOf(`ctx.park("waiting-forever", "held")`) as Cell.Rejected
    expect(contract.code).toBe("invalid_transition")
    expect(contract.message).toContain("waiting-input")
  })

  it("refuses a cell whose parentheses do not balance, before the realm sees it", async () => {
    // A cell is evaluated as a global script, so unbalanced parentheses are a
    // syntax error the boundary parse reads before the realm is asked — neither
    // shape reaches the realm at all, and neither can spend the step budget
    // getting there.
    for (
      const escape of [
        `})(), (function () { throw "primitive" })(), (async () => {`,
        `})(), (function () { let t = 0; while (true) t = t + 1 })(), (async () => {`
      ]
    ) {
      const outcome = await outcomeOf(escape, { limits: { steps: 20 } })
      expect(outcome, escape).toMatchObject({ _tag: "rejected", code: "compile_failed" })
      expect((outcome as Cell.Rejected).message).toContain("line 1")
    }
  })
})

describe("QuickJSSandbox calls", () => {
  it("refuses every input shape JSON cannot carry, without opening a boundary", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const call: Sandbox.Handler = (invocation) => {
      observed.push(invocation)
      return Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))
    }

    for (
      const expression of [
        `new (class Point { constructor() { this.x = 1 } })()`,
        `(function () { const a = {}; a.self = a; return a })()`,
        `{ go: function () {} }`,
        `{ n: NaN }`,
        `{ u: undefined }`,
        `[Symbol("x")]`
      ]
    ) {
      const outcome = await outcomeOf(
        `try {
           await ctx.call("fs/list", ${expression})
         } catch (error) {
           ctx.done(error.name + ": " + error.message)
         }
         ctx.done("accepted")`,
        { call }
      )
      expect(outcome, expression).toMatchObject({
        _tag: "settled",
        transition: { _tag: "complete", output: "TypeError: ctx.call input must be JSON-serializable" }
      })
    }

    expect(observed).toEqual([])
  })

  it("accepts a null-prototype object as ordinary JSON input", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await outcomeOf(
      `const bare = Object.create(null)
       bare.path = "."
       await ctx.call("fs/list", bare)
       ctx.done("accepted")`,
      {
        call: (invocation) => {
          observed.push(invocation)
          return Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))
        }
      }
    )

    expect(observed.map((invocation) => invocation.input)).toEqual([{ path: "." }])
    expect(outcome).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "accepted" } })
  })

  it("refuses source the boundary parse accepts and the realm does not", async () => {
    // The boundary parse is TypeScript's; the realm's is QuickJS's, and the two
    // do not draw the line in the same place. `#a in o` outside any class is a
    // grammar error TypeScript reports semantically and QuickJS reports at
    // compile, so the realm's own refusal is still reachable and still has to
    // read as one sentence a model can act on.
    const outcome = await outcomeOf(`const o = { a: 1 }\nctx.done(String(#a in o))`)

    expect(outcome).toMatchObject({ _tag: "rejected", code: "compile_failed" })
    expect((outcome as Cell.Rejected).message).toContain("The cell did not compile:")
  })

  it("names a failure the host reported without a message", async () => {
    const outcome = await outcomeOf(
      `const result = await ctx.call("fs/list", {})
       ctx.done(result.error.code + "|" + result.error.message)`,
      { call: () => Effect.succeed(new Cell.CallResult({ outcome: "failure", value: { why: "denied" } })) }
    )

    expect(outcome).toMatchObject({
      _tag: "settled",
      transition: { _tag: "complete", output: `flow_failed|The flow call failed` }
    })
  })

  it("runs the first call a cell issues only after an unrelated await has resumed it", async () => {
    // The frame starts with nothing queued and nothing settled: the driver has
    // to run the realm's job queue before it can decide the cell is stuck.
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await outcomeOf(
      `await null
       const listed = await ctx.call("fs/list", { path: "." })
       ctx.done(String(listed.entries.length))`,
      {
        call: (invocation) => {
          observed.push(invocation)
          return Effect.succeed(
            new Cell.CallResult({ outcome: "success", value: { entries: ["a", "b"], exitCode: 0 } })
          )
        }
      }
    )

    expect(observed).toHaveLength(1)
    expect(outcome).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "2" } })
  })
})

describe("QuickJSSandbox interruption", () => {
  it("tears the realm down when a frame is interrupted mid-call, and a fresh realm still runs", async () => {
    const result = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.make
      const entered = yield* Deferred.make<void>()
      const scope = yield* Effect.scope
      const realm = yield* sandbox.openRealm!({ flows }).pipe(Effect.provideService(Scope.Scope, scope))
      const frame = yield* realm.evaluate({
        cell: Cell.source(`await ctx.call("fs/list", {})\nctx.done("unreachable")`),
        frame: 0,
        call: () => Deferred.succeed(entered, void 0).pipe(Effect.andThen(Effect.never))
      }).pipe(Effect.forkChild({ startImmediately: true }))

      // Interrupt only once the frame is genuinely suspended in a host call.
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(frame)
      const exit = yield* Fiber.await(frame)

      // A realm opened after it proves the shared WebAssembly module was not
      // left in a broken state.
      const next = yield* sandbox.openRealm!({ flows })
      const after = yield* next.evaluate({
        cell: Cell.source(`ctx.done("after")`),
        frame: 0,
        call: succeeds
      })
      return { after: after.outcome, exit }
    }).pipe(Effect.scoped, Effect.runPromise)

    expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
    expect(result.after).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "after" } })
  }, 60_000)
})

describe("QuickJSSandbox memory pressure", () => {
  // Last in the file on purpose: the failure it pins aborts the WebAssembly
  // instance, and nothing after it in this module may depend on that instance.
  it("fails the frame rather than handing the cell a half-materialized reply", async () => {
    const exit = await evaluate(
      `const listed = await ctx.call("fs/list", {})
       ctx.done(String(listed.blob.length))`,
      {
        limits: { memoryBytes: Sandbox.minimumMemoryBytes, steps: Number.MAX_SAFE_INTEGER },
        call: () =>
          Effect.succeed(
            new Cell.CallResult({ outcome: "success", value: { blob: "z".repeat(3 * 1024 * 1024) } })
          )
      }
    )

    expect(Exit.isFailure(exit)).toBe(true)
  }, 60_000)
})
