/**
 * The node AST, and the side tables the functions hang off.
 *
 * Two invariants shape every declaration here, both from
 * `docs/specs/Concepts/Unified Flow Authoring.md`. The AST is **closure-free
 * and JSON serializable**, so a plan can be shipped, stored, diffed, and
 * rendered without the process that built it; and control flow is
 * **structure**, so a branch stores both arms as ASTs rather than a function
 * that would have to be run to find out what comes next.
 *
 * The functions an author does write — a mapper, a continuation, a branch
 * predicate — live in `WeakMap`s keyed by the AST node they belong to, and the
 * AST keeps only a {@link FunctionIdentity} digest of their source. The digest
 * is what enters content identity (`docs/specs/Concepts/Step Keys.md`); the
 * `WeakMap` is what the run reaches for when it has the real value in hand, and
 * it drops with the AST it is keyed by.
 *
 * Adapted from the agent repo's `@smthrs/core` `internal/node.ts`. `Dynamic`
 * does not come across — a model call is an ordinary action here — and
 * neither do annotations, which are `Context` values and would break
 * serializability.
 *
 * @since 0.1.0
 */
import { identity } from "effect/Function"
import type * as Pipeable from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import * as Planned from "../Planned.ts"
import { sha256 } from "./sha256.ts"

/**
 * The runtime type identifier every node carries.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const TypeId = "~@smthrs/plan/Node" as const

/**
 * The type-level form of {@link TypeId}.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export type TypeId = typeof TypeId

/**
 * A constant, known before anything runs.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Succeed {
  readonly _tag: "Succeed"
  readonly value: unknown
}

/**
 * Independent children, combined by name. Width is fixed here, at plan time:
 * there is no dynamic fan-out.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface All {
  readonly _tag: "All"
  readonly nodes: Readonly<Record<string, NodeAst>>
}

/**
 * A deferred pure transformation of an upstream result. `map` transforms; it
 * never decides.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Map {
  readonly _tag: "Map"
  readonly first: NodeAst
  readonly mapper: FunctionIdentity
}

/**
 * A continuation after an upstream node. `next` is present when the author
 * supplied a node directly instead of a builder, in which case the topology is
 * already known and nothing has to be evaluated to reveal it.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface AndThen {
  readonly _tag: "AndThen"
  readonly first: NodeAst
  readonly continuation: FunctionIdentity
  readonly next?: NodeAst | undefined
}

/**
 * A decision whose arms are static topology. The predicate runs at run time on
 * the real value; both arms are already ASTs, so the exit condition and the
 * handoff site are visible before anything runs
 * (`docs/specs/Concepts/Trampoline Loops.md`).
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Branch {
  readonly _tag: "Branch"
  readonly subject: string
  readonly first: NodeAst
  readonly predicate: FunctionIdentity
  readonly then: NodeAst
  readonly else: NodeAst
}

/**
 * A protected graph and its statically planned typed-failure continuation.
 *
 * DECIDED (2026-08-11, pending review): the symbolic error `subject` is minted
 * per catch node rather than shared, mirroring {@link Branch}. Failure arms are
 * built before the graph assigns ids, so a nested arm that captured an outer
 * error would resolve it to the inner catch's protected node under one shared
 * token.
 *
 * DECIDED (2026-08-11, pending review): an absent filter catches the entire
 * typed error channel, while a present schema catches only values it accepts.
 * This mirrors Effect's typed-error boundary and keeps defects outside normal
 * recovery. The serializable AST carries the schema identity; the live schema
 * remains in a side table beside the AST.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Catch {
  readonly _tag: "Catch"
  readonly subject: string
  readonly protected: NodeAst
  readonly failure: NodeAst
  readonly filter?: unknown | undefined
}

/**
 * How a flow call joins the caller's plan: `inline` splices the callee's body
 * in, `boundary` makes it one child execution, and `handoff` names the next
 * trampoline round.
 *
 * DECIDED (2026-08-11, pending review): the child-call variant is
 * `FlowCall{mode: "boundary"}`, not a second AST tag beside `FlowCall`. The
 * three modes are one authoring construct — a call to a named flow with a
 * payload — differing only in how the plan joins it, and every consumer
 * (`Graph.build`'s expansion test, key material, the interpreter's dispatch)
 * already switches on `mode`. A parallel `ChildCall` tag would duplicate the
 * flow tag, payload, and declaration side table in every one of them.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export type CallMode = "inline" | "boundary" | "handoff"

/**
 * A call to another flow. The AST keeps the callee's tag and the payload;
 * the declaration itself is in the side table, because a flow value carries
 * schemas and a body and is not JSON.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface FlowCall {
  readonly _tag: "FlowCall"
  readonly flow: string
  readonly mode: CallMode
  readonly payload: unknown
}

/**
 * A call to an action: the atom that does work. Same split as
 * {@link FlowCall}, and no mode — an action is always one node.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface ActionCall {
  readonly _tag: "ActionCall"
  readonly action: string
  readonly payload: unknown
}

/**
 * The serializable stand-in for a function. Captured functions digest their
 * exact source and declared inert captures. Unannotated functions additionally
 * carry process-local, per-object entropy so indistinguishable closure sources
 * fail closed instead of sharing a cache key.
 *
 * The algorithm tag is versioned so a change to identity semantics re-keys
 * everything derived from one, rather than colliding with it.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface FunctionIdentity {
  readonly _tag: "FunctionIdentity"
  readonly algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v3" | "static-node/v1"
  readonly digest: string
}

/** @private */
const CapturedTypeId = Symbol.for("@smthrs/plan/Node/CapturedFunction")

