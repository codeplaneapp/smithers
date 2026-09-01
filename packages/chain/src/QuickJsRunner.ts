/**
 * The QuickJS-WASM script runner — the production interpreter.
 *
 * A script runs inside a QuickJS interpreter compiled to WebAssembly: a
 * genuinely separate realm with no reference to the host's globals,
 * prototypes, or module loader. The prelude deletes `Date` and
 * `Math.random` — time and randomness are the `sys/now` and `sys/random`
 * catalog entries, journaled like any call — and the only bridge out is
 * `ctx.call`. The same single-file variant runs unmodified on Node and in
 * a browser. Adapted from the cell loop's QuickJS binding
 * (`docs/specs/Concepts/Chain Harness Build.md`, PR 3).
 *
 * @since 0.1.0
 */
import variant from "@jitl/quickjs-singlefile-browser-release-sync"
import { Effect, Layer } from "effect"
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core"
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import * as QuickJsJobs from "./internal/QuickJsJobs.ts"
import type * as Outcome from "./Outcome.ts"
import type * as Script from "./Script.ts"
import * as ScriptRunner from "./ScriptRunner.ts"

/**
 * Optional hard limits on a script evaluation, enforced by the QuickJS
 * runtime itself. Call budgets are the chain's fuel gate, not the
 * runner's.
 *
 * `memoryBytes` is clamped to {@link memoryFloor}: below it the realm
 * cannot even bootstrap and QuickJS aborts natively instead of failing
 * typed. `steps` counts interrupt-handler polls — QuickJS polls roughly
 * every few thousand instructions, so the budget is an order-of-magnitude
 * bound on work, not an instruction count. `stackBytes` bounds in-realm
 * recursion; leaving it unset lets deep recursion exhaust the HOST
 * WebAssembly stack instead, which aborts the module on dispose rather
 * than raising a catchable in-realm error, so opting out is only ever
 * right for a trusted fixture.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Limits {
  readonly memoryBytes?: number | undefined
  readonly steps?: number | undefined
  readonly stackBytes?: number | undefined
}

/**
 * The smallest memory limit the runner will apply: a QuickJS context needs
 * this much to boot without a native abort.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const memoryFloor = 256 * 1024

/**
 * The largest in-realm stack the runner will grant. Measured against
 * quickjs-emscripten-core 0.32.0: at 512 KiB and above, deep recursion
 * exhausts the host WebAssembly stack first — `evalCode` throws a host
 * `RangeError` the realm can neither see nor catch, the realm is left
 * holding live GC objects, and `runtime.dispose()` aborts the module. At
 * 256 KiB QuickJS raises its own catchable `stack overflow` and dispose is
 * clean.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const stackCeiling = 256 * 1024

/**
 * Production-safe runner limits. Passing an explicit `undefined` for any
 * field opts out of that limit.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultLimits: Required<Limits> = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: stackCeiling,
  steps: 10_000
}

/**
 * The prelude evaluated before every script. It installs `ctx.call`,
 * the three outcome constructors, and removes the realm's two sources of
 * nondeterminism. The raw bridge is captured in a closure and deleted
 * from the global object.
 */
