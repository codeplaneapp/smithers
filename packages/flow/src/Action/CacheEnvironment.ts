// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The environment description folded into every cross-run cache key.
 *
 * A cached result is only reusable on a host that would have produced the same
 * bytes, so the key has to name the environment as well as the inputs — the
 * platform, the toolchain, and the capability groups in force. Bazel's action
 * key does the same thing for the same reason.
 *
 * It is a *complete* value on purpose: an environment a composition cannot
 * fully describe is one whose cache hits cannot be justified, and the engine
 * executes rather than guessing at the missing part.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Validates named capability groups.
 *
 * @private
 * @since 0.1.0
 */
const Capabilities = Schema.Record(Schema.String, Schema.Array(Schema.NonEmptyString)).check(
  Schema.makeFilter((capabilities) =>
    Object.keys(capabilities).every((name) => name.length > 0) || "Capability names must not be empty"
  )
)

/**
 * Complete runtime environment included in every cross-run cache key.
 *
 * If a composition cannot provide this complete value, the engine executes
 * normally but does not derive a cross-run cache key.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type CacheEnvironment = typeof CacheEnvironment.Type

/**
 * Schema for the complete runtime environment included in cache keys.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const CacheEnvironment = Schema.Struct({
  /** Ordered semantic runtime layers, including versions and configuration. */
  layers: Schema.Array(Schema.NonEmptyString),
  /** Complete effective capability groups. */
  capabilities: Capabilities
})
