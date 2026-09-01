/**
 * Callable, schema-described flow declarations and their immutable combinators.
 *
 * Calling a flow constructs a `FlowCall` node. It never evaluates the flow
 * body; graph construction evaluates pure bodies at plan time.
 *
 * Governing contract: `packages/core/docs/api.md`, published as
 * https://smithers.sh/api/core.
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
  /**
   * Advisory model seat metadata recorded on the flow.
   *
   * @since 0.1.0
   */
  readonly model?: Seat | undefined
  /**
   * Advisory collaborator metadata recorded on the flow.
   *
   * @since 0.1.0
   */
  readonly flows?: ReadonlyArray<Reference> | undefined
  /**
   * Advisory prompt metadata recorded on the flow.
   *
   * @since 0.1.0
   */
  readonly prompt?: string | undefined
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
 * The seat, collaborator, and prompt declaration a body-backed flow records.
 *
 * A body-less flow turns the same three fields into its `Dynamic`
 * implementation. A flow with a body keeps its body digest as identity and
 * carries the declaration alongside it, so a decorator that changes the
 * declared seat or collaborators changes the flow's key material instead of
 * disappearing from it. Fields the author omitted are absent, so a flow that
 * declares none of them records no declaration and keys exactly as it did
 * before the field existed.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface BodyDeclaration {
  readonly model?: Seat | undefined
  readonly flows?: ReadonlyArray<Reference> | undefined
  readonly prompt?: string | undefined
}

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
    readonly declaration?: BodyDeclaration | undefined
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

/**
 * Configures schemas, metadata, effects, and implementation for {@link make}
 * and {@link agent}.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface MakeOptions<
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
  readonly model: Seat | undefined
  readonly flows: ReadonlyArray<Reference> | undefined
  readonly prompt: string | undefined
  readonly annotations: Context.Context<never>
  readonly body: ((input: Input["Type"]) => Node.Node<Output["Type"], E>) | undefined
  readonly implementation: Implementation | undefined
}

const makeFlow = <
  Input extends Schema.Top,
  Output extends Schema.Top,
  E
>(options: FlowOptions<Input, Output, E>): Flow<Input, Output, E> => {
  const fn = (() => (input: Input["Type"]): Node.Node<Output["Type"], E> => {
    if (options.body === undefined) {
      throw new FlowError({
        code: "missing_body",
        message: options.name === undefined
          ? "Cannot call a flow without a body"
          : `Cannot call flow "${options.name}" without a body`
      })
    }
    return makeNode(flowCall(self, { _tag: "FlowReference", name: options.name }, input, Annotations.empty))
  })()
  if (options.name !== undefined) {
    Object.defineProperty(fn, "name", {
      value: options.name,
      enumerable: false,
      configurable: true
    })
  }
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
    model: options.model,
    flows: options.flows,
    prompt: options.prompt,
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

/**
 * Builds the declaration recorded beside a body digest, or `undefined` when the
 * author declared no seat, collaborators, or prompt.
 */
