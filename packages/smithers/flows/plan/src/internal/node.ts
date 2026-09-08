/**
 * The node AST, and the side tables the functions hang off.
 *
 * Two invariants shape every declaration here. The AST is **closure-free**
 * and keeps payloads as inert JSON mirrors, so a valid plan can be shipped,
 * stored, diffed, and rendered without the process that built it; control flow is
 * **structure**, so a branch stores both arms as ASTs rather than a function
 * that would have to be run to find out what comes next.
 *
 * The functions an author does write — a mapper, a continuation, a branch
 * predicate — live in `WeakMap`s keyed by the AST node they belong to, and the
 * AST keeps only a {@link FunctionIdentity} digest of their source. The digest
 * is what enters content identity (https://smithers.sh/docs/concepts/content-addressing); the
 * `WeakMap` is what the run reaches for when it has the real value in hand, and
 * it drops with the AST it is keyed by.
 *
 * Adapted from the agent repo's `@smthrs/core` `internal/node.ts`. `Dynamic`
 * does not come across — a model call is an ordinary action here — and
 * neither do annotations, which are `Context` values and would break
 * serializability. Scheduling priority is the one thing that does cross, as
 * the plain JSON field {@link Scheduled.priority} rather than as an
 * annotation, because the scheduler has to read it out of a stored plan.
 *
 * @since 0.1.0
 */
import { isRecord } from "@smthrs/canonical/Record"
import { digestSync } from "@smthrs/crypto"
import { identity } from "effect/Function"
import type * as Pipeable from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import { GraphBuildError } from "../GraphBuildError.ts"
import * as Planned from "../Planned.ts"

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
 * What every AST variant carries besides its own shape: an optional scheduling
 * priority.
 *
 * A priority is JSON, not a `Context` annotation, which is why it can live in
 * the AST at all: the whole point of dropping core's annotations was to keep a
 * plan shippable, storable, and diffable. It is a scheduling HINT — the plan
 * compiler copies it onto the node draft and the scheduler orders ready work by
 * it, while key material never reads it, so raising a priority reorders work
 * without re-keying a single step.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Scheduled {
  readonly priority?: number | undefined
}

/**
 * A constant, known before anything runs.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Succeed extends Scheduled {
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
export interface All extends Scheduled {
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
export interface Map extends Scheduled {
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
export interface AndThen extends Scheduled {
  readonly _tag: "AndThen"
  readonly first: NodeAst
  readonly continuation: FunctionIdentity
  readonly next?: NodeAst | undefined
}

/**
 * A decision whose arms are static topology. The predicate runs at run time on
 * the real value; both arms are already ASTs, so the exit condition and the
 * handoff site are visible before anything runs.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Branch extends Scheduled {
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
export interface Catch extends Scheduled {
  readonly _tag: "Catch"
  readonly subject: string
  readonly protected: NodeAst
  readonly failure: NodeAst
  readonly filter?: unknown | undefined
  readonly filterIdentity?: FunctionIdentity | undefined
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
export interface FlowCall extends Scheduled {
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
export interface ActionCall extends Scheduled {
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
  readonly algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v4" | "static-node/v1"
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

/** The maximum member nesting accepted in a declared capture. @private */
const captureDepthLimit = 256

/** @private */
const canonicalCapture = (input: unknown, path: string, ancestors: WeakSet<object>, depth: number): string => {
  if (depth > captureDepthLimit) throw captureError(path, `exceeds maximum depth ${captureDepthLimit}`)
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
        items.push(canonicalCapture(descriptor.value, `${path}[${index}]`, ancestors, depth + 1))
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
      return `${JSON.stringify(key)}:${canonicalCapture(descriptor.value, `${path}.${key}`, ancestors, depth + 1)}`
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
    // canonicalCapture already bounded this graph, so freezing cannot recurse
    // beyond captureDepthLimit.
    /* v8 ignore else -- canonicalCapture rejects every accessor before freezing starts */
    if ("value" in descriptor) freezeCapture(descriptor.value, seen)
  }
  Object.freeze(input)
}

/**
 * Brands an operation with every inert value it closes over. Capture members
 * may be nested through at most 256 levels.
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
  const canonical = canonicalCapture(captures, "$", new WeakSet(), 0)
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

/** The AST references minted by this module; structural lookalikes are data. */
const plannedReferences = new WeakSet<object>()

const makePlannedReference = (reference: Planned.Reference): PlannedReference => {
  const value = Object.freeze({
    _tag: "PlannedReference" as const,
    node: reference.node,
    path: Object.freeze([...reference.path])
  })
  plannedReferences.add(value)
  return value
}

/**
 * Reads an AST-owned planned reference without trusting its public data shape.
 *
 * @since 1.0.0
 * @private
 */