/** @private */
interface CapturedMetadata {
  readonly source: string
  readonly captures: string
}

/** @private */
type CapturedFunction = { readonly [CapturedTypeId]?: CapturedMetadata }

const ephemeralIdentities = new WeakMap<object, string>()
let ephemeralOrdinal = 0
let ephemeralNonce: string | undefined

/**
 * Returns the process-local nonce, seeding it on first use.
 *
 * The seed is deliberately lazy. Cloudflare Workers rejects any script that
 * calls `crypto.getRandomValues` while the module evaluates, with upload error
 * 10021, so reading entropy at module scope would stop every bundle containing
 * this package from deploying.
 *
 * @private
 */
const nonce = (): string => {
  if (ephemeralNonce === undefined) {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    ephemeralNonce = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }
  return ephemeralNonce
}

/** @private */
const captureError = (path: string, reason: string): TypeError =>
  new TypeError(`Node.capture: capture at ${path} ${reason}; captures must be finite, inert data`)

/** @private */
const canonicalCapture = (input: unknown, path: string, ancestors: WeakSet<object>): string => {
  if (input === null) return "null"
  switch (typeof input) {
    case "boolean":
      return input ? "true" : "false"
    case "number":
      if (!Number.isFinite(input)) throw captureError(path, "is not finite")
      return Object.is(input, -0) ? "[\"number\",\"-0\"]" : `["number",${JSON.stringify(input)}]`
    case "string":
      return `["string",${JSON.stringify(input)}]`
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      throw captureError(path, `has unsupported type ${typeof input}`)
  }

  if (ancestors.has(input)) throw captureError(path, "is cyclic")
  const prototype = Object.getPrototypeOf(input)
  if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) {
    throw captureError(path, "has a non-plain prototype")
  }
  ancestors.add(input)
  try {
    if (Array.isArray(input)) {
      const descriptors = Object.getOwnPropertyDescriptors(input)
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === "length") continue
        if (typeof key === "symbol" || !/^(0|[1-9]\d*)$/.test(key)) {
          throw captureError(path, `has unsupported array key ${String(key)}`)
        }
      }
      const items: Array<string> = []
      for (let index = 0; index < input.length; index++) {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined) throw captureError(`${path}[${index}]`, "is an array hole")
        if (!("value" in descriptor)) throw captureError(`${path}[${index}]`, "is an accessor")
        items.push(canonicalCapture(descriptor.value, `${path}[${index}]`, ancestors))
      }
      return `["array",[${items.join(",")}]]`
    }
    const members = Object.getOwnPropertyDescriptors(input)
    const keys = Reflect.ownKeys(members)
    const symbol = keys.find((key) => typeof key === "symbol")
    if (symbol !== undefined) throw captureError(path, `has symbol key ${String(symbol)}`)
    const encoded = (keys as Array<string>).sort().map((key) => {
      const descriptor = members[key]!
      if (!("value" in descriptor)) throw captureError(`${path}.${key}`, "is an accessor")
      return `${JSON.stringify(key)}:${canonicalCapture(descriptor.value, `${path}.${key}`, ancestors)}`
    })
    return `["object",{${encoded.join(",")}}]`
  } finally {
    ancestors.delete(input)
  }
}

