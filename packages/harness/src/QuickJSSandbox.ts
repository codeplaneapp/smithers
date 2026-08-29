/**
 * The QuickJS-WASM sandbox binding.
 *
 * This is the production `Sandbox`: the cell runs inside a QuickJS interpreter
 * compiled to WebAssembly, which is a genuinely separate JavaScript realm with
 * no reference to the host's globals, prototypes, or module loader. The same
 * single-file variant runs unmodified on Node and in a browser, so a browser
 * host provides this layer and calls the identical harness.
 *
 * What the cell can reach is exactly `ctx`: `ctx.call` bridges to the host's
 * durable flow boundary, `ctx.flows` is a frozen catalog projection. The
 * prelude removes `Date` and `Math.random` from the realm, because a replayed
 * cell must reach the same calls in the same order. There is no filesystem, no
 * network, no process, and no module loader to reach in the first place.
 *
 * Teardown is scope finalization and cancellation is fiber interruption: an
 * interrupted frame disposes the runtime, which is the only thing holding the
 * cell alive.
 *
 * Which QuickJS build is compiled is a seam. The default compiles the
 * single-file build from bytes, which is what Node and a browser want. A host
 * whose runtime forbids compiling WebAssembly from bytes at runtime, such as
 * Cloudflare's workerd, provides {@link Variant} instead and names a build
 * whose module came from its toolchain.
 *
 * @since 0.1.0
 */
import singlefile from "@jitl/quickjs-singlefile-browser-release-sync"
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect"
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSSyncVariant,
  QuickJSWASMModule
} from "quickjs-emscripten-core"
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import * as Cell from "./Cell.ts"
import type { HarnessError } from "./HarnessError.ts"
import * as elide from "./internal/elide.ts"
import * as printChannel from "./internal/printChannel.ts"
import * as Sandbox from "./Sandbox.ts"
import * as VariablesPanel from "./VariablesPanel.ts"

/**
 * The prelude evaluated before every cell.
 *
 * It installs the one binding a cell has and removes the two sources of
 * nondeterminism QuickJS ships with. The raw host bridge is captured in a
 * closure and then deleted from the global object, so a cell cannot reach the
 * unwrapped boundary and hand it unencoded values.
 */
/**
 * Every intrinsic the host's own realm-side code reads, bound before a cell runs.
 *
 * A global script may rebind `Object`, and under a per-cell realm that cost the
 * cell that did it and nothing else. Under a realm that outlives the cell it
 * costs the run: `encode` reaches `Object.keys` at call time, so one top-level
 * `const Object = {}` in frame 3 makes every `ctx.call` and every
 * `console.log` from frame 4 on die on `TypeError: not a function`, with no
 * name in the failure to connect it to the declaration that caused it. The same
 * holds for `JSON`, `Array`, `Number`, `String`, `TypeError` and `Promise`.
 *
 * Binding them here makes a cell that shadows an intrinsic cost exactly what a
 * REPL should charge for it — its own later code — and nothing the harness runs
 * on the cell's behalf. Nothing is refused, because nothing needs to be.
 */
const preludeIntrinsics = `  var keysOf = Object.keys
  var freezeValue = Object.freeze
  var prototypeOf = Object.getPrototypeOf
  var objectPrototype = Object.prototype
  var define = Object.defineProperty
  var isArray = Array.isArray
  var stringify = JSON.stringify
  var parse = JSON.parse
  var finite = Number.isFinite
  var render = String
  var Fault = TypeError
  var Deferred = Promise
  var argumentsOf = Array.prototype.slice`

/**
 * The realm-side helpers both preludes install.
 *
 * `encode` carries the label of what it is encoding so one validator serves
 * `ctx.call`, `ctx.done`, `ctx.park` and `ctx.justify` without any of them
 * having to describe its own refusal.
 */
const preludeHelpers = `${preludeIntrinsics}
  var freeze = function (value) {
    if (value !== null && typeof value === "object") {
      keysOf(value).forEach(function (key) { freeze(value[key]) })
      freezeValue(value)
    }
    return value
  }
  var encode = function (label, input) {
    var seen = []
    var visit = function (value) {
      if (value === null || typeof value === "string" || typeof value === "boolean") return
      if (typeof value === "number" && finite(value)) return
      if (typeof value !== "object") throw new Fault(label + " must be JSON-serializable")
      if (seen.indexOf(value) >= 0) throw new Fault(label + " must be JSON-serializable")
      var prototype = prototypeOf(value)
      if (!isArray(value) && prototype !== objectPrototype && prototype !== null) {
        throw new Fault(label + " must be JSON-serializable")
      }
      seen.push(value)
      keysOf(value).forEach(function (key) { visit(value[key]) })
      seen.pop()
    }
    visit(input)
    return stringify(input)
  }
  var settleEnvelope = function (settled) {
    // A failed call RESOLVES with the failure envelope; only teardown throws.
    // See Cell.callFailure for why.
    if (settled.ok) return settled.value
    if (settled.aborted) throw new Error(settled.failure.error.message)
    return settled.failure
  }
  var dispatch = function (flow, input, at) { return bridge(flow, input, at).then(settleEnvelope) }
  // The at option is whatever the cell wrote, so it is encoded defensively
  // rather than strictly: a value JSON cannot hold travels as null and the
  // boundary answers it as an ordinary invalid_input, instead of throwing out
  // of a cell that has already paid for the calls before this line.
  var encodeAt = function (value) {
    try { return encode("ctx.call at", value === undefined ? null : value) } catch (error) { return "null" }
  }`

/**
 * The handle `ctx.base` is bound to, rendered into both preludes as data.
 *
 * It is a constant rather than something the host mints, because the run's
 * opening tree is not a thing anybody has to decide to keep: the host either
 * recorded one or it did not, and a call against this id says which by
 * succeeding or by answering `checkpoint_unavailable`.
 */
