/**
 * The script interpreter port, and its in-process implementation.
 *
 * A script's only INTENDED exits are `ctx.call` and the outcome it returns.
 * Calls are settled one at a time by an Effect handler (the same pump shape
 * the QuickJS sandbox uses), so a hardened interpreter is a layer swap with
 * no chain change (`packages/chain/docs/contract.md`). Enforcing that the
 * intended exits are the ONLY exits is the sandbox's job, not this port's:
 * {@link layerInProcess} runs the script in the host realm.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Outcome from "./Outcome.ts"
import type * as Script from "./Script.ts"

/**
 * A script that did not reach an outcome: it failed to compile, threw at
 * runtime, returned something that is not an outcome, or the interpreter
 * itself is unavailable.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class ScriptFailure extends Schema.TaggedError<ScriptFailure>()("/chain/ScriptFailure", {
  code: Schema.Literals(["compile", "runtime", "invalid_outcome", "runner_unavailable"]),
  message: Schema.String
}) {}

/**
 * One call a running script issued; ordinals are assigned by the chain's
 * handler, which owns the per-link call counter.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Request {
  readonly name: string
  readonly payload: unknown
}

/**
 * The interpreter's one operation: run a script to an outcome, settling
 * each call it issues through the given handler.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly run: <E>(
    script: Script.Script,
    handler: (request: Request) => Effect.Effect<unknown, E>
  ) => Effect.Effect<Outcome.Outcome, ScriptFailure | E>
}

/**
 * The script interpreter service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class ScriptRunner extends Context.Service<ScriptRunner, Service>()("/chain/ScriptRunner") {}

/**
 * Builds an interpreter from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => ScriptRunner.of(implementation)

/**
 * An interpreter whose every operation fails as unavailable, with
 * per-operation overrides — the default a test starts from.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    run: Effect.fn("ScriptRunner.run")(() =>
      Effect.fail(new ScriptFailure({ code: "runner_unavailable", message: "run is unavailable" }))
    ),
    ...overrides
  })

/**
 * The unavailable interpreter as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ScriptRunner> =>
  Layer.succeed(ScriptRunner)(makeNoop(overrides))

interface Pending {
  readonly name: string
  readonly payload: unknown
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

type Settled = { readonly _tag: "value"; readonly value: unknown } | {
  readonly _tag: "thrown"
  readonly error: unknown
}

const decodeOutcomeShape = Schema.decodeUnknownOption(Outcome.Outcome)

/**
 * Decodes a script's returned value into an outcome; shared by every
 * runner binding so they reject the same shapes and normalize identically.
 *
 * A `To` is rebuilt through {@link Outcome.to}, which re-derives the
 * successor's digest from its text: a script may choose the text it hands
 * on, never the replay identity that text is keyed by.
 *
 * @category gates
 * @since 0.1.0
 * @slop
 */
export const decodeOutcome = (value: unknown): Option.Option<Outcome.Outcome> =>
  Option.map(
    decodeOutcomeShape(value),
    (outcome) => outcome._tag === "To" ? Outcome.to(outcome.script) : outcome
  )

/**
 * The deepest nesting a value may carry across the boundary. Journal
 * payloads are shallow; the cap exists so a pathological value is REFUSED
 * rather than overflowing the host stack inside the walk.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxJsonDepth = 128

/**
 * The boundary's size budget, in units: one per node plus one per code unit
 * of every string and key. It bounds the serialized form well below the
 * length at which `JSON.stringify` throws, which is what keeps the
 * host-side stringify in the QuickJS bridge total.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxJsonSize = 8 * 1024 * 1024

const refused = { _tag: "Refused" } as const

/**
 * The bridge's strict JSON boundary, shared by every binding: only null,
 * finite numbers, strings, booleans, and acyclic plain objects/arrays
 * within {@link maxJsonDepth} and {@link maxJsonSize} cross, and what
 * crosses is a structural copy. Mirrors the check the QuickJS prelude
 * performs in-realm, so both runners refuse the same shapes with the same
 * message.
 *
 * The walk is TOTAL and SINGLE-READ. It builds the copy as it validates,
 * reading every property exactly once, so a getter or proxy trap that
 * answers differently on a second read cannot smuggle an unvalidated
 * subtree across; and it converts every throw — a throwing accessor, a
 * throwing `ownKeys` trap, a cycle, a depth or size overrun — into
 * `Refused`. A host handler returning something unserializable is a
 * rejected call the script can observe, never a defect.
 *
 * `undefined` is refused everywhere except as the whole value, where it
 * becomes `null`. Array holes read as `undefined` and are refused too:
 * `JSON.stringify` would silently rewrite them to `null`, and this
 * boundary never changes a value it accepts. The one exception is `-0`,
 * which JSON cannot represent at all and which crosses as `0`.
 *
 * @category gates
 * @since 0.1.0
 * @slop
 */
