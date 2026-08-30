/**
 * Startup: resolve the plugin list, run the config pipeline, hand back a
 * dispatcher, a frozen config, and the merged layer.
 *
 * Governing contract: D11 in `docs/pages/design-decisions.md`, with the
 * shipped host catalog in `packages/agent/src/CellPlugin.ts`. This
 * startup composes the bounded cell-host extension point; it does not install
 * lifecycle hooks into the durable engine.
 *
 * Order of operations, per the spec:
 *
 * 1. flatten / filter / validate / order the plugin list;
 * 2. `config` waterfall — each plugin may return a partial to deep-merge;
 * 3. decode and freeze into a `ResolvedConfig` (`config_invalid` on failure);
 * 4. `configResolved` parallel — observers capture the final config;
 * 5. plugin `layer`s merge left-to-right.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type { FlowsConfig, ResolvedConfig } from "./Config.ts"
import * as Config from "./Config.ts"
import type { FlowsHooks } from "./index.ts"
import type { PluginInput } from "./Plugin.ts"
import type { PluginError } from "./PluginError.ts"
import * as Plugins from "./Plugins.ts"
import * as Resolve from "./Resolve.ts"

/**
 * Everything startup produces from a plugin list and a raw config.
 *
 * `observerErrors` carries `configResolved` failures: parallel observers are
 * lossy by contract, so they are reported rather than fatal.
 *
 * @category models
 * @since 0.1.0
 */
export interface Kernel<H = FlowsHooks> {
  readonly plugins: Plugins.Service<H>
  readonly config: ResolvedConfig
  readonly layer: Layer.Layer<any, PluginError, any>
  readonly observerErrors: ReadonlyArray<PluginError>
}

/**
 * Runs the `config` waterfall and produces the frozen `ResolvedConfig`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const runConfig = <H = FlowsHooks>(
  plugins: Plugins.Service<H>,
  config: FlowsConfig
): Effect.Effect<ResolvedConfig, PluginError> =>
  (plugins.waterfall as unknown as (
    hook: string,
    initial: FlowsConfig,
    merge: (previous: FlowsConfig, patch: unknown) => FlowsConfig
  ) => Effect.Effect<FlowsConfig, PluginError>)("config", config, Config.merge).pipe(
    Effect.flatMap(Config.resolve)
  )

/**
 * Resolves plugins, executes the config pipeline, and merges plugin layers.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <H = FlowsHooks>(
  input: PluginInput<NoInfer<H>>,
  config: FlowsConfig = {},
  options: Resolve.Options = {}
): Effect.Effect<Kernel<H>, PluginError> =>
  Effect.gen(function*() {
    const resolved = yield* Resolve.resolve<H>(input, { ...options, config })
    const dispatcher = Plugins.make<H>(resolved)
    const frozen = yield* runConfig(dispatcher, config)
    const observerErrors = yield* (dispatcher.parallel as unknown as (
      hook: string,
      value: ResolvedConfig
    ) => Effect.Effect<ReadonlyArray<PluginError>>)("configResolved", frozen)
    return {
      plugins: dispatcher,
      config: frozen,
      layer: Resolve.layer(resolved, options.cacheEnvironment),
      observerErrors
    }
  })