/** @private */
const freezeCapture = (input: unknown, seen: WeakSet<object>): void => {
  if (typeof input !== "object" || input === null || seen.has(input)) return
  seen.add(input)
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input))) {
    /* v8 ignore else -- canonicalCapture rejects every accessor before freezing starts */
    if ("value" in descriptor) freezeCapture(descriptor.value, seen)
  }
  Object.freeze(input)
}

/**
 * Brands an operation with every inert value it closes over.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const capture = <Args extends ReadonlyArray<unknown>, A>(
  captures: Readonly<Record<string, unknown>>,
  operation: (...args: Args) => A
): (...args: Args) => A => {
  const source = Function.prototype.toString.call(operation)
  const canonical = canonicalCapture(captures, "$", new WeakSet())
  freezeCapture(captures, new WeakSet())
  const wrapped = function(this: unknown, ...args: ReadonlyArray<unknown>): unknown {
    return Reflect.apply(operation, this, args)
  }
  Object.defineProperty(wrapped, CapturedTypeId, {
    configurable: false,
    enumerable: false,
    value: { source, captures: canonical } satisfies CapturedMetadata,
    writable: false
  })
  return wrapped as (...args: Args) => A
}

/**
 * The serializable form of a planned value embedded in an AST value or
 * payload. The strict proxy itself cannot enter the AST because serializing it
 * is deliberately a build error.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface PlannedReference {
  readonly _tag: "PlannedReference"
  readonly node: string
  readonly path: ReadonlyArray<string>
}

/**
 * Every AST variant.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export type NodeAst = Succeed | All | Map | AndThen | Branch | Catch | FlowCall | ActionCall

type Operation = (value: unknown) => unknown

type Predicate = (value: unknown) => boolean

const operations = new WeakMap<AndThen | Map, Operation>()
const predicates = new WeakMap<Branch, Predicate>()
const filters = new WeakMap<Catch, Schema.Top>()
const declarations = new WeakMap<ActionCall | FlowCall, unknown>()

/**
 * One container being cloned: the object walked, the clone being filled, and
 * the member position the walk has reached. `keys` is `undefined` for an
 * array, whose members are positional.
 *
 * @since 0.1.0
 * @private
 */
interface CloneFrame {
  readonly source: Record<string, unknown> | ReadonlyArray<unknown>
  readonly output: Record<string, unknown> | Array<unknown>
  readonly keys: ReadonlyArray<string> | undefined
  index: number
}

