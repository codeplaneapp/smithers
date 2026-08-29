/**
 * Callable, schema-described flow declarations and their immutable combinators.
 *
 * Calling a flow constructs a `FlowCall` node. It never evaluates the flow
 * body; graph construction evaluates pure bodies at plan time.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Flow Builder Brief.md` and
 * `docs/specs/Concepts/Schema Shaped Builder.md`.
 *
 * @since 0.0.0
 */
import type * as Context from "effect/Context"
import { dual, identity } from "effect/Function"
import { type Pipeable, pipeArguments } from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import * as Annotations from "./Annotations.ts"
import * as Effects from "./Effects.ts"
import { flowCall, functionIdentity, makeNode } from "./internal/node.ts"
import * as Node from "./Node.ts"
import type * as Placement from "./Placement.ts"

/**
 * Runtime type identifier carried by flow values.
 *
 * @category type ids
 * @since 0.0.0
 * @slop
 */
export const TypeId: TypeId = "~flows/core/Flow"

/**
 * Type-level representation of the flow runtime type identifier.
 *
 * @category type ids
 * @since 0.0.0
 * @slop
 */
export type TypeId = "~flows/core/Flow"

/**
 * A callable flow declaration.
 *
 * The input schema is invariant because it participates in both decoding and
 * encoding. Output schemas and errors are covariant.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Flow<
  in out I extends Schema.Top,
  out O extends Schema.Top,
  out E = never
> extends Pipeable {
  (input: I["Type"]): Node.Node<O["Type"], E>
  readonly [TypeId]: {
    readonly _Input: Types.Invariant<I>
    readonly _Output: Types.Covariant<O>
    readonly _Error: Types.Covariant<E>
  }
  readonly input: I
  readonly output: O
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly annotations: Context.Context<never>
  readonly body: ((input: I["Type"]) => Node.Node<O["Type"], E>) | undefined
  readonly implementation: Implementation | undefined
}

/**
 * Marker-only existential type for heterogeneous collections of flows.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export interface Any {
  readonly [TypeId]: object
  readonly input: Schema.Top
  readonly output: Schema.Top
}

/**
 * A callable flow reference accepted by a dynamic flow.
 *
 * Module-authored flows pass callable flow values. Markdown loaders may pass
 * unresolved registry names, which the harness resolves before execution.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Reference = Any | string

/**
 * The name of a model seat a flow may run on.
 *
 * Seats are referred to by name, never by provider model id. The literal seat
 * names will be narrowed by the generated `flows.gen.ts` registry once that
 * codegen ships; until then this alias accepts any string while signalling
 * that the value is a seat name and not a model id.
 *
 * // TODO(flows.gen.ts): narrow to the generated seat-name union emitted by
 * // the `/fs` registry codegen, keeping `string & {}` as the escape
 * // hatch for seats declared outside the generated set.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Seat = string & {}

/**
 * Implementation identity included when a flow is used as a dynamic flow.
 *
 * The exact source is hashed with SHA-256. Unannotated bodies receive
 * process-local identity because JavaScript cannot inspect closure state.
 * Authors declare inert configuration with {@link Node.capture}, which folds
 * canonical capture data into deterministic identity.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Implementation =
  | {
    readonly _tag: "Body"
    readonly algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v3"
    readonly digest: string
  }
  | {
    readonly _tag: "Dynamic"
    readonly model: Seat | undefined
    readonly flows: ReadonlyArray<Reference>
    readonly prompt: string | undefined
  }

/**
 * Extracts the decoded input type of a flow.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Input<F> = F extends { readonly input: infer I extends Schema.Top } ? I["Type"] : never

/**
 * Extracts the decoded output type of a flow.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Output<F> = F extends { readonly output: infer O extends Schema.Top } ? O["Type"] : never

/**
 * Extracts the error type of a flow.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Error<F> = F extends Flow<infer _I, infer _O, infer E> ? E : never

/**
 * Stable code emitted by flow construction failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export const FlowErrorCode = Schema.Literals(["missing_body"])

/**
 * Stable code emitted by flow construction failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type FlowErrorCode = typeof FlowErrorCode.Type

/**
 * A typed flow construction failure.
 *
 * @category errors
 * @since 0.0.0
 * @slop
 */