const prelude = `(function () {
  var bridge = globalThis.__call
  var check = function (value) {
    var seen = []
    var visit = function (value) {
      if (value === null || typeof value === "string" || typeof value === "boolean") return
      if (typeof value === "number" && Number.isFinite(value)) return
      if (typeof value !== "object") throw new TypeError("not JSON-serializable")
      if (seen.indexOf(value) >= 0) throw new TypeError("not JSON-serializable")
      var prototype = Object.getPrototypeOf(value)
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("not JSON-serializable")
      }
      seen.push(value)
      Object.keys(value).forEach(function (key) { visit(value[key]) })
      seen.pop()
    }
    visit(value)
  }
  var encodeInput = function (input) {
    try {
      check(input)
    } catch (error) {
      throw new TypeError("ctx.call input must be JSON-serializable")
    }
    return JSON.stringify(input)
  }
  // The outcome crosses the same gate as a call payload, in the realm that
  // produced it. Without this the wrapper's own JSON.stringify would
  // silently rewrite the terminal result — done(NaN) to Done(null), a
  // function or undefined property dropped, a toJSON hook executed — and
  // the two runner bindings would disagree about what a valid outcome is.
  // Returning null (never throwing) keeps the distinction the host draws
  // between "not JSON" and "not an outcome".
  globalThis.__encodeOutcome = function (value) {
    try {
      check(value)
    } catch (error) {
      return null
    }
    return JSON.stringify(value)
  }
  delete globalThis.__call
  delete globalThis.Date
  delete Math.random
  globalThis.ctx = Object.freeze({
    call: function (name, input) {
      if (typeof name !== "string") {
        return Promise.reject(new TypeError("ctx.call expects a call name as its first argument"))
      }
      var encoded
      try {
        encoded = encodeInput(input === undefined ? null : input)
      } catch (error) {
        return Promise.reject(error)
      }
      return bridge(name, encoded).then(function (encoded) {
        var settled = JSON.parse(encoded)
        if (settled.ok) return settled.value
        var error = new Error(settled.message)
        error.name = "CallError"
        throw error
      })
    }
  })
  globalThis.done = function (value) {
    return { _tag: "Done", value: value === undefined ? null : value }
  }
  globalThis.to = function (script) {
    return { _tag: "To", script: script }
  }
  globalThis.park = function (code, message) {
    return { _tag: "Park", reason: { code: code, message: message === undefined ? "" : message } }
  }
})()`

// The encoder is captured into an eval-lexical `const` and deleted from the
// global object before the script body runs, so it is neither reachable as
// `globalThis.__encodeOutcome` nor reassignable. The `__script` assignment
// stays one top-level statement of the exact former shape: a script that
// escapes the async wrapper must still land as a runtime failure.
const wrap = (text: string): string =>
  `const __encodeOutcome = globalThis.__encodeOutcome
delete globalThis.__encodeOutcome
globalThis.__script = (async () => {\n${text}\n})().then(function (value) {
  return __encodeOutcome(value === undefined ? null : value)
})`

interface Pending {
  readonly name: string
  readonly payload: unknown
  readonly settle: (payload: unknown) => void
  readonly refusal?: string | undefined
}

/**
 * Encodes one bridge settlement for the realm.
 *
 * `ScriptRunner.jsonBoundary` bounds the shape and size of what reaches
 * here, but encoding is the last host-side step before a synchronous
 * QuickJS callback, and a `JSON.stringify` that throws there escapes as an
 * untyped defect that kills the whole run. It degrades to a refusal the
 * script can catch instead, so this function is total.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const encodeSettlement = (name: string, settlement: unknown): string => {
  try {
    return JSON.stringify(settlement)
  } catch {
    return JSON.stringify({ message: `the "${name}" call result cannot be encoded`, ok: false })
  }
}

/**
 * Caches a successful load process-wide while letting a rejected load be
 * retried: caching the rejection would turn one transient failure into a
 * permanently broken runner.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const cachedLoad = <A>(load: () => Promise<A>): () => Promise<A> => {
  let cached: Promise<A> | undefined
  return () => {
    cached = cached ?? load().catch((error: unknown) => {
      cached = undefined
      throw error
    })
    return cached
  }
}

/**
 * The loaded WebAssembly module, shared by every runner in the process:
 * compiling QuickJS is expensive and the module holds no per-script state.
 */
const wasmModule = cachedLoad(() => newQuickJSWASMModuleFromVariant(variant))

