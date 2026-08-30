/**
 * Configuration shapes consumed and produced by the plugin kernel.
 *
 * Governing contract: D11 in `docs/pages/design-decisions.md`. These
 * schemas are the bounded configuration lifecycle owned by the shared plugin
 * kernel and consumed by the assembled cell host in `@smthrs/agent`.
 * They are not placeholders for later durable-engine wiring: engine policy
 * remains on its Effect service and constructor-option seams.
 *
 * A `FlowsConfig` is threaded through the `config` waterfall, decoded,
 * defaulted, and frozen into the `ResolvedConfig` for that host composition.
 *
 * `plugins` is typed `unknown` on purpose. The plugin list lives on the config
 * the application assembles, but typing it as `PluginInput` here would make
 * `Config` depend on `Plugin`, which depends on `Hooks`, which depends on
 * `Config`. The kernel never reads `plugins` off a config value.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PluginError } from "./PluginError.ts"

/**
 * Retry-shaped defaults carried through the shared plugin config pipeline.
 *
 * @category models
 * @since 0.1.0
 */
export const RetryConfig = Schema.Struct({
  maxAttempts: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  initialDelayMs: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  backoffCoefficient: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  maxDelayMs: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))
})
/**
 * The decoded form of {@link RetryConfig}.
 *
 * @category models
 * @since 0.1.0
 */
export type RetryConfig = typeof RetryConfig.Type

/**
 * Engine-level knobs.
 *
 * @category models
 * @since 0.1.0
 */
export const EngineConfig = Schema.Struct({
  maxConcurrency: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
})
/**
 * The decoded form of {@link EngineConfig}.
 *
 * @category models
 * @since 0.1.0
 */
export type EngineConfig = typeof EngineConfig.Type

/**
 * The pre-resolution configuration an application assembles.
 *
 * @category models
 * @since 0.1.0
 */
export const FlowsConfig = Schema.StructWithRest(
  Schema.Struct({
    plugins: Schema.optionalKey(Schema.Unknown),
    retry: Schema.optionalKey(RetryConfig),
    engine: Schema.optionalKey(EngineConfig),
    store: Schema.optionalKey(Schema.Struct({ url: Schema.optionalKey(Schema.String) }))
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
/**
 * The decoded form of {@link FlowsConfig}.
 *
 * @category models
 * @since 0.1.0
 */
export type FlowsConfig = typeof FlowsConfig.Type

/**
 * The frozen configuration handed to `configResolved` and to the engine.
 *
 * @category models
 * @since 0.1.0
 */
export const ResolvedConfig = Schema.StructWithRest(
  Schema.Struct({
    retry: Schema.Struct({
      maxAttempts: Schema.Int.check(Schema.isGreaterThan(0)),
      initialDelayMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      backoffCoefficient: Schema.Finite.check(Schema.isGreaterThan(0)),
      maxDelayMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
    }),
    engine: Schema.Struct({ maxConcurrency: Schema.Int.check(Schema.isGreaterThan(0)) }),
    store: Schema.Struct({ url: Schema.optionalKey(Schema.String) })
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
/**
 * The decoded form of {@link ResolvedConfig}.
 *
 * @category models
 * @since 0.1.0
 */
export type ResolvedConfig = typeof ResolvedConfig.Type

/**
 * Defaults applied after the `config` waterfall and before freezing.
 *
 * @category models
 * @since 0.1.0
 */
export const defaults: ResolvedConfig = Object.freeze({
  retry: Object.freeze({
    maxAttempts: 3,
    initialDelayMs: 1_000,
    backoffCoefficient: 2,
    maxDelayMs: 60_000
  }),
  engine: Object.freeze({ maxConcurrency: 16 }),
  store: Object.freeze({})
})

/** @private */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Deep-merges a partial configuration patch over a base configuration.
 *
 * Plain objects merge key-by-key; every other value (including arrays)
 * replaces wholesale. `undefined` never clobbers a present value.
 *
 * @category combinators
 * @since 0.1.0
 */
export const merge = <A>(base: A, patch: unknown): A => {
  if (patch === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as A
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(patch)) {
    const next = patch[key]
    if (next === undefined) continue
    result[key] = isPlainObject(result[key]) && isPlainObject(next) ? merge(result[key], next) : next
  }
  return result as A
}

/**
 * Decodes a post-waterfall configuration, applies defaults, and deep-freezes
 * the result.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolve = (config: FlowsConfig): Effect.Effect<ResolvedConfig, PluginError> =>
  Schema.decodeUnknownEffect(FlowsConfig)(config).pipe(
    Effect.mapError((cause) =>
      new PluginError({ code: "config_invalid", message: "post-waterfall config failed decoding", cause })
    ),
    Effect.map((decoded) => {
      const { plugins: _, ...resolved } = decoded
      return deepFreeze(merge(defaults, resolved))
    })
  )

/**
 * Recursively freezes a value's own enumerable object properties.
 *
 * @category utils
 * @since 0.1.0
 */
export const deepFreeze = <A>(value: A): A => {
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return typeof value === "object" && value !== null ? Object.freeze(value) : value
}