export class FlowError extends Schema.TaggedError<FlowError>()("flows/core/FlowError", {
  code: FlowErrorCode,
  message: Schema.String
}) {}

interface MakeOptions<
  Input extends Schema.Top,
  Output extends Schema.Top,
  E
> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly input?: Input | undefined
  readonly output?: Output | undefined
  readonly capabilities?: ReadonlyArray<string> | undefined
  readonly effects?: Effects.Declaration | undefined
  readonly model?: Seat | undefined
  readonly flows?: ReadonlyArray<Reference> | undefined
  readonly prompt?: string | undefined
  readonly body?:
    | ((input: Types.NoInfer<Input["Type"]>) => Node.Node<Types.NoInfer<Output["Type"]>, E>)
    | undefined
}

interface FlowOptions<
  Input extends Schema.Top,
  Output extends Schema.Top,
  E
> {
  readonly name: string | undefined
  readonly description: string | undefined
  readonly input: Input
  readonly output: Output
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly annotations: Context.Context<never>
  readonly body: ((input: Input["Type"]) => Node.Node<Output["Type"], E>) | undefined
  readonly implementation: Implementation | undefined
}

const makeFlow = <
  Input extends Schema.Top,
  Output extends Schema.Top,
  E
>(options: FlowOptions<Input, Output, E>): Flow<Input, Output, E> => {
  const fn = (input: Input["Type"]): Node.Node<Output["Type"], E> => {
    if (options.body === undefined) {
      throw new FlowError({
        code: "missing_body",
        message: options.name === undefined
          ? "Cannot call a flow without a body"
          : `Cannot call flow "${options.name}" without a body`
      })
    }
    return makeNode(flowCall(self, { _tag: "FlowReference", name: options.name }, input, Annotations.empty))
  }
  Object.defineProperty(fn, "name", {
    value: options.name,
    enumerable: true,
    configurable: true
  })
  const self = Object.assign(fn, {
    [TypeId]: {
      _Input: identity,
      _Output: identity,
      _Error: identity
    },
    description: options.description,
    input: options.input,
    output: options.output,
    capabilities: options.capabilities,
    effects: options.effects,
    annotations: options.annotations,
    body: options.body,
    implementation: options.implementation,
    pipe() {
      // eslint-disable-next-line prefer-rest-params
      return pipeArguments(this, arguments)
    }
  }) as Flow<Input, Output, E>
  return self
}

const optionsFromFlow = <
  Input extends Schema.Top,
  Output extends Schema.Top,
  E
>(self: Flow<Input, Output, E>): FlowOptions<Input, Output, E> => ({
  name: self.name,
  description: self.description,
  input: self.input,
  output: self.output,
  capabilities: self.capabilities,
  effects: self.effects,
  annotations: self.annotations,
  body: self.body,
  implementation: self.implementation
})

/**
 * Returns `true` when a value is a `Flow`.
 *
 * @category guards
 * @since 0.0.0
 * @slop
 */
export const isFlow = (value: unknown): value is Any => Predicate.hasProperty(value, TypeId)