const baseHandle = Cell.checkpoint(Cell.baseCheckpoint)

/**
 * The name a queued mint carries, so an overrun reads as what it was.
 *
 * Nothing resolves it: a checkpoint is not a flow, it is not in the catalog,
 * and no capability gates it. See `Sandbox` `Minter`.
 */
const checkpointFlow = "checkpoint"

/** Reads the `at` the realm encoded; the empty string is "the cell passed none". */
const decodedAt = (encoded: string): Schema.Json | undefined =>
  encoded === "" ? undefined : Schema.decodeUnknownSync(Schema.Json)(JSON.parse(encoded))

/**
 * The `ctx.call`, `ctx.checkpoint` and `ctx.base` members. `guard` is the one
 * line the REPL mode adds: nothing in the filing mode can end a run part-way
 * through a cell, because there the run ends by returning.
 */
const preludeCall = (guard: string): string =>
  `    call: function (flow, input, options) {
      if (typeof flow !== "string") return Deferred.reject(new Fault("ctx.call expects a flow name as its first argument"))
${guard}      var encoded = encode("ctx.call input", input === undefined ? null : input)
      var at = options === null || typeof options !== "object" ? undefined : options.at
      if (at === undefined) return dispatch(flow, encoded, "")
      // A handle the cell never awaited is a promise, and that spelling is the
      // one the ruling wrote: \`const cp = ctx.checkpoint()\`. The pin lands where
      // that line is, because the queue settles in issue order, so awaiting the
      // handle later cannot move the tree it names. Both spellings are accepted.
      if (at !== null && typeof at === "object" && typeof at.then === "function") {
        return at.then(function (resolved) { return dispatch(flow, encoded, encodeAt(resolved)) })
      }
      return dispatch(flow, encoded, encodeAt(at))
    },
    checkpoint: function () {
${guard}      return pin().then(settleEnvelope)
    },
    base: freeze(parse(${JSON.stringify(JSON.stringify(baseHandle))})),`

/**
 * What a `ctx.call` issued after `ctx.done` or `ctx.park` resolves with.
 *
 * A completion takes effect where it is called, so the calls a cell would have
 * made after it do not run. They fail the way every other refused call fails —
 * soft, with a code and a hint — because rule 3 promises a cell that a call
 * resolves rather than throws, and a completion is not the place to break that
 * promise: the guard shape the contract teaches puts `ctx.done` in the middle of
 * a cell, and a throw there would discard the rest of a frame that had already
 * finished the run.
 */
const sealedCall = Cell.callFailure(
  new Cell.CallResult({
    outcome: "failure",
    value: null,
    code: "run_completed",
    message:
      "This run was already completed: an earlier line of this cell called ctx.done or ctx.park, which takes effect where it is called, so no further flow call is dispatched."
  })
)

/**
 * The prelude a persistent realm is opened with.
 *
 * It differs from the per-cell prelude the filing surface used in exactly the
 * two ways the persistent realm
 * differs: `ctx.state` is gone, because the realm is the memory, and three new
 * members plus `console` are installed, because a script cannot `return`.
 *
 * `console.log` renders each argument on the host side — a string as itself,
 * anything else as canonical JSON — so a structured value reaches the next model
 * turn as the value it is rather than as `[object Object]`. A value JSON cannot
 * walk at all, a cycle above all, is the one case where that promise cannot be
 * kept, so it is named instead: the kind, the reason, and the fact that the
 * value is still bound. `String(value)` there would print the exact bytes this
 * channel exists to abolish.
 *
 * Both are installed as non-writable, non-configurable own properties, which the
 * per-cell prelude never needed to do. There, a cell that declared `ctx` shadowed
 * the name inside its own async wrapper and the next cell was handed a fresh
 * realm. Here the wrapper is gone and `CellValidation.normalize` rewrites a
 * top-level `const` to `var`, so the same declaration would assign over the run's
 * only host binding and every later cell would die on
 * `TypeError: not a function` — with `ctx` inside the panel's baseline, so
 * nothing would even name what went missing. A `var` declaration over a
 * non-writable global is a silent no-op in sloppy mode, which is a failure the
 * run survives. `CellValidation` refuses the declaration in-frame as well, so
 * the model is told rather than left to wonder.
 */
