/**
 * Engine step-key cache decoration.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import * as Pattern from "./Pattern.ts"
import { PatternError } from "./PatternError.ts"

/**
 * How far a recorded sealed result may travel.
 *
 * `shared` is the content-addressed default: the step key names the inputs and
 * the environment, so any run that would have produced the same bytes may
 * reuse the row. `run` and `flow` narrow that on purpose, for a step whose
 * result is only meaningful inside one execution or inside one flow.
 *
 * The three levels are the old `run | workflow | global` policy named after the
 * current concepts, and they match
 * `@smthrs/flow/CacheEnvironment` `CacheScope`, which is what the engine reads
 * at dispatch.
 *
 * @category models
 * @since 0.1.0
 */
export type Scope = "run" | "flow" | "shared"

/**
 * The cache policy a wrapper declares: how long a recorded result may be
 * served, how far it may travel, and which revision of the body produced it.
 *
 * Every field is optional and every default is the pre-policy behavior: no age
 * bound, the reach the composition already granted, and no extra revision in
 * the key. All three are declaration identity: a wrapper that declares a
 * different policy is a different declaration, so a plan cannot silently reuse
 * a row recorded under another one.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Milliseconds a recorded result stays servable, counted from when it was
   * recorded. Past it the engine dispatches again and journals the expiry.
   */
  readonly ttlMs?: number | undefined
  /** How far the recorded result may travel. */
  readonly scope?: Scope | undefined
  /**
   * The caller's revision of the wrapped body. Changing it is how a caller
   * invalidates rows whose inputs did not change but whose meaning did.
   */
  readonly version?: string | undefined
}

/**
 * The durable half of {@link Options}: the two fields the engine acts on at
 * dispatch. `version` is absent because it is declaration identity, not a
 * dispatch instruction: it changes the key the step is addressed by and
 * nothing else.
 *
 * @category models
 * @since 0.1.0
 */
export interface Policy {
  readonly ttlMs?: number | undefined
  readonly scope?: Scope | undefined
}

/**
 * Annotation key carrying a declaration's {@link Policy}.
 *
 * The IDENTIFIER is the contract. `@smthrs/engine-store` reads the policy at
 * dispatch through `@smthrs/flow`'s `CacheEnvironment.CachePolicyAnnotation`,
 * which is the same key under the same identifier; a bag this module writes is
 * one that module reads. The key is declared twice rather than imported
 * because `@smthrs/patterns` composes over `@smthrs/core` alone and
 * `@smthrs/flow` does not depend on either, so neither package can import the
 * other. `packages/smithers/flows/patterns/test/WithCache.test.ts` pins the two halves
 * together: it reads a wrapper's annotations back with `@smthrs/flow`'s reader,
 * and fails the moment the identifiers drift.
 *
 * @category annotations
 * @since 0.1.0
 */
export const CachePolicyAnnotation = Context.Service<Policy>("@smthrs/flow/Action/CachePolicy")

/**
 * The policy an annotation bag carries, or `undefined` when it carries none.
 *
 * @category getters
 * @since 0.1.0
 */
export const policyOf = (annotations: Context.Context<never>): Policy | undefined =>
  Option.getOrUndefined(Context.getOption(annotations, CachePolicyAnnotation))

/**
 * The durable fields of a declared policy, or `undefined` when the caller
 * declared neither. An options object carrying only `version` annotates
 * nothing, because there is nothing for the engine to do with it beyond the
 * key it already changed.
 *
 * @since 0.1.0
 * @private
 */
const durable = (options: Options): Policy | undefined =>
  options.ttlMs === undefined && options.scope === undefined ? undefined : {
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.scope === undefined ? {} : { scope: options.scope })
  }

/**
 * The declared fields, in a fixed order, as `field=value` pairs. Fixed so two
 * callers writing the same policy in a different object order declare the same
 * wrapper.
 *
 * @since 0.1.0
 * @private
 */
const declaredFields = (options: Options): ReadonlyArray<string> => {
  const fields: Array<string> = []
  if (options.ttlMs !== undefined) fields.push(`ttlMs=${options.ttlMs}`)
  if (options.scope !== undefined) fields.push(`scope=${options.scope}`)
  if (options.version !== undefined) fields.push(`version=${options.version}`)
  return fields
}

/**
 * The captured policy, carrying only the fields the caller declared, so an
 * undeclared policy captures exactly what it captured before the policy
 * existed.
 *
 * @since 0.1.0
 * @private
 */