/**
 * Creates a callable flow from one schema-first options object.
 *
 * When `body` is omitted but `model` or `flows` is present, the body defaults
 * to one dynamic node. With neither, the flow remains declaration-only and
 * throws `FlowError` with code `missing_body` when called.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const make = <
  Input extends Schema.Top = typeof Schema.Void,
  Output extends Schema.Top = typeof Schema.Unknown,
  E = never
>(config: MakeOptions<Input, Output, E>): Flow<Input, Output, E> => {
  const input = (config.input ?? Schema.Void) as Input
  const output = (config.output ?? Schema.Unknown) as Output
  let body = config.body
  const bodyIdentity = body === undefined ? undefined : functionIdentity(body)
  let implementation: Implementation | undefined = bodyIdentity === undefined
    ? undefined
    : {
      _tag: "Body",
      algorithm: bodyIdentity.algorithm,
      digest: bodyIdentity.digest
    }
  if (body === undefined && (config.model !== undefined || config.flows !== undefined)) {
    body = () =>
      Node.dynamic({
        ...(config.model === undefined ? {} : { model: config.model }),
        ...(config.flows === undefined ? {} : { flows: config.flows }),
        output,
        ...(config.prompt === undefined ? {} : { prompt: config.prompt })
      })
    implementation = {
      _tag: "Dynamic",
      model: config.model,
      flows: config.flows ?? [],
      prompt: config.prompt
    }
  }
  return makeFlow({
    name: config.name,
    description: config.description,
    input,
    output,
    capabilities: config.capabilities ?? [],
    effects: config.effects,
    annotations: Annotations.empty,
    body,
    implementation
  })
}

/**
 * Alias for {@link make}. Agent flows are ordinary flows whose omitted body is
 * filled by their model or callable-flow declaration.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const agent: typeof make = make

/**
 * Adds capabilities to a flow, returning a fresh flow with sorted,
 * duplicate-free capabilities.
 *
 * @category combinators
 * @since 0.0.0
 * @slop
 */
export const withCapabilities: {
  (
    capabilities: ReadonlyArray<string>
  ): <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>
  ) => Flow<Input, Output, E>
  <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>,
    capabilities: ReadonlyArray<string>
  ): Flow<Input, Output, E>
} = dual(2, <Input extends Schema.Top, Output extends Schema.Top, E>(
  self: Flow<Input, Output, E>,
  capabilities: ReadonlyArray<string>
): Flow<Input, Output, E> =>
  makeFlow({
    ...optionsFromFlow(self),
    capabilities: [...new Set([...self.capabilities, ...capabilities])].sort()
  }))

/**
 * Places a flow within a host directive, returning a fresh flow.
 *
 * @category combinators
 * @since 0.0.0
 * @slop
 */
export const within: {
  (
    placement: Placement.Placement
  ): <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>
  ) => Flow<Input, Output, E>
  <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>,
    placement: Placement.Placement
  ): Flow<Input, Output, E>
} = dual(2, <Input extends Schema.Top, Output extends Schema.Top, E>(
  self: Flow<Input, Output, E>,
  placement: Placement.Placement
): Flow<Input, Output, E> =>
  makeFlow({
    ...optionsFromFlow(self),
    annotations: Annotations.add(self.annotations, Annotations.Placement, placement)
  }))

/**
 * Replaces a flow's effect declaration, returning a fresh flow.
 *
 * @category combinators
 * @since 0.0.0
 * @slop
 */
export const withEffects: {
  (
    declaration: Effects.Declaration
  ): <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>
  ) => Flow<Input, Output, E>
  <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>,
    declaration: Effects.Declaration
  ): Flow<Input, Output, E>
} = dual(2, <Input extends Schema.Top, Output extends Schema.Top, E>(
  self: Flow<Input, Output, E>,
  declaration: Effects.Declaration
): Flow<Input, Output, E> =>
  makeFlow({
    ...optionsFromFlow(self),
    effects: declaration
  }))

/**
 * Seals a flow's effect declaration, returning a fresh flow.
 *
 * @category combinators
 * @since 0.0.0
 * @slop
 */
export const sealed: {
  (): <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>
  ) => Flow<Input, Output, E>
  <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>
  ): Flow<Input, Output, E>
} = dual(
  (arguments_) => arguments_.length === 1,
  <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>
  ): Flow<Input, Output, E> =>
    makeFlow({
      ...optionsFromFlow(self),
      effects: self.effects === undefined
        ? Effects.make({
          reads: [],
          writes: [],
          mode: "hermetic",
          onConflict: "serialize",
          tier: "sealed"
        })
        : Effects.sealed(self.effects)
    })
)