const replPrelude = (catalog: string): string =>
  `(function () {
  var bridge = globalThis.__call
  var pin = globalThis.__checkpoint
  var print = globalThis.__print
  var intent = globalThis.__intent
${preludeHelpers}
  delete globalThis.__call
  delete globalThis.__checkpoint
  delete globalThis.__print
  delete globalThis.__intent
  delete globalThis.Date
  delete Math.random
  // The seal: once this frame has said how the run ends, it has ended, and the
  // calls a cell would have made after that line are not dispatched. It lives
  // here rather than on the host because ctx.call has to answer synchronously,
  // and it is cleared per frame by the function this prelude returns — a park
  // whose reason is refused is asked again inside the same frame, and a realm
  // still sealed from the refused attempt would answer that retry with nothing.
  var sealed = null
  var sealedEnvelope = freeze(parse(${JSON.stringify(JSON.stringify(sealedCall))}))
  var unprintable = function (value, error) {
    var kind = isArray(value) ? "array" : typeof value
    var why = error !== null && typeof error === "object" && error.message ? error.message : render(error)
    return "[unprintable " + kind + ": " + why + " — the value is still bound, so print the part of it you need]"
  }
  var show = function (values) {
    var parts = []
    for (var index = 0; index < values.length; index++) {
      var value = values[index]
      if (typeof value === "string") parts.push({ text: value })
      else if (value === undefined) parts.push({ text: "undefined" })
      else {
        var encoded = null
        var refused = false
        try { encoded = stringify(value) } catch (error) { refused = true; parts.push({ text: unprintable(value, error) }) }
        // JSON answers \`undefined\` rather than throwing for a value it has no
        // notation for at all — a function, a symbol — and those read best as
        // themselves. It throws only for a value it cannot walk, and that is
        // the one case where naming the reason beats printing "[object Object]".
        if (!refused) parts.push(encoded === undefined ? { text: render(value) } : { json: parse(encoded) })
      }
    }
    print(stringify(parts))
  }
  var line = function () { show(argumentsOf.call(arguments)) }
  var host = function (name, value) {
    define(globalThis, name, { value: value, writable: false, enumerable: true, configurable: false })
  }
  host("console", freezeValue({ log: line, info: line, warn: line, error: line }))
  host("ctx", freezeValue({
${preludeCall(`      if (sealed !== null) return Deferred.resolve(sealed)\n`)}
    flows: freeze(${catalog}),
    done: function (output) {
      if (sealed !== null) return
      var encoded = encode("ctx.done output", output === undefined ? null : output)
      sealed = sealedEnvelope
      intent("done", encoded)
    },
    park: function (reason, message) {
      if (sealed !== null) return
      var encoded = encode("ctx.park message", { reason: reason === undefined ? null : reason, message: message === undefined ? "" : message })
      sealed = sealedEnvelope
      intent("park", encoded)
    },
    justify: function (text) { intent("justify", encode("ctx.justify text", text === undefined ? "" : text)) }
  }))
  // Handed back to the host, which calls it as each frame opens. See the seal
  // above for why the clearing is per frame rather than per run.
  return function () { sealed = null }
})()`

const catalogOf = (flows: Readonly<Record<string, Cell.FlowProjection>>): string => {
  const entries: Record<string, unknown> = {}
  for (const [name, projection] of Object.entries(flows)) {
    entries[name] = {
      name: projection.name,
      description: projection.description,
      capabilities: [...projection.capabilities],
      tier: projection.tier,
      // The contract tells a cell to read `ctx.flows` before reissuing a
      // rejected call, so the projection has to answer the question the
      // rejection asked: what shape does this flow take?
      ...(Option.isSome(projection.input) ? { input: projection.input.value } : {})
    }
  }
  return JSON.stringify(entries)
}

const raisedFrom = (dumped: unknown): Cell.Raised => {
  if (typeof dumped === "object" && dumped !== null) {
    const record = dumped as { readonly name?: unknown; readonly message?: unknown }
    return new Cell.Raised({
      name: typeof record.name === "string" ? record.name : "Error",
      // Never `String(object)`: a cell that threw a structured value is told
      // what it threw. See `Sandbox` `describe`.
      message: typeof record.message === "string" ? record.message : Sandbox.raisedOutcome(dumped).message
    })
  }
  return new Cell.Raised({ name: "Error", message: String(dumped) })
}

/**
 * Builds one owned QuickJS handle from the already-validated JSON result.
 *
 * Materializing the value directly also avoids parsing a multi-megabyte JSON
 * string inside a promise job, which leaves QuickJS 0.32's runtime heap in an
 * uncollectable state during disposal.
 */
const handleFromJson = (
  context: QuickJSContext,
  defineDataProperty: QuickJSHandle,
  value: Schema.Json
): QuickJSHandle => {
  if (value === null) return context.null
  switch (typeof value) {
    case "boolean":
      return value ? context.true : context.false
    case "number":
      return context.newNumber(value)
    case "string":
      return context.newString(value)
  }

  const container = Array.isArray(value) ? context.newArray() : context.newObject()
  try {
    for (const [key, item] of Object.entries(value)) {
      const child = handleFromJson(context, defineDataProperty, item)
      try {
        const property = context.newString(key)
        try {
          context.unwrapResult(
            context.callFunction(defineDataProperty, context.undefined, container, property, child)
          ).dispose()
        } finally {
          property.dispose()
        }
      } finally {
        child.dispose()
      }
    }
    return container
  } catch (error) {
    container.dispose()
    throw error
  }
}

/**
 * Caches only a successful asynchronous load; a rejection may be retried.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cacheSuccessful = <A>(load: () => Promise<A>): () => Promise<A> => {
  let loaded: Promise<A> | undefined
  return () => {
    if (loaded === undefined) {
      const pending = load()
      loaded = pending
      void pending.catch(() => {
        loaded = undefined
      })
    }
    return loaded
  }
}

/**
 * The QuickJS build the sandbox compiles.
 *
 * @category models
 * @since 0.1.0
 */
export interface VariantService {
  readonly variant: QuickJSSyncVariant
}

/**
 * The QuickJS build the sandbox compiles.
 *
 * @category services
 * @since 0.1.0
 */
export class Variant extends Context.Service<Variant, VariantService>()(
  "flows/harness/QuickJSSandbox/Variant"
) {}

/**
 * Provides the single-file build, which Node and a browser both compile.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerVariantLive: Layer.Layer<Variant> = Layer.succeed(Variant)({ variant: singlefile })

/**
 * Provides a build the host names.
 *
 * A workerd host builds one with `newVariant(baseVariant, { wasmModule })` from
 * a `.wasm` module import, because that runtime instantiates a module the
 * toolchain compiled and refuses to compile one from bytes.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerVariant = (variant: QuickJSSyncVariant): Layer.Layer<Variant> => Layer.succeed(Variant)({ variant })

/**
 * One compiled module per build, so two sandboxes over one variant share it.
 *
 * Keyed weakly: a variant a host builds per request is collectable with the
 * module it produced.
 */
const compiled = new WeakMap<QuickJSSyncVariant, () => Promise<QuickJSWASMModule>>()

const loaderFor = (variant: QuickJSSyncVariant): () => Promise<QuickJSWASMModule> => {
  const known = compiled.get(variant)
  if (known !== undefined) return known
  const loader = cacheSuccessful(() => newQuickJSWASMModuleFromVariant(variant))
  compiled.set(variant, loader)
  return loader
}

