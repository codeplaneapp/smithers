/**
 * The plugin object: a plain record produced by a factory function.
 *
 * Governing contract: D11 in `docs/pages/design-decisions.md`. The
 * shipped consumer is the assembled cell host in `@smthrs/agent`;
 * durable-core policy continues to use Effect services and constructor
 * options rather than plugin lifecycle hooks.
 *
 * @since 0.1.0
 */
import type * as Layer from "effect/Layer"
import type { FlowsConfig } from "./Config.ts"
import type { FlowsHooks } from "./index.ts"

/**
 * Conditional-inclusion predicate, mirroring Vite's `apply`.
 *
 * `"engine"` and `"harness"` select the matching plugin-kernel host. The D11
 * cell host resolves as `"harness"`; this does not make `"engine"` an
 * engine-lifecycle hook registration.
 *
 * @category models
 * @since 0.1.0
 */
export type Apply = "engine" | "harness" | ((config: FlowsConfig) => boolean)

/**
 * A flows plugin.
 *
 * Generic over the hook interface so a harness can hold plugins typed against
 * its augmented `FlowsHooks` without any inheritance machinery.
 *
 * @category models
 * @since 0.1.0
 */
export interface FlowsPlugin<H = FlowsHooks> {
  /** Required, unique. Convention: `flows-plugin-<thing>`. */
  readonly name: string
  /** Ordering group; omitted means `"normal"`. */
  readonly enforce?: "pre" | "post" | undefined
  /** Conditional inclusion. */
  readonly apply?: Apply | undefined
  /** Services this plugin contributes to the engine environment. */
  readonly layer?: Layer.Layer<never, any, any> | undefined
  /** Typed hooks; only keys declared in the hook interface compile. */
  readonly hooks?: Partial<H> | undefined
}

/**
 * What a `plugins` array may contain: plugins, falsy entries, and arbitrarily
 * nested arrays — so a preset is just a function returning plugins.
 *
 * @category models
 * @since 0.1.0
 */
export type PluginInput<H = FlowsHooks> =
  | FlowsPlugin<H>
  | false
  | null
  | undefined
  | ReadonlyArray<PluginInput<H>>

/**
 * Identity constructor that pins a plugin literal to `FlowsPlugin` so excess
 * hook keys are rejected at the definition site.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <H = FlowsHooks>(plugin: FlowsPlugin<H>): FlowsPlugin<H> => plugin