/**
 * Replaces strict planned proxies with their inert reference records while
 * preserving the shape of JSON payloads.
 *
 * The walk carries its own explicit stack rather than recursing, because a
 * payload's nesting depth is the author's data and must not be bounded by the
 * native call stack. Cycles and shared references are memoized through `seen`
 * exactly as one recursion would memoize them: the clone of an object that
 * appears twice is one object, and a payload that contains itself clones into
 * a clone that contains itself. Whether such a payload is PLANNABLE is graph
 * building's verdict, not this cloner's.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const value = (input: unknown, seen: WeakMap<object, unknown> = new WeakMap()): unknown => {
  let result: unknown
  const frames: Array<CloneFrame> = []
  /** Resolves one member, opening a frame when it is an unseen container. */
  const enter = (current: unknown, place: (member: unknown) => void): void => {
    const reference = Planned.reference(current)
    if (reference !== undefined) {
      place({ _tag: "PlannedReference", node: reference.node, path: [...reference.path] } satisfies PlannedReference)
      return
    }
    if (current === null || typeof current !== "object") {
      place(current)
      return
    }
    const previous = seen.get(current)
    if (previous !== undefined) {
      place(previous)
      return
    }
    const container = current as Record<string, unknown> | ReadonlyArray<unknown>
    const output: Record<string, unknown> | Array<unknown> = Array.isArray(container)
      ? []
      : Object.create(null) as Record<string, unknown>
    seen.set(container, output)
    place(output)
    frames.push({
      source: container,
      output,
      keys: Array.isArray(container) ? undefined : Object.keys(container),
      index: 0
    })
  }
  enter(input, (member) => {
    result = member
  })
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!
    if (frame.index >= (frame.keys ?? frame.source as ReadonlyArray<unknown>).length) {
      frames.pop()
      continue
    }
    const position = frame.index
    frame.index = position + 1
    if (frame.keys === undefined) {
      const members = frame.output as Array<unknown>
      enter((frame.source as ReadonlyArray<unknown>)[position], (member) => {
        members.push(member)
      })
    } else {
      const key = frame.keys[position]!
      enter((frame.source as Record<string, unknown>)[key], (member) => {
        Object.defineProperty(frame.output, key, {
          configurable: true,
          enumerable: true,
          value: member,
          writable: true
        })
      })
    }
  }
  return result
}