const captured = (options: Options): Readonly<Record<string, unknown>> => ({
  ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  ...(options.scope === undefined ? {} : { scope: options.scope }),
  ...(options.version === undefined ? {} : { version: options.version })
})

const validate = (options: Options): void => {
  if (
    options.ttlMs !== undefined &&
    (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1)
  ) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `withCache ttlMs must be a positive safe integer, received ${options.ttlMs}`
    })
  }
  if (options.version !== undefined && options.version.trim() === "") {
    throw new PatternError({
      code: "invalid_decorator",
      message: "withCache version must name a revision, not blank text"
    })
  }
}

/**
 * Attaches a policy to a flow without disturbing its declaration.
 *
 * @since 0.1.0
 * @private
 */
const annotated = (flow: Flow.Any, policy: Policy): Flow.Any =>
  Flow.annotate(flow as unknown as Flow.Flow<Schema.Top, Schema.Top, unknown>, CachePolicyAnnotation, policy)

const declaration = (inner: Flow.Any, options: Options): Flow.Any => {
  validate(options)
  const details = Compose.details(inner)
  const effects = details.effects
  if (
    effects === undefined ||
    effects.mode !== "hermetic" ||
    (effects.tier !== undefined && effects.tier !== "sealed")
  ) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "withCache requires an explicitly hermetic, sealed flow"
    })
  }
  const fields = declaredFields(options)
  const wrapper = Flow.make({
    name: `withCache(${Compose.displayName(inner)}${fields.length === 0 ? "" : `, ${fields.join(", ")}`})`,
    description: details.description,
    input: details.input,
    output: details.output,
    capabilities: details.capabilities,
    effects,
    flows: [inner],
    body: Node.capture(captured(options), (input) => Compose.call(inner, input))
  })
  const policy = durable(options)
  // The policy travels twice, because it does two different jobs. In the
  // capture it is declaration identity, so a changed policy is a changed step
  // key. In the annotation it is an instruction the engine executes at
  // dispatch: `@smthrs/engine-store` bounds the age of the row it may serve by
  // `ttlMs` and narrows the digest it is addressed by from `scope`. Without the
  // annotation the wrapper renames itself and nothing else happens.
  return policy === undefined ? wrapper : annotated(wrapper, policy)
}

/**
 * Builds a sealed step-key cache decorator carrying an optional policy.
 *
 * The decorator both renames the wrapper (declaration identity) and attaches
 * the policy under {@link CachePolicyAnnotation}, which is the key
 * `@smthrs/engine-store` reads at dispatch. Compose it through
 * {@link withCache} rather than `Pattern.decorate` directly: the decoration
 * seam redeclares the wrapper and does not carry an annotation bag across, so
 * `withCache` reapplies the policy after it.
 *
 * `make` snapshots the options at the call, so a later edit to the caller's
 * object does not change the decorator it returned.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options = {}): Pattern.Decorator => {
  // The decorator is applied later than this call, so it reads this snapshot
  // and never the caller's options again.
  const snapshot: Options = { ttlMs: options.ttlMs, scope: options.scope, version: options.version }
  return (inner) => declaration(inner, snapshot)
}

/**
 * Marks a sealable wrapper for engine step-key caching, optionally declaring
 * the time to live, the scope, and the version the engine dispatches under.
 *
 * Reuse remains an engine concern; this decorator allocates no map and keeps no
 * process-local state. The policy travels twice. As declaration identity it
 * renames the wrapper and enters its captured key material, so a changed policy
 * is a changed declaration. As a {@link CachePolicyAnnotation} it reaches the
 * dispatch, where `@smthrs/engine-store` bounds the age of the row it may serve
 * by `ttlMs` and narrows the digest the row is addressed by from `scope`. The
 * annotation key is `@smthrs/flow/CacheEnvironment`\'s `CachePolicyAnnotation`
 * under its own identifier; `version` stays identity only, because changing the
 * key is the whole of what it asks for.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withCache = (inner: Flow.Any, options?: Options | undefined): Flow.Any => {
  const declared = options ?? {}
  const sealed = Compose.seal(Pattern.decorate(inner, make(declared)))
  const policy = durable(declared)
  // Re-applied after the decoration seam, not only inside it. `Pattern.decorate`
  // redeclares the wrapper as a fresh flow and carries its name, schemas,
  // capabilities, and effects across, but not its annotation bag, so a policy
  // attached by the decorator alone would reach the plan and never the
  // dispatch. Applying it here is idempotent with the decorator's own
  // annotation: both write the same value under the same key.
  return policy === undefined ? sealed : annotated(sealed, policy)
}
