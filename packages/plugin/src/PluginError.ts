/**
 * The single typed failure of the plugin kernel.
 *
 * Governing contract: D11 in `docs/pages/design-decisions.md`. These
 * failures cover bounded plugin resolution, configuration, layer composition,
 * and host-owned hook dispatch; they are not durable-engine lifecycle errors.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Closed set of plugin-system failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export const PluginErrorCode = Schema.Literals([
  "duplicate_name",
  "unknown_hook",
  "config_invalid",
  "hook_failed",
  "layer_failed"
])

/**
 * Closed set of plugin-system failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export type PluginErrorCode = typeof PluginErrorCode.Type

/**
 * Failure raised by plugin resolution, hook dispatch, config execution, or
 * layer construction.
 *
 * Parallel observer failures never fail the caller; they are returned from
 * `Plugins.parallel` with this same shape so they can be journalled on the
 * lossy telemetry channel.
 *
 * @category errors
 * @since 0.1.0
 */
export class PluginError extends Schema.TaggedError<PluginError>()("flows/plugin/PluginError", {
  code: PluginErrorCode,
  message: Schema.String,
  plugin: Schema.optional(Schema.String),
  hook: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown)
}) {}