/**
 * Digests a function's exact source as UTF-8 with SHA-256. Exact source matters:
 * whitespace inside a string literal is behavior, and normalizing it before
 * hashing can make different functions share an identity. Unless its inert
 * captures were declared with {@link capture}, the digest also includes
 * process-local, per-function entropy: JavaScript cannot inspect a closure, so
 * source-only identity would permit incorrect cache hits.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const functionIdentity = (operation: unknown): FunctionIdentity => {
  if (typeof operation !== "function") throw new TypeError("function identity requires a function")
  const metadata = (operation as CapturedFunction)[CapturedTypeId]
  const source = metadata?.source ?? Function.prototype.toString.call(operation)
  let ephemeral = ephemeralIdentities.get(operation)
  if (metadata === undefined && ephemeral === undefined) {
    ephemeral = `${nonce()}:${ephemeralOrdinal++}`
    ephemeralIdentities.set(operation, ephemeral)
  }
  return {
    _tag: "FunctionIdentity",
    algorithm: metadata === undefined ? "sha256-source-ephemeral/v4" : "sha256-source-captures/v3",
    digest: sha256(metadata === undefined ? `${source}\0${ephemeral}` : `${source}\0${metadata.captures}`)
  }
}

/**
 * The pipeable wrapper around an AST.
 *
 * `R` is phantom. Nothing here reads it, stores it, or digests it: the AST is
 * unchanged by it, so the plan a node describes and the key that plan hashes to
 * are the same whether or not a caller tracks requirements.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Node<out A, out E = never, out R = never> extends Pipeable.Pipeable {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
    readonly _R: Types.Covariant<R>
  }
  readonly ast: NodeAst
}

/**
 * The prototype every node shares, so `pipe` is one function rather than one
 * closure per node.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const NodeProto = {
  [TypeId]: {
    _A: identity,
    _E: identity,
    _R: identity
  },
  pipe() {
    // eslint-disable-next-line prefer-rest-params -- `pipeArguments` takes the arguments object itself.
    return pipeArguments(this, arguments)
  }
}

/**
 * Wraps an AST as a node.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const makeNode = <A = unknown, E = never, R = never>(ast: NodeAst): Node<A, E, R> =>
  Object.assign(Object.create(NodeProto), { ast })

/**
 * Constructs a {@link Succeed}.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const succeed = (input: unknown): Succeed => ({ _tag: "Succeed", value: value(input) })

/**
 * Constructs an {@link All}.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const all = (nodes: Readonly<Record<string, NodeAst>>): All => ({ _tag: "All", nodes })

/**
 * Constructs a {@link Map}, filing the mapper under the AST it belongs to.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const map = (first: NodeAst, operation: Operation, source: unknown): Map => {
  const ast: Map = { _tag: "Map", first, mapper: functionIdentity(source) }
  operations.set(ast, operation)
  return ast
}

/**
 * Constructs an {@link AndThen} from a builder. The builder is evaluated once
 * against a planned value when the graph is built, never here.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const andThen = (first: NodeAst, operation: Operation, source: unknown): AndThen => {
  const ast: AndThen = { _tag: "AndThen", first, continuation: functionIdentity(source) }
  operations.set(ast, operation)
  return ast
}

/**
 * Constructs an {@link AndThen} from a node the author supplied directly. There
 * is no function to digest, so the continuation carries a fixed marker.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const andThenNode = (first: NodeAst, next: NodeAst): AndThen => ({
  _tag: "AndThen",
  first,
  continuation: { _tag: "FunctionIdentity", algorithm: "static-node/v1", digest: sha256("static-node") },
  next
})

/**
 * Constructs a {@link Branch}. Both arms arrive already evaluated, because a
 * branch that had to be run to reveal its topology would not be a plan.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const branch = (
  subject: string,
  first: NodeAst,
  predicate: Predicate,
  source: unknown,
  then: NodeAst,
  otherwise: NodeAst
): Branch => {
  const ast: Branch = {
    _tag: "Branch",
    subject,
    first,
    predicate: functionIdentity(source),
    then,
    else: otherwise
  }
  predicates.set(ast, predicate)
  return ast
}

/**
 * Constructs a {@link Catch} whose failure topology is already evaluated.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const catch_ = (subject: string, protectedAst: NodeAst, failure: NodeAst, filter?: Schema.Top): Catch => {
  const ast: Catch = {
    _tag: "Catch",
    subject,
    protected: protectedAst,
    failure,
    ...(filter === undefined ? {} : { filter: Schema.toJsonSchemaDocument(filter) })
  }
  if (filter !== undefined) filters.set(ast, filter)
  return ast
}

/**
 * Constructs a {@link FlowCall}, filing the flow declaration beside it.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const flowCall = (declaration: unknown, flow: string, mode: CallMode, payload: unknown): FlowCall => {
  const ast: FlowCall = { _tag: "FlowCall", flow, mode, payload: value(payload) }
  declarations.set(ast, declaration)
  return ast
}

/**
 * Constructs an {@link ActionCall}, filing the action declaration beside
 * it.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const actionCall = (declaration: unknown, action: string, payload: unknown): ActionCall => {
  const ast: ActionCall = { _tag: "ActionCall", action, payload: value(payload) }
  declarations.set(ast, declaration)
  return ast
}

/**
 * The deferred function of a map or a continuation.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const operation = (ast: AndThen | Map): Operation | undefined => operations.get(ast)

/**
 * The run-time predicate of a branch.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const predicate = (ast: Branch): Predicate | undefined => predicates.get(ast)

/**
 * The optional error schema filter of a catch node.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const filter = (ast: Catch): Schema.Top | undefined => filters.get(ast)

/**
 * The flow or action declaration a call node names.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const declaration = (ast: ActionCall | FlowCall): unknown => declarations.get(ast)