/**
 * Synchronous monotonic-enough clock required by QuickJS's interrupt callback.
 *
 * @category models
 * @since 0.1.0
 */
export interface ComputeClockService {
  readonly now: () => number
}

/**
 * Synchronous monotonic-enough clock required by QuickJS's interrupt callback.
 *
 * @category services
 * @since 0.1.0
 */
export class ComputeClock extends Context.Service<ComputeClock, ComputeClockService>()(
  "flows/harness/QuickJSSandbox/ComputeClock"
) {}

/**
 * Provides the browser-safe host clock behind the QuickJS clock seam.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerClockLive: Layer.Layer<ComputeClock> = Layer.succeed(ComputeClock)({ now: () => Date.now() })

const capabilities: Sandbox.Capabilities = {
  calls: true,
  memoryBytes: true,
  steps: true,
  timeMs: true
}

const timeLimitExceeded = (timeMs: number): Cell.Rejected =>
  new Cell.Rejected({
    code: "limit_exceeded",
    message: `This cell exceeded its wall-clock limit of ${timeMs} milliseconds`
  })

/**
 * The reasons `ctx.park` may name, as the transition schema declares them.
 *
 * Checked on the host rather than inside the realm so a wrong one settles the
 * frame as an `invalid_transition` the next frame is asked to fix, instead of as
 * a throw that reads like a bug in the cell's own logic.
 */
const parkReasons = ["waiting-input", "waiting-event", "waiting-quota"] as const

/** What `ctx.done` or `ctx.park` recorded, before the reason is judged. */
type Recorded =
  | { readonly kind: "done"; readonly output: string }
  | { readonly kind: "park"; readonly reason: Schema.Json; readonly message: string }

const parkPayload = Schema.decodeUnknownSync(
  Schema.Struct({ reason: Schema.Json, message: Schema.Json })
)

const printParts = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Union([
      Schema.Struct({ text: Schema.String }),
      Schema.Struct({ json: Schema.Json })
    ])
  )
)

/**
 * Renders one `console.log` call as the statement it contributes.
 *
 * The statement is *not* bounded here beyond what the host is willing to hold:
 * a frame's statements share one budget and the share each one gets is not known
 * until the frame closes, so the reduction happens there. What happens here is
 * the reduction the host needs for itself — a value larger than a whole frame's
 * budget can never be shown whole, so only its two ends are kept, and the size
 * it had is carried beside them so the notice at frame close names the original.
 *
 * The two ends are cut through `elide`, which will not split a surrogate pair.
 * They are joined with nothing between them, so a head ending in the first half
 * of a pair and a tail starting with the second half would fuse into a character
 * the cell never printed.
 */
const printed = (encoded: string): printChannel.Statement => {
  const parts = printParts(JSON.parse(encoded))
  const whole = parts.map((part) => "text" in part ? part.text : printChannel.render(part.json)).join(" ")
  if (whole.length <= Sandbox.printFrameBytes) return { text: whole, bytes: whole.length }
  const edge = Math.floor(Sandbox.printFrameBytes / 2)
  return {
    text: `${elide.headSlice(whole, edge)}${elide.tailSlice(whole, edge)}`,
    bytes: whole.length
  }
}

/**
 * The transition a REPL frame settled, or the reason it settled none.
 */
const replOutcome = (recorded: Recorded | undefined, justification: string | undefined): Cell.Outcome => {
  if (recorded !== undefined && recorded.kind === "park") {
    const reason = parkReasons.find((candidate) => candidate === recorded.reason)
    if (reason === undefined) {
      return new Cell.Rejected({
        code: "invalid_transition",
        message: `ctx.park was called with reason ${
          JSON.stringify(recorded.reason)
        }. Call it as ctx.park(reason, message) with reason one of "waiting-input", "waiting-event" or "waiting-quota".`
      })
    }
    return new Cell.Settled({
      transition: Sandbox.replTransition({ _tag: "Park", reason, message: recorded.message }, justification)
    })
  }
  return new Cell.Settled({
    transition: Sandbox.replTransition(
      recorded === undefined ? undefined : { _tag: "Done", output: recorded.output },
      justification
    )
  })
}

/**
 * How many values one probe walks before it stops counting.
 *
 * The walk exists to find the string bytes a realm is holding, and strings are
 * few and large where they matter — a file a cell read, a suite's output. The
 * bound is what keeps a realm holding a million small objects from paying for a
 * traversal of all of them, and it doubles as the cycle guard: a graph that
 * points at itself spends the budget instead of the stack.
 */
const weighNodes = 200_000

/**
 * How deep one probe descends before it stops counting.
 *
 * A cell can bind a linked list, and the walk runs inside the realm on the
 * realm's own stack.
 */
const weighDepth = 32

/**
 * Builds the in-realm probe that reads the variables panel and the realm's weight.
 *
 * The source is evaluated **once**, when the realm opens, and answers the
 * function every later frame calls. That is the whole reason it is a factory:
 * the intrinsics the walk needs are read here, before any cell has run, and held
 * in the closure, so a cell that binds `Object` at its top level loses its own
 * reflection and not the panel that would have named the binding for it. Called
 * fresh each frame instead, the probe would read whatever `Object` a cell had
 * left behind, and the frame after the shadowing would report an empty realm.
 *
 * The returned function declares nothing on the global object and adds no name
 * of its own to the set it reports, because the host holds it as a handle rather
 * than as a global. Every value's *panel* line is measured cheaply — a string's
 * length, an array's length, an object's key count, a function's arity, a number
 * or boolean by value — because a panel that serialized every global would cost
 * the heap every frame, and the whole point of a realm is that the value is
 * still there under the name the panel prints.
 *
 * `bytes` is a second, separate reading and it exists because QuickJS's own
 * ceiling cannot supply it. Measured on the shipped variant: `str_count` and
 * `str_size` stay at zero for every construction a cell can reach — `repeat`,
 * `join`, and a string handed in by the host bridge alike — so
 * `runtime.setMemoryLimit` refuses one allocation larger than the whole ceiling
 * and never sees accumulation. A realm under a 128 MiB ceiling held 400 MiB of
 * live strings across forty frames and raised nothing while the host's resident
 * set grew by 385 MB. Under a per-cell realm that hole was bounded by one cell;
 * under a per-run realm it compounds for the life of the run, so the run budget
 * is measured here instead. See {@link openRealm}.
 */
