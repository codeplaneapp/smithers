/**
 * The bounded cell-host plugin kernel: typed hooks, resolution and ordering,
 * and the config pipeline.
 *
 * The public package contract is documented at
 * {@link https://smithers.sh/api/plugin}, with the shipped host catalog in
 * `packages/agent/src/CellPlugin.ts`. Durable
 * engine extension remains dependency injection; this package does not expose
 * an engine-wide lifecycle registry.
 *
 * @since 1.0.0-rc.0
 */

import type * as Effect from "effect/Effect"
import type { FlowsConfig, ResolvedConfig } from "./Config.ts"
import type { ParallelHook, WaterfallHook } from "./Hooks.ts"

/**
 * The shared kernel's base hook catalog.
 *
 * Declared here, in the package entry point, so that the documented
 * augmentation specifier works: an interface can only be augmented in the
 * module that declares it:
 *
 * ```ts
 * declare module "@smthrs/plugin" {
 *   interface FlowsHooks {
 *     toolCall: SequentialHook<(ctx: ToolCallContext) => Effect.Effect<Option.Option<ToolOverride>>>
 *   }
 * }
 * ```
 *
 * Closed for dispatch, open for augmentation: the kernel dispatches only the
 * config lifecycle below; a host supplies and dispatches its own catalog over
 * the same augmented interface.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface FlowsHooks {
  readonly config: WaterfallHook<(config: FlowsConfig) => Effect.Effect<Partial<FlowsConfig> | void, any, any>>
  readonly configResolved: ParallelHook<(config: ResolvedConfig) => Effect.Effect<void, any, any>>
}

/**
 * @since 1.0.0-rc.0
 * @category config
 */
export * as Config from "./Config.ts"

/**
 * @since 1.0.0-rc.0
 * @category hooks
 */
export * from "./Hooks.ts"

/**
 * @since 1.0.0-rc.0
 * @category startup
 */
export * as Kernel from "./Kernel.ts"

/**
 * @since 1.0.0-rc.0
 * @category models
 */
export * from "./Plugin.ts"

/**
 * @since 1.0.0-rc.0
 * @category errors
 */
export * from "./PluginError.ts"

/**
 * @since 1.0.0-rc.0
 * @category dispatch
 */
export * as Plugins from "./Plugins.ts"

/**
 * @since 1.0.0-rc.0
 * @category resolution
 */
export * as Resolve from "./Resolve.ts"