export const jsonBoundary = (
  value: unknown
): { readonly _tag: "Ok"; readonly value: unknown } | { readonly _tag: "Refused" } => {
  const seen = new Set<object>()
  let budget = maxJsonSize
  const spend = (units: number): void => {
    budget = budget - units
    if (budget < 0) throw refused
  }
  const copy = (candidate: unknown, depth: number): unknown => {
    if (depth > maxJsonDepth) throw refused
    spend(1)
    if (candidate === null || typeof candidate === "boolean") return candidate
    if (typeof candidate === "string") {
      spend(candidate.length)
      return candidate
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw refused
      // `-0` is the one value normalized rather than refused. JSON has no
      // negative zero, so it would survive here and become `0` the moment
      // the event was serialized — and the QuickJS binding, which encodes
      // in-realm, already hands `0` to the host. Normalizing keeps the two
      // bindings byte-identical and keeps a replayed payload comparable to
      // the journaled one.
      return candidate === 0 ? 0 : candidate
    }
    if (typeof candidate !== "object") throw refused
    if (seen.has(candidate)) throw refused
    seen.add(candidate)
    if (Array.isArray(candidate)) {
      const copied: Array<unknown> = []
      for (let index = 0; index < candidate.length; index = index + 1) {
        copied.push(copy(candidate[index], depth + 1))
      }
      seen.delete(candidate)
      return copied
    }
    const prototype = Object.getPrototypeOf(candidate)
    if (prototype !== Object.prototype && prototype !== null) throw refused
    const copied: Record<string, unknown> = {}
    for (const key of Object.keys(candidate)) {
      spend(key.length)
      copied[key] = copy((candidate as Record<string, unknown>)[key], depth + 1)
    }
    seen.delete(candidate)
    return copied
  }
  try {
    return { _tag: "Ok", value: copy(value === undefined ? null : value, 0) }
  } catch {
    return refused
  }
}

/**
 * Renders a script failure value the way the QuickJS binding renders a
 * dumped realm error, so runtime failure messages match across runners.
 *
 * @category gates
 * @since 0.1.0
 * @slop
 */
export const failureMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { readonly message: unknown }).message)
    : String(error)

