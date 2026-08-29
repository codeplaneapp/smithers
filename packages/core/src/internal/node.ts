/**
 * Internal AST and runtime representation for pipeable flow nodes.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Schema Shaped Builder.md` and
 * `docs/specs/Concepts/Build Phases.md`.
 *
 * @since 0.0.0
 */
import type * as Context from "effect/Context"
import { identity } from "effect/Function"
import type * as Pipeable from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import type * as Types from "effect/Types"
import type * as Effects from "../Effects.ts"
import { sha256 } from "./sha256.ts"

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const TypeId = "~flows/core/Node" as const

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export type TypeId = typeof TypeId

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface Succeed {
  readonly _tag: "Succeed"
  readonly value: unknown
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface All {
  readonly _tag: "All"
  readonly nodes: Readonly<Record<string, NodeAst>>
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface Dynamic {
  readonly _tag: "Dynamic"
  readonly model?: string | undefined
  readonly flows: ReadonlyArray<unknown>
  readonly output?: unknown
  readonly prompt?: string | undefined
  readonly effects?: Effects.Declaration | undefined
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface AndThen {
  readonly _tag: "AndThen"
  readonly first: NodeAst
  readonly continuation: FunctionIdentity
  readonly next?: NodeAst | undefined
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface Map {
  readonly _tag: "Map"
  readonly first: NodeAst
  readonly mapper: FunctionIdentity
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface FunctionIdentity {
  readonly _tag: "FunctionIdentity"
  readonly algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v3" | "static-node/v1"
  readonly digest: string
}

/** @private */
type OperationIdentity = FunctionIdentity & {
  readonly algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v3"
}

/** @private */
const CapturedTypeId = Symbol.for("@smthrs/core/Node/CapturedFunction")

/** @private */
interface CapturedMetadata {
  readonly source: string
  readonly captures: string
}

/** @private */
type CapturedFunction = { readonly [CapturedTypeId]?: CapturedMetadata }

/** @private */
const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

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
    ephemeralNonce = hex(bytes)
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
 * @since 0.0.0
 * @private
 * @slop
 */
export interface FlowCall {
  readonly _tag: "FlowCall"
  readonly target: unknown
  readonly input: unknown
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export type NodeAst = Succeed | All | Dynamic | AndThen | Map | FlowCall

type Operation = (value: unknown) => unknown

const operations = new WeakMap<AndThen | Map, Operation>()
const flows = new WeakMap<FlowCall, unknown>()

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const functionIdentity = (operation: unknown): OperationIdentity => {
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
    digest: hex(sha256(metadata === undefined ? `${source}\0${ephemeral}` : `${source}\0${metadata.captures}`))
  }
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface Node<out A, out E = never> extends Pipeable.Pipeable {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
  }
  readonly ast: NodeAst
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const NodeProto = {
  [TypeId]: {
    _A: identity,
    _E: identity
  },
  pipe() {
    // eslint-disable-next-line prefer-rest-params
    return pipeArguments(this, arguments)
  }
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const makeNode = <A = unknown, E = never>(ast: NodeAst): Node<A, E> =>
  Object.assign(Object.create(NodeProto), { ast })

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const succeed = (value: unknown, annotations: Context.Context<never>): Succeed => ({
  _tag: "Succeed",
  value,
  annotations
})

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const all = (
  nodes: Readonly<Record<string, NodeAst>>,
  annotations: Context.Context<never>
): All => ({
  _tag: "All",
  nodes,
  annotations
})

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const dynamic = (
  options: Omit<Dynamic, "_tag" | "annotations">,
  annotations: Context.Context<never>
): Dynamic => ({
  _tag: "Dynamic",
  ...options,
  annotations
})

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const andThen = (
  first: NodeAst,
  operation: Operation,
  identitySource: unknown,
  annotations: Context.Context<never>
): AndThen => {
  const ast: AndThen = {
    _tag: "AndThen",
    first,
    continuation: functionIdentity(identitySource),
    annotations
  }
  operations.set(ast, operation)
  return ast
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const andThenNode = (
  first: NodeAst,
  next: NodeAst,
  annotations: Context.Context<never>
): AndThen => ({
  _tag: "AndThen",
  first,
  continuation: {
    _tag: "FunctionIdentity",
    algorithm: "static-node/v1",
    digest: hex(sha256("static-node"))
  },
  next,
  annotations
})

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const map = (
  first: NodeAst,
  operation: Operation,
  identitySource: unknown,
  annotations: Context.Context<never>
): Map => {
  const ast: Map = {
    _tag: "Map",
    first,
    mapper: functionIdentity(identitySource),
    annotations
  }
  operations.set(ast, operation)
  return ast
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const operation = (ast: AndThen | Map): Operation | undefined => operations.get(ast)

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const flowCall = (
  flow: unknown,
  target: unknown,
  input: unknown,
  annotations: Context.Context<never>
): FlowCall => {
  const ast: FlowCall = {
    _tag: "FlowCall",
    target,
    input,
    annotations
  }
  flows.set(ast, flow)
  return ast
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const flow = (ast: FlowCall): unknown => flows.get(ast)

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const withAnnotations = (
  ast: NodeAst,
  annotations: Context.Context<never>
): NodeAst => {
  const annotated = {
    ...ast,
    annotations
  }
  if (ast._tag === "AndThen" || ast._tag === "Map") {
    const deferred = operations.get(ast)
    if (deferred !== undefined) operations.set(annotated as AndThen | Map, deferred)
  }
  if (ast._tag === "FlowCall") {
    const target = flows.get(ast)
    if (target !== undefined) flows.set(annotated as FlowCall, target)
  }
  return annotated
}