const bodyDeclaration = (
  model: Seat | undefined,
  flows: ReadonlyArray<Reference> | undefined,
  prompt: string | undefined
): BodyDeclaration | undefined =>
  model === undefined && flows === undefined && prompt === undefined ? undefined : {
    ...(model === undefined ? {} : { model }),
    ...(flows === undefined ? {} : { flows: [...flows] }),
    ...(prompt === undefined ? {} : { prompt })
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
  model: self.model,
  flows: self.flows,
  prompt: self.prompt,
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
 * `model`, `flows`, and `prompt` are always recorded on the flow. On a flow
 * with a body they also form the `Body` implementation's
 * {@link BodyDeclaration}, so two flows sharing one body but declaring
 * different seats or collaborators are different steps; the body digest still
 * identifies the code that runs. When `body` is omitted and `model` or `flows`
 * is present, the same fields form the `Dynamic` implementation identity
 * instead and the body defaults to one dynamic node. With neither `model` nor
 * `flows`, the flow remains declaration-only and throws `FlowError` with code
 * `missing_body` when called.
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
  const flows = config.flows === undefined ? undefined : [...config.flows]
  let body = config.body
  const bodyIdentity = body === undefined ? undefined : functionIdentity(body)
  const declaration = bodyDeclaration(config.model, flows, config.prompt)
  let implementation: Implementation | undefined = bodyIdentity === undefined
    ? undefined
    : {
      _tag: "Body",
      algorithm: bodyIdentity.algorithm,
      digest: bodyIdentity.digest,
      ...(declaration === undefined ? {} : { declaration })
    }
  if (body === undefined && (config.model !== undefined || flows !== undefined)) {
    body = () =>
      Node.dynamic({
        ...(config.model === undefined ? {} : { model: config.model }),
        ...(flows === undefined ? {} : { flows }),
        output,
        ...(config.prompt === undefined ? {} : { prompt: config.prompt })
      })
    implementation = {
      _tag: "Dynamic",
      model: config.model,
      flows: flows ?? [],
      prompt: config.prompt
    }
  }
  return makeFlow({
    name: config.name,
    description: config.description,
    input,
    output,
    capabilities: [...new Set(config.capabilities ?? [])].sort(),
    effects: config.effects,
    model: config.model,
    flows,
    prompt: config.prompt,
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
 * Attaches one typed annotation to a flow, returning a fresh flow.
 *
 * Annotations are metadata a host or a decorator reads; they take no part in
 * flow identity, so an annotated flow plans the same graph as the flow it was
 * built from. {@link within} is the placement-shaped special case of this
 * combinator.
 *
 * @category combinators
 * @since 0.1.0
 */
export const annotate: {
  <I, S>(
    key: Context.Key<I, S>,
    value: S
  ): <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>
  ) => Flow<Input, Output, E>
  <Input extends Schema.Top, Output extends Schema.Top, E, I, S>(
    self: Flow<Input, Output, E>,
    key: Context.Key<I, S>,
    value: S
  ): Flow<Input, Output, E>
} = dual(3, <Input extends Schema.Top, Output extends Schema.Top, E, I, S>(
  self: Flow<Input, Output, E>,
  key: Context.Key<I, S>,
  value: S
): Flow<Input, Output, E> =>
  makeFlow({
    ...optionsFromFlow(self),
    annotations: Annotations.add(self.annotations, key, value)
  }))

/**
 * Replaces the collaborators a flow declares, returning a fresh flow.
 *
 * Everything else the flow carries comes across unchanged: its name, schemas,
 * capabilities, effects, and annotations. That is what lets a decorator rewrite
 * a flow tree without dropping the metadata a host reads back, such as a
 * placement or a lane. For a body-backed flow the body is untouched, so the
 * body digest still identifies the code that runs, and the new collaborators
 * replace the `Body` implementation's {@link BodyDeclaration}, so the change is
 * visible in key material. For a body-less dynamic flow, collaborators enter
 * identity through the `Dynamic` implementation, so both its default body and
 * implementation are rebuilt.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withFlows: {
  (
    flows: ReadonlyArray<Reference>
  ): <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>
  ) => Flow<Input, Output, E>
  <Input extends Schema.Top, Output extends Schema.Top, E>(
    self: Flow<Input, Output, E>,
    flows: ReadonlyArray<Reference>
  ): Flow<Input, Output, E>
} = dual(2, <Input extends Schema.Top, Output extends Schema.Top, E>(
  self: Flow<Input, Output, E>,
  flows: ReadonlyArray<Reference>
): Flow<Input, Output, E> => {
  const implementation = self.implementation
  if (implementation === undefined || implementation._tag !== "Dynamic") {
    return makeFlow({
      ...optionsFromFlow(self),
      flows,
      implementation: implementation === undefined
        ? undefined
        : { ...implementation, declaration: bodyDeclaration(self.model, flows, self.prompt) }
    })
  }
  return makeFlow({
    ...optionsFromFlow(self),
    flows,
    body: () =>
      Node.dynamic({
        ...(implementation.model === undefined ? {} : { model: implementation.model }),
        flows,
        output: self.output,
        ...(implementation.prompt === undefined ? {} : { prompt: implementation.prompt })
      }) as Node.Node<Output["Type"], E>,
    implementation: { _tag: "Dynamic", model: implementation.model, flows, prompt: implementation.prompt }
  })
})

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