/**
 * The message every binding reports when a script's returned value is not
 * JSON — the first half of the shared outcome gate.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const unserializableOutcome = "the script returned a value that is not JSON-serializable"

/**
 * The message every binding reports when a script's returned value is JSON
 * but not one of the three outcomes — the second half of the shared gate.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const notAnOutcome = "the script did not return done(...), to(...), or park(...)"

const abortError = (): Error => new Error("the link was aborted")

const runInProcess = <E>(
  script: Script.Script,
  handler: (request: Request) => Effect.Effect<unknown, E>
): Effect.Effect<Outcome.Outcome, ScriptFailure | E> =>
  Effect.gen(function*() {
    let factory: (
      ctx: unknown,
      done: typeof Outcome.done,
      to: typeof Outcome.to,
      park: typeof Outcome.park
    ) => unknown
    try {
      // The Function constructor is the point of this layer: an in-process
      // interpreter whose body is the authored script. Sealing beyond the
      // ctx surface is the QuickJS layer's job.

      factory = new Function(
        "ctx",
        "done",
        "to",
        "park",
        `"use strict"\nreturn (async () => {\n${script.text}\n})()`
      ) as typeof factory
    } catch (error) {
      return yield* new ScriptFailure({ code: "compile", message: String(error) })
    }

    const pending: Array<Pending> = []
    let settled: Settled | undefined
    let aborted = false

    const ctx = Object.freeze({
      call: (name: unknown, payload?: unknown) =>
        new Promise((resolve, reject) => {
          if (aborted) {
            reject(abortError())
            return
          }
          // The same in-realm checks the QuickJS prelude performs: a
          // non-string name and a non-JSON payload reject identically, and
          // the payload crosses as a structural copy.
          if (typeof name !== "string") {
            reject(new TypeError("ctx.call expects a call name as its first argument"))
            return
          }
          const payloadBoundary = jsonBoundary(payload)
          if (payloadBoundary._tag === "Refused") {
            reject(new TypeError("ctx.call input must be JSON-serializable"))
            return
          }
          pending.push({ name, payload: payloadBoundary.value, resolve, reject })
        })
    })

    // The factory body is `return (async () => {...})()`, so invoking it
    // never throws synchronously — every script error lands in the rejection.
    Promise.resolve(factory(ctx, Outcome.done, Outcome.to, Outcome.park)).then(
      (value) => {
        settled = { _tag: "value", value }
      },
      (error: unknown) => {
        settled = { _tag: "thrown", error }
      }
    )

    while (true) {
      const next = pending.shift()
      if (next !== undefined) {
        const result = yield* handler({ name: next.name, payload: next.payload }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // A failed handler aborts the whole run: the script may not
              // catch its way past a gate. Later settlements are ignored.
              aborted = true
              next.reject(abortError())
              for (const stale of pending.splice(0)) stale.reject(abortError())
            })
          )
        )
        // A handler result crosses the same JSON boundary in every
        // binding; a host handler returning something unserializable is a
        // rejected call the script can observe, never a defect.
        const resultBoundary = jsonBoundary(result)
        if (resultBoundary._tag === "Refused") {
          next.reject(new Error(`the "${next.name}" call result is not JSON-serializable`))
        } else {
          next.resolve(resultBoundary.value)
        }
        continue
      }
      if (settled !== undefined) {
        if (settled._tag === "thrown") {
          return yield* new ScriptFailure({ code: "runtime", message: failureMessage(settled.error) })
        }
        // The outcome crosses the same boundary as a call payload, and it
        // crosses BEFORE decoding. The QuickJS binding validates in-realm
        // for the same reason: a value its own `JSON.stringify` would
        // rewrite — NaN, a function property, `undefined`, a `toJSON`
        // hook — must be refused here rather than laundered into a
        // different terminal result.
        const bounded = jsonBoundary(settled.value)
        if (bounded._tag === "Refused") {
          return yield* new ScriptFailure({
            code: "invalid_outcome",
            message: unserializableOutcome
          })
        }
        const outcome = decodeOutcome(bounded.value)
        if (outcome._tag === "None") {
          return yield* new ScriptFailure({
            code: "invalid_outcome",
            message: notAnOutcome
          })
        }
        return outcome.value
      }
      // Let every currently runnable host microtask finish. If that produces
      // neither a call nor a terminal result, the script is waiting on a
      // promise outside the only supported async door and cannot advance.
      yield* Effect.yieldNow
      if (pending.length === 0 && settled === undefined) {
        return yield* new ScriptFailure({
          code: "runtime",
          message: "the script awaited something that never settles — the only thing worth awaiting is ctx.call"
        })
      }
    }
  })

/**
 * The in-process runner: the script body runs as an async `Function` with
 * `ctx`, `done`, `to`, and `park` in scope.
 *
 * It provides NO isolation. The `Function` constructor builds its body in
 * GLOBAL scope, so the script reaches `globalThis`, `process`, and dynamic
 * `import()` — a fact `RunnerConformance.test.ts` pins deliberately, so
 * this sentence and the code cannot drift apart. Use it for trusted
 * fixtures. `QuickJsRunner.layer()` is the only sandbox for model-authored
 * scripts.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerInProcess: Layer.Layer<ScriptRunner> = Layer.succeed(ScriptRunner)(
  make({ run: runInProcess })
)
