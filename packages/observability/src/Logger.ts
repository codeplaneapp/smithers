/**
 * Effect logger layers used by flows.
 *
 * @since 0.1.0
 */
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import type * as LogLevel from "effect/LogLevel"
import * as References from "effect/References"

/**
 * Options shared by the built-in logger layers.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly minimumLogLevel?: LogLevel.LogLevel | undefined
  readonly mergeWithExisting?: boolean | undefined
}

const withMinimumLogLevel = (layer: Layer.Layer<never>, minimumLogLevel: LogLevel.LogLevel): Layer.Layer<never> =>
  Layer.merge(layer, Layer.succeed(References.MinimumLogLevel, minimumLogLevel))

const optionsWithDefaults = (options?: Options): Required<Pick<Options, "minimumLogLevel" | "mergeWithExisting">> => ({
  minimumLogLevel: options?.minimumLogLevel ?? "Info",
  mergeWithExisting: options?.mergeWithExisting ?? false
})

/**
 * Provides a human-readable development logger.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerPrettyDev = (options?: Options): Layer.Layer<never> => {
  const resolved = optionsWithDefaults(options)
  return withMinimumLogLevel(
    Logger.layer([Logger.consolePretty({ colors: "auto", mode: "auto" })], {
      mergeWithExisting: resolved.mergeWithExisting
    }),
    resolved.minimumLogLevel as LogLevel.LogLevel
  )
}

/**
 * Provides one structured JSON object per log line.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerStructuredJson = (options?: Options): Layer.Layer<never> => {
  const resolved = optionsWithDefaults(options)
  return withMinimumLogLevel(
    Logger.layer([Logger.consoleJson], { mergeWithExisting: resolved.mergeWithExisting }),
    resolved.minimumLogLevel as LogLevel.LogLevel
  )
}

/**
 * Removes the active logger set while retaining Effect's minimum-level filter.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (options?: Pick<Options, "minimumLogLevel">): Layer.Layer<never> =>
  withMinimumLogLevel(
    Logger.layer([]),
    options?.minimumLogLevel ?? "None"
  )

/**
 * A logger layer that can be composed without requiring a runtime service.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (logger: Logger.Logger<unknown, unknown>, options?: Options): Layer.Layer<never> => {
  const resolved = optionsWithDefaults(options)
  return withMinimumLogLevel(
    Logger.layer([logger], { mergeWithExisting: resolved.mergeWithExisting }),
    resolved.minimumLogLevel as LogLevel.LogLevel
  )
}