const panelProbe = (baseline: string): string =>
  `(function (ownNames, keysOf, isArray, stringify, render, skip) {
  return function () {
    var names = ownNames(globalThis)
    var out = []
    var total = 0
    var budget = ${weighNodes}
    var weigh = function (value, depth) {
      if (budget <= 0 || depth > ${weighDepth}) return 0
      budget = budget - 1
      if (typeof value === "string") return value.length
      if (value === null || typeof value !== "object") return 8
      var sum = 8
      if (isArray(value)) {
        for (var item = 0; item < value.length; item++) sum = sum + weigh(value[item], depth + 1)
        return sum
      }
      var keys = keysOf(value)
      for (var key = 0; key < keys.length; key++) {
        sum = sum + keys[key].length + weigh(value[keys[key]], depth + 1)
      }
      return sum
    }
    for (var index = 0; index < names.length; index++) {
      var name = names[index]
      if (skip.indexOf(name) >= 0) continue
      try {
        var value = globalThis[name]
        var kind = typeof value
        var bytes = weigh(value, 0)
        total = total + bytes
        if (value === null) out.push({ name: name, type: "null", size: "", bytes: bytes })
        else if (kind === "undefined") out.push({ name: name, type: "unset", size: "", bytes: bytes })
        else if (kind === "string") out.push({ name: name, type: "string", size: value.length + " chars", bytes: bytes })
        else if (kind === "function") out.push({ name: name, type: "function", size: "arity " + value.length, bytes: bytes })
        else if (isArray(value)) out.push({ name: name, type: "array", size: value.length + " items", bytes: bytes })
        else if (kind === "object") out.push({ name: name, type: "object", size: keysOf(value).length + " keys", bytes: bytes })
        else out.push({ name: name, type: kind, size: render(value), bytes: bytes })
      } catch (error) {
        // A name whose value cannot even be read — a throwing accessor, a proxy
        // that refuses its own keys. Named for what it is rather than folded into
        // \`unset\`, which means something else: a name a throw left unassigned.
        out.push({ name: name, type: "unreadable", size: "", bytes: 0 })
      }
    }
    return stringify({ names: out, bytes: total })
  }
})(Object.getOwnPropertyNames, Object.keys, Array.isArray, JSON.stringify, String, JSON.parse(${baseline}))`

/** One name as the probe reports it, before the panel drops the weight. */
const Weighed = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  size: Schema.String,
  bytes: Schema.Number
})

const decodeProbe = Schema.decodeUnknownSync(
  Schema.Struct({ names: Schema.Array(Weighed), bytes: Schema.Number })
)

/**
 * States the run's memory ceiling in the terms the realm can act on.
 *
 * Written for the model, because the model is who reads it: the total, the
 * ceiling, and the three names to reassign. A `var`-created global is
 * non-configurable, so `delete` cannot remove one and assignment is the whole of
 * the recovery — which is also why the refusal has to be spent where it lands.
 * Freeing is done by a cell, and a cell that is refused cannot free anything, so
 * a ceiling that stayed shut would ask for the one act it had just made
 * impossible. See {@link openRealm}.
 */
const overBudget = (
  held: number,
  ceiling: number,
  weighed: ReadonlyArray<typeof Weighed.Type>
): Cell.Rejected => {
  const heaviest = [...weighed]
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 3)
    .map((entry) => `${entry.name} (${entry.bytes})`)
  return new Cell.Rejected({
    code: "limit_exceeded",
    message: `The names this realm holds weigh ${held} bytes, over this run's ceiling of ${ceiling}. ` +
      `Nothing ran this frame, and your next cell does run: spend it freeing the largest by assigning over them — ${
        heaviest.join(", ")
      } — ` +
      "because a name a cell bound can be reassigned but never deleted. Every other name is still bound, " +
      "and a realm still over the ceiling after that cell is refused again."
  })
}

/**
 * Opens one QuickJS realm that lives for a whole run.
 *
 * The acquire/release is the pair the per-cell binding uses, moved up to the
 * caller's scope: teardown is still scope finalization and cancellation is still
 * fiber interruption, so nothing threads an abort signal. What changes is
 * lifetime — every cell is evaluated against the same context, so a top-level
 * declaration made in frame 3 is still bound in frame 9.
 *
 * Each cell is evaluated as `evalCode(text, "cell-<frame>.js", 128)`:
 * `JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_ASYNC`. That combination, measured on the
 * shipped variant, does three things at once — top-level `await` compiles, the
 * result is a promise the existing drive loop already knows how to poll, and
 * top-level declarations land in the realm rather than in an async wrapper that
 * dies with the frame. The raw numeric flag is passed because
 * `quickjs-emscripten-core`'s options object does not spell the async flag but
 * hands a numeric `options` straight through.
 *
 * The per-frame budgets survive the move unchanged, because they are counters
 * the interrupt handler reads rather than properties of the runtime: `timeMs`
 * and `steps` reset at each frame's start and the compute clock keeps refunding
 * host-call duration.
 *
 * `memoryBytes` becomes a **run** budget, and it is enforced in two places
 * because one of them cannot see half the heap. `runtime.setMemoryLimit` covers
 * the object graph and refuses any single allocation larger than the whole
 * ceiling; it does not count string data at all on the shipped variant, so
 * accumulation across frames escapes it entirely. The panel probe supplies that
 * half: it weighs what the realm's own names hold and a frame that opens over
 * the ceiling is refused before it runs, with the heaviest names stated, so the
 * next cell frees by assignment and the realm survives.
 *
 * The refusal is spent where it lands, and that is the load-bearing half of it.
 * Freeing is done by a cell, so a ceiling that stayed shut once it had fired
 * would refuse the freeing cell too, and the run would spend every remaining
 * frame being told to do the one thing it was being prevented from doing. So
 * the reading is cleared with the refusal: the next frame runs, the probe weighs
 * the realm again at its close, and a realm still over the ceiling is refused
 * again. The bound is therefore a pair of frames — a cell may allocate past the
 * ceiling and is told at the next frame, and a run that never frees alternates
 * between refusal and cell rather than growing every frame — which is what "the
 * names a run accumulates" can honestly mean when the harness never drops a
 * value behind the model's back.
 */