const evaluate = <E>(
  module: QuickJSWASMModule,
  limits: Limits,
  script: Script.Script,
  handler: (request: ScriptRunner.Request) => Effect.Effect<unknown, E>
): Effect.Effect<Outcome.Outcome, ScriptRunner.ScriptFailure | E> =>
  Effect.gen(function*() {
    const acquired = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const runtime: QuickJSRuntime = module.newRuntime()
        if (limits.memoryBytes !== undefined) {
          runtime.setMemoryLimit(Math.max(limits.memoryBytes, memoryFloor))
        }
        if (limits.stackBytes !== undefined) {
          runtime.setMaxStackSize(Math.min(limits.stackBytes, stackCeiling))
        }
        if (limits.steps !== undefined) {
          const budget = limits.steps
          let steps = 0
          runtime.setInterruptHandler(() => ++steps > budget)
        }
        const context: QuickJSContext = runtime.newContext()
        return { context, runtime }
      }),
      ({ context, runtime }) =>
        Effect.sync(() => {
          // Disposal is best-effort. A realm that exhausted the host WASM
          // stack still holds live GC objects, and QuickJS asserts on that
          // during teardown; letting the assertion out would make cleanup
          // the run's outcome and lose whatever the script actually did.
          try {
            context.dispose()
          } catch {
            // The module is already aborted; there is nothing left to free.
          }
          try {
            runtime.dispose()
          } catch {
            // As above.
          }
        })
    )
    const { context, runtime } = acquired

    const pending: Array<Pending> = []
    const deferreds = new Set<QuickJSDeferredPromise>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const deferred of deferreds) deferred.dispose()
        deferreds.clear()
      })
    )

    const bridge = context.newFunction("__call", (nameHandle, inputHandle) => {
      const name = context.getString(nameHandle)
      const encoded = context.getString(inputHandle)
      const deferred = context.newPromise()
      deferreds.add(deferred)
      const settle = (payload: unknown): void => {
        try {
          const handle = context.newString(encodeSettlement(name, payload))
          deferred.resolve(handle)
          handle.dispose()
        } finally {
          deferred.dispose()
          deferreds.delete(deferred)
        }
      }
      let payload: ReturnType<typeof ScriptRunner.jsonBoundary>
      try {
        payload = ScriptRunner.jsonBoundary(JSON.parse(encoded))
      } catch {
        payload = { _tag: "Refused" }
      }
      if (payload._tag === "Refused") {
        pending.push({
          name,
          payload: null,
          refusal: "ctx.call input must be JSON-serializable",
          settle
        })
      } else {
        pending.push({ name, payload: payload.value, settle })
      }
      return deferred.handle
    })
    context.setProp(context.global, "__call", bridge)
    bridge.dispose()

    // The prelude is a fixed string over an empty realm; a failure here is
    // a defect in this module, never a property of the script.
    context.unwrapResult(context.evalCode(prelude)).dispose()

    // Parse first, without executing: an in-realm Function construction
    // over the wrapped source distinguishes a genuine parse failure from
    // any runtime error — including a script that throws an error merely
    // *named* SyntaxError — without trusting error names.
    const wrapped = wrap(script.text)
    const parsed = context.evalCode(`new Function(${JSON.stringify(wrapped)})`)
    if (parsed.error !== undefined) {
      const failure = context.dump(parsed.error)
      parsed.error.dispose()
      return yield* new ScriptRunner.ScriptFailure({
        code: "compile",
        message: ScriptRunner.failureMessage(failure)
      })
    }
    parsed.value.dispose()

    const started = context.evalCode(wrapped)
    if (started.error !== undefined) {
      const failure = context.dump(started.error)
      started.error.dispose()
      // The source parsed, so anything here — an interrupt from the step
      // budget, a memory-limit throw, a wrapper escape — is runtime.
      return yield* new ScriptRunner.ScriptFailure({
        code: "runtime",
        message: ScriptRunner.failureMessage(failure)
      })
    }
    started.value.dispose()

    const scriptHandle = context.getProp(context.global, "__script")
    yield* Effect.addFinalizer(() => Effect.sync(() => scriptHandle.dispose()))

    while (true) {
      const jobs = runtime.executePendingJobs()
      yield* QuickJsJobs.check(jobs)
      // Drain issued calls before consulting the script's promise: a call
      // that was issued settles durably even when the script no longer
      // awaits it (a race loser), and its bridge handle is disposed.
      const next = pending.shift()
      if (next !== undefined) {
        if (next.refusal !== undefined) {
          next.settle({ message: next.refusal, ok: false })
          continue
        }
        const result = yield* handler({ name: next.name, payload: next.payload }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // A failed handler aborts the run; queued calls settle as
              // aborted so the realm holds no dangling promises when the
              // scope disposes it.
              next.settle({ message: "the link was aborted", ok: false })
              for (const stale of pending.splice(0)) {
                stale.settle({ message: "the link was aborted", ok: false })
              }
            })
          )
        )
        // A handler result crosses the same JSON boundary as the
        // in-process binding; refusing here also keeps the host-side
        // stringify in settle() total.
        const resultBoundary = ScriptRunner.jsonBoundary(result)
        if (resultBoundary._tag === "Refused") {
          next.settle({ message: `the "${next.name}" call result is not JSON-serializable`, ok: false })
        } else {
          next.settle({ ok: true, value: resultBoundary.value })
        }
        continue
      }
      const state = context.getPromiseState(scriptHandle)
      if (state.type === "fulfilled") {
        const value = context.dump(state.value)
        state.value.dispose()
        // The in-realm encoder answers null for a value the realm's own
        // JSON.stringify would rewrite, and a script that replaced
        // JSON.stringify can hand back text that is not JSON at all. Both
        // are the same refusal the in-process binding makes.
        let decoded: unknown
        try {
          if (typeof value !== "string") throw new TypeError(ScriptRunner.unserializableOutcome)
          decoded = JSON.parse(value)
        } catch {
          return yield* new ScriptRunner.ScriptFailure({
            code: "invalid_outcome",
            message: ScriptRunner.unserializableOutcome
          })
        }
        const outcome = ScriptRunner.decodeOutcome(decoded)
        if (outcome._tag === "None") {
          return yield* new ScriptRunner.ScriptFailure({
            code: "invalid_outcome",
            message: ScriptRunner.notAnOutcome
          })
        }
        return outcome.value
      }
      if (state.type === "rejected") {
        const failure = context.dump(state.error)
        state.error.dispose()
        return yield* new ScriptRunner.ScriptFailure({
          code: "runtime",
          message: ScriptRunner.failureMessage(failure)
        })
      }
      // Nothing is queued and no VM job can advance the script: it
      // awaited something the sealed realm can never settle.
      return yield* new ScriptRunner.ScriptFailure({
        code: "runtime",
        message: "the script awaited something that never settles — the only thing worth awaiting is ctx.call"
      })
    }
  }).pipe(
    Effect.scoped,
    // Last line of defence for the sealed realm's own machinery. A native
    // WebAssembly abort — the shape a host-stack exhaustion takes — is a
    // defect, and a defect escapes `Chain.run` entirely: nothing is
    // journaled, so the resumed link replays the same script and dies the
    // same way forever. Degrading it to a `runtime` ScriptFailure makes it
    // a journaled observation the model can route around, which is the
    // contract this module states.
    Effect.catchDefect((defect) =>
      new ScriptRunner.ScriptFailure({ code: "runtime", message: ScriptRunner.failureMessage(defect) })
    )
  )

/**
 * Constructs the QuickJS runner, compiling the WebAssembly module once per
 * process.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  limits: Limits = {},
  load: () => Promise<QuickJSWASMModule> = wasmModule
): Effect.Effect<ScriptRunner.Service, ScriptRunner.ScriptFailure> =>
  Effect.map(
    // A failed load is a typed, retryable unavailability — never a defect,
    // and never cached (see cachedLoad).
    Effect.tryPromise({
      catch: (error) =>
        new ScriptRunner.ScriptFailure({
          code: "runner_unavailable",
          message: ScriptRunner.failureMessage(error)
        }),
      try: () => load()
    }),
    (module) =>
      ScriptRunner.make({
        run: (script, handler) => evaluate(module, { ...defaultLimits, ...limits }, script, handler)
      })
  )

/**
 * The production script-runner layer: a sealed QuickJS realm per link.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (limits: Limits = {}): Layer.Layer<ScriptRunner.ScriptRunner, ScriptRunner.ScriptFailure> =>
  Layer.effect(ScriptRunner.ScriptRunner)(make(limits))