export const plannedReference = (value: unknown): PlannedReference | undefined =>
  typeof value === "object" && value !== null && plannedReferences.has(value)
    ? value as PlannedReference
    : undefined

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
  readonly descriptors: PropertyDescriptorMap
  readonly keys: ReadonlyArray<string> | undefined
  readonly path: ClonePath
  index: number
}

/**
 * Where the walk stands, as a link to its parent rather than a copy of the
 * whole path. Payload depth is bounded only by the caller, and copying the
 * path at each member made a clone cost memory quadratic in that depth: a
 * 20,000-deep payload held 20,000 live frames whose paths together ran to
 * hundreds of millions of entries, several gigabytes, for a result that is
 * linear. The path is read only to name a member in a refusal, so it stays a
 * chain here and is flattened at the throw.
 *
 * `undefined` is the root, whose path is empty.
 *
 * @since 0.1.0
 * @private
 */
type ClonePath = { readonly parent: ClonePath; readonly key: string } | undefined

/** The chain read outwards, root first: the array the refusals report. */
const clonePath = (path: ClonePath): ReadonlyArray<string> => {
  const keys: Array<string> = []
  for (let current = path; current !== undefined; current = current.parent) keys.push(current.key)
  return keys.reverse()
}

const payloadError = (at: ClonePath, reason: string): GraphBuildError => {
  const path = clonePath(at)
  return new GraphBuildError({
    code: "invalid_payload",
    node: "payload",
    path,
    message: `Plan payload at ${path.length === 0 ? "$" : `$.${path.join(".")}`} ${reason}`
  })
}

const cyclicPayloadError = (at: ClonePath): GraphBuildError => {
  const path = clonePath(at)
  return new GraphBuildError({
    code: "cyclic_payload",
    node: "payload",
    path,
    message: `Plan payload at ${
      path.length === 0 ? "$" : `$.${path.join(".")}`
    } has a toJSON method that returns itself`
  })
}

const inheritedDataProperty = (
  value: object,
  key: PropertyKey
): { readonly found: boolean; readonly value?: unknown } => {
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) {
      return "value" in descriptor ? { found: true, value: descriptor.value } : { found: true }
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return { found: false }
}