const openRealm = (
  module: QuickJSWASMModule,
  options: Sandbox.RealmOptions,
  clock: ComputeClockService
): Effect.Effect<Sandbox.Realm, Sandbox.SandboxError, Scope.Scope> =>
  Effect.gen(function*() {
    const limits = Sandbox.withDefaults(capabilities, options.limits)
    /* v8 ignore next -- `withDefaults` fills `timeMs` from `defaultLimits` whenever the `timeMs` capability is declared, and this binding declares it, so the coalesce never reaches its fallback; it only discharges the optional type on `Sandbox.Limits` */
    const timeMs = limits.timeMs ?? Sandbox.defaultLimits.timeMs
    /* v8 ignore next -- `withDefaults` fills `totalMs` alongside `timeMs`, so this coalesce only discharges the same optional type */
    const totalMs = limits.totalMs ?? Sandbox.defaultLimits.totalMs
    /* v8 ignore next -- `withDefaults` fills `memoryBytes` whenever the `memoryBytes` capability is declared, and this binding declares it, so the coalesce only discharges the optional type */
    const memoryBytes = limits.memoryBytes ?? Sandbox.defaultLimits.memoryBytes
    const stepBudget = limits.steps

    let clockBase = clock.now()
    let steps = 0
    let exhausted: Cell.Rejected | undefined
    let pending: Array<Sandbox.PendingCall> = []
    let ordinal = 0
    let lines: Array<printChannel.Statement> = []
    let retained = 0
    let unread = 0
    let recorded: Recorded | undefined
    let justification: string | undefined

    const acquired = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const runtime: QuickJSRuntime = module.newRuntime()
        /* v8 ignore else -- `withDefaults` fills `memoryBytes` whenever the `memoryBytes` capability is declared, and this binding declares it, so the heap ceiling is always set */
        if (limits.memoryBytes !== undefined) {
          runtime.setMemoryLimit(limits.memoryBytes)
        }
        runtime.setInterruptHandler(() => {
          if (clock.now() - clockBase >= timeMs) {
            exhausted = exhausted ?? timeLimitExceeded(timeMs)
            return true
          }
          if (stepBudget !== undefined && ++steps > stepBudget) {
            exhausted = exhausted ?? new Cell.Rejected({
              code: "limit_exceeded",
              message: `This cell exceeded its limit of ${stepBudget} interpreter steps`
            })
            return true
          }
          return false
        })
        const context: QuickJSContext = runtime.newContext()
        try {
          const defineDataProperty = context.unwrapResult(context.evalCode(
            `(function (defineProperty) {
  return function (object, key, value) {
    defineProperty(object, key, {
      value: value,
      writable: true,
      enumerable: true,
      configurable: true
    })
  }
})(Object.defineProperty)`
          ))
          return { runtime, context, defineDataProperty }
        } catch (error) {
          context.dispose()
          runtime.dispose()
          throw error
        }
      }),
      ({ context, defineDataProperty, runtime }) =>
        Effect.sync(() => {
          defineDataProperty.dispose()
          context.dispose()
          runtime.dispose()
        })
    )
    const { context, defineDataProperty, runtime } = acquired

    const install = (name: string, implementation: Parameters<QuickJSContext["newFunction"]>[1]): void => {
      const handle = context.newFunction(name, implementation)
      context.setProp(context.global, name, handle)
      handle.dispose()
    }

    const queue = (
      kind: "call" | "checkpoint",
      flow: string,
      input: Schema.Json,
      at: Schema.Json | undefined
    ): QuickJSHandle => {
      const deferred = context.newPromise()
      const reply = (payload: Schema.Json): void => {
        const handle = handleFromJson(context, defineDataProperty, payload)
        try {
          deferred.resolve(handle)
        } finally {
          handle.dispose()
          deferred.dispose()
        }
      }
      pending.push({
        ordinal: ordinal++,
        flow,
        input,
        kind,
        ...(at === undefined ? {} : { at }),
        settle: (result) =>
          reply(
            result.outcome === "success"
              ? { ok: true, value: result.value ?? null }
              : { ok: false, aborted: false, failure: Cell.callFailure(result) }
          ),
        abort: (message) =>
          reply({
            ok: false,
            aborted: true,
            failure: Cell.callFailure(new Cell.CallResult({ outcome: "failure", value: null, message }))
          })
      })
      return deferred.handle
    }
    install("__call", (flowHandle, inputHandle, atHandle) =>
      queue(
        "call",
        context.getString(flowHandle),
        Schema.decodeUnknownSync(Schema.Json)(JSON.parse(context.getString(inputHandle))),
        decodedAt(context.getString(atHandle))
      ))
    install("__checkpoint", () => queue("checkpoint", checkpointFlow, null, undefined))
    install("__print", (partsHandle) => {
      // What the model reads is bounded at frame close; what the host holds
      // while the cell is still running is bounded here, and it has to be a
      // different number because the two are answers to different questions.
      // A cell that prints in a loop hands over one payload per statement, and
      // every one of them is copied out of the WASM heap, parsed and decoded
      // before anything can decide it is surplus. Measured on this variant, a
      // print loop inside the default step budget took the host's resident set
      // from 288 MB to 746 MB, and two hundred prints of one 3 MiB string took
      // it to 1.4 GB — while the model, both times, was shown 16 KiB. Past the
      // retention ceiling the payload is not read at all: the handle belongs to
      // the caller, so ignoring it costs nothing, and the count of what was
      // ignored is stated at frame close rather than dropped in silence.
      if (retained >= Sandbox.printRetainedBytes) {
        unread = unread + 1
        return context.undefined
      }
      const line = printed(context.getString(partsHandle))
      retained = retained + line.text.length + 1
      lines.push(line)
      return context.undefined
    })
    install("__intent", (kindHandle, payloadHandle) => {
      const kind = context.getString(kindHandle)
      const payload = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(context.getString(payloadHandle)))
      if (kind === "done") recorded = { kind: "done", output: Cell.renderText(payload) }
      else if (kind === "park") {
        const park = parkPayload(payload)
        recorded = { kind: "park", reason: park.reason, message: Cell.renderText(park.message) }
      } else justification = Cell.renderText(payload)
      return context.undefined
    })

    const installed = context.evalCode(replPrelude(catalogOf(options.flows)))
    if (installed.error !== undefined) {
      const failure = context.dump(installed.error)
      installed.error.dispose()
      return yield* new Sandbox.SandboxError({
        code: "runtime_failed",
        message: "The sandbox prelude failed to install",
        cause: failure
      })
    }
    // What the prelude evaluated to: the function that clears the completion
    // seal. The host holds it as a handle rather than as a global, so no cell
    // can reach it and no cell can shadow it.
    const openFrame = installed.value
    yield* Effect.addFinalizer(() => Effect.sync(() => openFrame.dispose()))

    // The names a fresh realm already holds, snapshotted after the prelude so
    // `ctx` and `console` are part of the baseline rather than part of the
    // panel. Doubly encoded so no name — `__proto__` included — can reach the
    // probe's source as anything but data.
    const snapshot = context.unwrapResult(
      context.evalCode("JSON.stringify(Object.getOwnPropertyNames(globalThis))")
    )
    const baseline = context.getString(snapshot)
    snapshot.dispose()

    // Built once, called every frame. The handle lives on this scope beside the
    // context that made it, which is what keeps the probe's intrinsics the ones
    // a fresh realm had rather than the ones a cell left behind.
    const probe = context.unwrapResult(context.evalCode(panelProbe(JSON.stringify(baseline))))
    yield* Effect.addFinalizer(() => Effect.sync(() => probe.dispose()))

    let bindings: ReadonlyArray<VariablesPanel.Binding> = []
    let weighed: ReadonlyArray<typeof Weighed.Type> = []
    let held = 0

    const evaluate = (
      evaluation: Sandbox.RealmEvaluation
    ): Effect.Effect<Sandbox.RealmFrame, Sandbox.SandboxError | HarnessError> =>
      Effect.gen(function*() {
        // Per-frame budgets and per-frame buffers, reset before anything can
        // settle the frame. They are counters, not properties of the runtime, so
        // a realm that outlives one cell still charges each cell its own — and
        // resetting them first is what keeps a frame that ends before its cell
        // runs from being handed the previous frame's print buffer.
        clockBase = clock.now()
        steps = 0
        exhausted = undefined
        pending = []
        ordinal = 0
        lines = []
        retained = 0
        unread = 0
        recorded = undefined
        justification = undefined
        // The realm's own per-frame state: the seal a completion set. A frame
        // whose transition the harness refused is asked again inside the same
        // frame, so the retry has to open on an unsealed realm.
        context.unwrapResult(context.callFunction(openFrame, context.undefined)).dispose()

        // Whatever the frame produced, the prints are delivered with it and the
        // panel is read after it, so the answer is assembled in one place. A
        // frame that printed past the retention ceiling says so as its last
        // line, because a buffer that simply stopped would read as a cell that
        // simply stopped printing.
        const frameOf = (outcome: Cell.Outcome): Sandbox.RealmFrame => ({
          outcome,
          prints: printChannel.buffer(lines, unread),
          bindings
        })

        // The run's memory budget, judged against what the realm's own names
        // weigh rather than against a heap counter that cannot see them. A
        // frame that opens over the ceiling runs nothing, so nothing is lost
        // and the recovery is one assignment — and the reading is cleared with
        // the refusal, because the cell that frees is a cell and has to run.
        // Left standing, the ceiling would refuse that cell too, and every one
        // after it, so the run would spend the rest of its frames being told to
        // do the one thing it was being prevented from doing. Cleared, the next
        // frame runs, the probe weighs the realm again at its close, and a realm
        // still over the ceiling is refused again.
        if (held > memoryBytes) {
          const refusal = overBudget(held, memoryBytes, weighed)
          held = 0
          return frameOf(refusal)
        }

        const compiled = Sandbox.compile(evaluation.cell)
        if (compiled instanceof Cell.Rejected) return frameOf(compiled)

        const started = context.evalCode(compiled, `cell-${evaluation.frame}.js`, 128)
        if (started.error !== undefined) {
          const failure = context.dump(started.error)
          started.error.dispose()
          return frameOf(
            new Cell.Rejected({
              code: "compile_failed",
              /* v8 ignore next -- QuickJS reports a compile failure as an Error object, so the `message` arm is what a parser disagreement takes; `String(failure)` only discharges the `unknown` `context.dump` is typed as */
              message: `The cell did not compile: ${
                typeof failure === "object" && failure !== null && "message" in failure
                  ? String((failure as { readonly message: unknown }).message)
                  : String(failure)
              }`
            })
          )
        }
        const cellHandle = started.value

        let settled: Cell.Outcome | undefined
        const poll = (): void => {
          runtime.executePendingJobs()
          if (exhausted !== undefined) {
            settled = exhausted
            return
          }
          const state = context.getPromiseState(cellHandle)
          if (state.type === "pending") return
          if (state.type === "fulfilled") {
            // A script's completion value is not a transition and is never read:
            // a REPL cell says what it wants by calling `ctx.done` or `ctx.park`,
            // and saying nothing asks for another frame.
            state.value.dispose()
            settled = replOutcome(recorded, justification)
            return
          }
          const error = context.dump(state.error)
          state.error.dispose()
          settled = raisedFrom(error)
        }

        const outcome = yield* Sandbox.driveCell({
          pending,
          ...(evaluation.mint === undefined ? {} : { mint: evaluation.mint }),
          flush: () => poll(),
          finished: () => {
            poll()
            if (settled !== undefined) return settled
            if (pending.length > 0) return undefined
            return new Cell.Rejected({
              code: "stalled",
              message:
                "The cell awaited something that never settles. Inside a cell the only thing worth awaiting is ctx.call."
            })
          },
          wait: Effect.void,
          abort: () => {
            for (const call of pending.splice(0)) call.abort("The cell was interrupted")
          },
          handler: (call) =>
            Effect.suspend(() => {
              const pausedAt = clock.now()
              return evaluation.call(call).pipe(
                Effect.onExit(() =>
                  Effect.sync(() => {
                    clockBase += clock.now() - pausedAt
                  })
                )
              )
            }),
          limits
        }).pipe(
          // A realm that outlives its frame accumulates whatever the frame left
          // live, and disposing one while a bridge promise is still pending
          // aborts inside QuickJS. So every frame closes its own leftovers:
          // queued bridges are settled, the job queue is drained once, and the
          // cell's promise handle is released here rather than at teardown.
          Effect.ensuring(
            Effect.sync(() => {
              /* v8 ignore next -- `driveCell` drains `pending` on every exit it controls, so this loop has work only when the frame is interrupted between two settled calls; no deterministic test can produce that interleaving, and without the guard such a frame would leave a live bridge handle in a realm that outlives it, which aborts inside QuickJS at disposal */
              for (const call of pending.splice(0)) call.abort("The cell was interrupted")
              runtime.executePendingJobs()
              cellHandle.dispose()
            })
          )
        )

        // The panel, read from the realm the cell just ran in. It shares the
        // frame's remaining budget, so a cell that spent all of its own leaves
        // the previous reading standing rather than an empty one. What a cell
        // cannot do is take the reading away: the probe holds its own
        // intrinsics from before any cell ran, so a realm whose `Object` a cell
        // has rebound is still weighed and still named.
        const read = context.callFunction(probe, context.undefined)
        if (read.error === undefined) {
          const measured = decodeProbe(JSON.parse(context.getString(read.value)))
          read.value.dispose()
          weighed = measured.names
          held = measured.bytes
          bindings = measured.names.map((entry) =>
            new VariablesPanel.Binding({ name: entry.name, type: entry.type, size: entry.size })
          )
        } else {
          read.error.dispose()
        }
        return frameOf(outcome)
      }).pipe(
        Effect.timeoutOrElse({
          duration: totalMs,
          orElse: () =>
            Effect.succeed<Sandbox.RealmFrame>({
              outcome: timeLimitExceeded(totalMs),
              prints: "",
              bindings
            })
        })
      )

    return { evaluate }
  })

