/**
 * Whether this CLI process owns the executor that settles accepted runs.
 *
 * @since 0.1.0
 */
import { Context, Layer } from "effect"

/**
 * Local production composition overrides this reference with `true`. Remote
 * clients and control-only test compositions keep the safe `false` default.
 *
 * @category references
 * @since 0.1.0
 * @slop
 */
export const ExecutorOwnership: Context.Reference<boolean> = Context.Reference<boolean>(
  "/cli/ExecutorOwnership",
  { defaultValue: () => false }
)

/**
 * Provides the executor-ownership fact for one command scope.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (ownsExecutor: boolean): Layer.Layer<never> => Layer.succeed(ExecutorOwnership, ownsExecutor)