/**
 * Clones the JSON mirror of the input, so {@link module:StepKey.content} over
 * the clone and the input produce the same key and the AST holds only inert
 * JSON data. The walk uses an explicit stack, memoizes shared references and
 * cycles, honors callable `toJSON`, omits object members without a JSON
 * representation, and writes `null` for those values in arrays.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const value = (
  input: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
  plannedValue: (value: unknown, reference: Planned.Reference) => unknown = (_value, reference) =>
    makePlannedReference(reference)
): unknown => {
  const missing = Symbol("missing JSON representation")
  let result: unknown
  const frames: Array<CloneFrame> = []
  /** Resolves one member, opening a frame when it is an unseen container. */
  const enter = (
    initial: unknown,
    place: (member: unknown | typeof missing) => void,
    path: ClonePath
  ): void => {
    let current = initial
    const replacements: Array<object> = []
    const resolving = new WeakSet<object>()
    const finish = (member: unknown | typeof missing): void => {
      for (const replacement of replacements) seen.set(replacement, member)
      place(member)
    }
    while (true) {
      const reference = Planned.reference(current)
      if (reference !== undefined) {
        finish(plannedValue(current, reference))
        return
      }
      const kind = typeof current
      if (current === null || (kind !== "object" && kind !== "function")) {
        finish(kind === "undefined" || kind === "symbol" ? missing : current)
        return
      }
      const source = current as object
      if (seen.has(source)) {
        finish(seen.get(source))
        return
      }
      if (resolving.has(source)) {
        throw cyclicPayloadError(path)
      }
      const toJSON = inheritedDataProperty(source, "toJSON")
      if (toJSON.found && toJSON.value === undefined) {
        throw payloadError(path, "has an accessor-backed toJSON member")
      }
      if (typeof toJSON.value === "function") {
        resolving.add(source)
        replacements.push(source)
        current = Reflect.apply(toJSON.value, source, [])
        continue
      }
      if (kind === "function") {
        seen.set(source, missing)
        finish(missing)
        return
      }
      const prototype = Object.getPrototypeOf(source)
      if (!Array.isArray(source) && prototype !== Object.prototype && prototype !== null) {
        throw payloadError(path, "has an unsupported prototype and no data-valued toJSON method")
      }
      const container = current as Record<string, unknown> | ReadonlyArray<unknown>
      const descriptors = Object.getOwnPropertyDescriptors(container) as PropertyDescriptorMap
      const output: Record<string, unknown> | Array<unknown> = Array.isArray(container)
        ? []
        : Object.create(null) as Record<string, unknown>
      seen.set(container, output)
      finish(output)
      frames.push({
        source: container,
        output,
        descriptors,
        keys: Array.isArray(container)
          ? undefined
          : Reflect.ownKeys(descriptors).filter((key): key is string =>
            typeof key === "string" && descriptors[key]!.enumerable === true
          ),
        path,
        index: 0
      })
      return
    }
  }
  enter(input, (member) => {
    result = member === missing ? undefined : member
  }, undefined)
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
      const descriptor = frame.descriptors[String(position)]
      if (descriptor !== undefined && !("value" in descriptor)) {
        throw payloadError({ parent: frame.path, key: String(position) }, "is an accessor")
      }
      enter(descriptor === undefined ? undefined : descriptor.value, (member) => {
        members.push(member === missing ? null : member)
      }, { parent: frame.path, key: String(position) })
    } else {
      const key = frame.keys[position]!
      const descriptor = frame.descriptors[key]!
      if (!("value" in descriptor)) throw payloadError({ parent: frame.path, key }, "is an accessor")
      enter(descriptor.value, (member) => {
        if (member === missing) return
        Object.defineProperty(frame.output, key, {
          configurable: true,
          enumerable: true,
          value: member,
          writable: true
        })
      }, { parent: frame.path, key })
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
    algorithm: metadata === undefined ? "sha256-source-ephemeral/v4" : "sha256-source-captures/v4",
    digest: digestSync(metadata === undefined ? `${source}\0${ephemeral}` : `${source}\0${metadata.captures}`)
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
 * Every node {@link makeNode} built, so a node this module made is recognized
 * in constant time without walking its AST again.
 */
const liveNodes = new WeakSet<object>()

/** The algorithms a {@link FunctionIdentity} may name. */
const identityAlgorithms: ReadonlySet<unknown> = new Set<FunctionIdentity["algorithm"]>([
  "sha256-source-ephemeral/v4",
  "sha256-source-captures/v4",
  "static-node/v1"
])

/** The modes a {@link FlowCall} may name. */
const callModes: ReadonlySet<unknown> = new Set<CallMode>(["inline", "boundary", "handoff"])

/** @private */

/** @private */
const isFunctionIdentity = (value: unknown): value is FunctionIdentity =>
  isRecord(value) && value._tag === "FunctionIdentity" && identityAlgorithms.has(value.algorithm) &&
  typeof value.digest === "string"

/** One position of the {@link isNodeAst} walk: an AST to check, or one whose children are all checked. @private */
type AstVisit = { readonly enter: unknown } | { readonly exit: object }

/**
 * Checks whether a value has the shape of a {@link NodeAst}: what a JSON round
 * trip of a genuine AST produces, and nothing looser. Every variant's own
 * fields are checked, and every child is walked. The walk is an explicit stack
 * rather than recursion, so an arbitrarily deep AST cannot overflow the native
 * stack, and it tracks the ancestors of the position it has reached, so a
 * cyclic object is refused rather than walked forever while a shared sub-AST
 * still passes.
 *
 * @since 1.0.0
 * @private
 */
export const isNodeAst = (value: unknown): value is NodeAst => {
  const ancestors = new Set<object>()
  const pending: Array<AstVisit> = [{ enter: value }]
  while (pending.length > 0) {
    const visit = pending.pop()!
    if ("exit" in visit) {
      ancestors.delete(visit.exit)
      continue
    }
    const ast = visit.enter
    if (!isRecord(ast) || ancestors.has(ast)) return false
    if (ast.priority !== undefined && !Number.isSafeInteger(ast.priority)) return false
    const children: Array<unknown> = []
    switch (ast._tag) {
      case "Succeed":
        break
      case "All": {
        if (!isRecord(ast.nodes) || Array.isArray(ast.nodes)) return false
        for (const child of Object.values(ast.nodes)) children.push(child)
        break
      }
      case "Map": {
        if (!isFunctionIdentity(ast.mapper)) return false
        children.push(ast.first)
        break
      }
      case "AndThen": {
        if (!isFunctionIdentity(ast.continuation)) return false
        children.push(ast.first)
        if (ast.next !== undefined) children.push(ast.next)
        break
      }
      case "Branch": {
        if (typeof ast.subject !== "string" || !isFunctionIdentity(ast.predicate)) return false
        children.push(ast.first, ast.then, ast.else)
        break
      }
      case "Catch": {
        if (typeof ast.subject !== "string") return false
        if (ast.filterIdentity !== undefined && !isFunctionIdentity(ast.filterIdentity)) return false
        children.push(ast.protected, ast.failure)
        break
      }
      case "FlowCall": {
        if (typeof ast.flow !== "string" || !callModes.has(ast.mode)) return false
        break
      }
      case "ActionCall": {
        if (typeof ast.action !== "string") return false
        break
      }
      default:
        return false
    }
    if (children.length > 0) {
      ancestors.add(ast)
      pending.push({ exit: ast })
      for (const child of children) pending.push({ enter: child })
    }
  }
  return true
}

/**
 * Checks whether a value is a node.
 *
 * A node this module built is recognized by registration. A node that crossed
 * a serialization boundary, an object whose prototype is {@link NodeProto} and
 * whose own `ast` data property passes {@link isNodeAst}, is recognized by that
 * shape: `@smthrs/flow` hands a rehydrated AST back as a node, and the side
 * tables are all a round trip loses. The {@link TypeId} marker is an exported
 * string any object can carry, so it counts for nothing on its own, and an
 * `ast` that is missing, malformed, cyclic, or an accessor is refused because
 * every combinator reads it as trusted topology. A proxy is judged by the
 * shape it forwards.
 *
 * @since 1.0.0
 * @private
 */
export const isNode = (value: unknown): value is Node<unknown, unknown, any> => {
  if (typeof value !== "object" || value === null) return false
  if (liveNodes.has(value)) return true
  if (Object.getPrototypeOf(value) !== NodeProto) return false
  const ast = Object.getOwnPropertyDescriptor(value, "ast")
  return ast !== undefined && "value" in ast && isNodeAst(ast.value)
}

/**
 * Wraps an AST as a node.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const makeNode = <A = unknown, E = never, R = never>(ast: NodeAst): Node<A, E, R> => {
  const node: Node<A, E, R> = Object.assign(Object.create(NodeProto), { ast })
  liveNodes.add(node)
  return node
}

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
  continuation: { _tag: "FunctionIdentity", algorithm: "static-node/v1", digest: digestSync("static-node") },
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
 * JSON Schema does not describe arbitrary checks, declaration parsers, or
 * suspended schema factories. Include every function reachable from the
 * schema AST, preserving declared captures and treating opaque wrappers as
 * ephemeral. The iterative walk also covers nested checks and cyclic ASTs.
 *
 * @private
 */
const filterIdentity = (filter: Schema.Top): FunctionIdentity => {
  const identities: Array<readonly [string, FunctionIdentity]> = []
  const pending: Array<readonly [string, unknown]> = [["$", filter.ast]]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const [path, current] = pending.pop()!
    if (typeof current === "function") {
      identities.push([path, functionIdentity(current)])
    } else if (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current)
      const descriptors = Object.getOwnPropertyDescriptors(current)
      for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key]!
        if ("value" in descriptor) pending.push([`${path}/${JSON.stringify(key)}`, descriptor.value])
        else {
          if (descriptor.get !== undefined) pending.push([`${path}/${JSON.stringify(key)}/get`, descriptor.get])
          if (descriptor.set !== undefined) pending.push([`${path}/${JSON.stringify(key)}/set`, descriptor.set])
        }
      }
    }
  }
  return {
    _tag: "FunctionIdentity",
    algorithm: identities.some(([, identity]) => identity.algorithm === "sha256-source-ephemeral/v4")
      ? "sha256-source-ephemeral/v4"
      : "sha256-source-captures/v4",
    digest: digestSync(JSON.stringify(identities))
  }
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
    ...(filter === undefined
      ? {}
      : { filter: Schema.toJsonSchemaDocument(filter), filterIdentity: filterIdentity(filter) })
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

/**
 * Copies an AST with a scheduling priority attached.
 *
 * The copy is shallow and the side tables are re-filed against it, because a
 * function, a predicate, a filter schema, and a declaration are keyed by the
 * exact AST object they belong to: a copy that left them behind would silently
 * lose the continuation the graph walk has to evaluate.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const withPriority = (ast: NodeAst, priority: number): NodeAst => {
  const prioritized = { ...ast, priority }
  if (ast._tag === "AndThen" || ast._tag === "Map") {
    const deferred = operations.get(ast)
    if (deferred !== undefined) operations.set(prioritized as AndThen | Map, deferred)
  }
  if (ast._tag === "Branch") {
    const decision = predicates.get(ast)
    if (decision !== undefined) predicates.set(prioritized as Branch, decision)
  }
  if (ast._tag === "Catch") {
    const schema = filters.get(ast)
    if (schema !== undefined) filters.set(prioritized as Catch, schema)
  }
  if (ast._tag === "ActionCall" || ast._tag === "FlowCall") {
    const target = declarations.get(ast)
    if (target !== undefined) declarations.set(prioritized as ActionCall | FlowCall, target)
  }
  return prioritized
}