/**
 * Loads a QuickJS module through the sandbox's typed failure boundary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const loadModule = (
  loader: () => Promise<QuickJSWASMModule>
): Effect.Effect<QuickJSWASMModule, Sandbox.SandboxError> =>
  Effect.tryPromise({
    try: loader,
    catch: (cause) =>
      new Sandbox.SandboxError({
        code: "runtime_failed",
        message: "QuickJS WebAssembly module could not be loaded",
        cause
      })
  })

/**
 * Constructs the QuickJS sandbox over the build the host names, compiling the
 * WebAssembly module once.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeWithVariant: Effect.Effect<Sandbox.Sandbox, Sandbox.SandboxError, ComputeClock | Variant> = Effect
  .gen(function*() {
    const clock = yield* ComputeClock
    const { variant } = yield* Variant
    const module = yield* loadModule(loaderFor(variant))
    return Sandbox.make({
      capabilities,
      openRealm: (options) => openRealm(module, options, clock)
    })
  })

/**
 * Constructs the QuickJS sandbox over the single-file build.
 *
 * The build is fixed here rather than left in the requirements, so the clock
 * stays the only seam this constructor asks its caller to fill. A host that
 * names its own build uses {@link makeWithVariant}.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeWithClock: Effect.Effect<Sandbox.Sandbox, Sandbox.SandboxError, ComputeClock> = makeWithVariant.pipe(
  Effect.provide(layerVariantLive)
)

/**
 * Constructs the QuickJS sandbox with the live clock layer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Sandbox.Sandbox, Sandbox.SandboxError> = makeWithClock.pipe(
  Effect.provide(layerClockLive)
)

/**
 * Provides the QuickJS sandbox over the build the host names.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWithVariant: Layer.Layer<Sandbox.Sandbox, Sandbox.SandboxError, Variant> = Layer.effect(
  Sandbox.Sandbox
)(makeWithVariant.pipe(Effect.provide(layerClockLive)))

/**
 * Provides the QuickJS sandbox over the single-file build.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<Sandbox.Sandbox, Sandbox.SandboxError> = Layer.effect(Sandbox.Sandbox)(make)
