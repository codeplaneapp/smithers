/**
 * Bounded JSON configuration consumed and produced by the plugin kernel.
 *
 * Configuration is an extension namespace, not an engine-policy surface.
 * Durable retry, concurrency, and storage policy stay on their owning Effect
 * services and constructor options. Every accepted value is copied before any
 * plugin observes it, then frozen recursively.
 *
 * @since 1.0.0-rc.0
 */
import { isRecord } from "@smthrs/canonical/Record"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Boundary from "./internal/Boundary.ts"
import { PluginError } from "./PluginError.ts"

/**
 * Maximum encoded bytes accepted for one plugin configuration.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumConfigBytes = Boundary.defaultLimits.maxBytes

/**
 * Maximum nesting accepted for one plugin configuration.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumConfigDepth = Boundary.defaultLimits.maxDepth

/**
 * Maximum aggregate members accepted for one plugin configuration.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumConfigMembers = Boundary.defaultLimits.maxMembers

/**
 * Maximum aggregate values accepted for one plugin configuration.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumConfigNodes = Boundary.defaultLimits.maxNodes

/**
 * One value accepted in a plugin-owned configuration namespace.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ConfigValue = Schema.Json

/**
 * One value accepted in a plugin-owned configuration namespace.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ConfigValue = typeof ConfigValue.Type

/**
 * The pre-resolution configuration an application assembles.
 *
 * Keys name plugin-owned namespaces. `engine`, `retry`, `store`, and
 * `plugins` are refused because accepting those names would imply policy the
 * plugin kernel does not own or apply.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const FlowsConfig = Schema.Record(Schema.String, ConfigValue)

/**
 * The decoded form of {@link FlowsConfig}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type FlowsConfig = typeof FlowsConfig.Type

/**
 * The detached, recursively frozen configuration handed to plugins.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ResolvedConfig = Schema.Record(Schema.String, ConfigValue)

/**
 * The decoded form of {@link ResolvedConfig}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ResolvedConfig = typeof ResolvedConfig.Type

/**
 * Empty defaults. Engine policy is deliberately not defaulted here.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const defaults: ResolvedConfig = Object.freeze({})

const reservedRootKeys = new Set(["engine", "retry", "store", "plugins"])

const invalid = (path: string, complaint: string): PluginError =>
  new PluginError({
    code: "config_invalid",
    message: `plugin configuration ${complaint}`,
    path
  })

const snapshotRecord = (input: unknown): ResolvedConfig => {
  const admitted = Boundary.record(input)
  if (!admitted.ok) throw invalid(admitted.path, admitted.complaint)
  const record = admitted.value as Readonly<Record<string, ConfigValue>>
  for (const key of Object.keys(record)) {
    if (reservedRootKeys.has(key)) {
      throw invalid(`$.${key}`, "uses a runtime-policy key that the plugin kernel does not own")
    }
  }
  return record
}

const define = (target: Record<string, ConfigValue>, key: string, value: ConfigValue): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

const mergeRecords = (
  base: Readonly<Record<string, ConfigValue>>,
  patch: Readonly<Record<string, ConfigValue>>
): Readonly<Record<string, ConfigValue>> => {
  const result: Record<string, ConfigValue> = {}
  for (const key of Object.keys(base)) define(result, key, base[key]!)
  for (const key of Object.keys(patch)) {
    const previous = result[key]
    const next = patch[key]!
    define(
      result,
      key,
      previous !== undefined && isRecord(previous) && isRecord(next) ? mergeRecords(previous, next) : next
    )
  }
  return Object.freeze(result)
}

/**
 * Copies and deep-merges a configuration patch over a base configuration.
 *
 * Records merge key-by-key and every other JSON value replaces wholesale.
 * Both operands and the merged output are admitted, so unsafe property names,
 * accessors, cycles, exotic prototypes, and aggregate values outside the
 * resource limits fail with `config_invalid`.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const merge = (base: FlowsConfig, patch: unknown): FlowsConfig => {
  const safeBase = snapshotRecord(base)
  if (patch === undefined) return safeBase
  const safePatch = snapshotRecord(patch)
  return snapshotRecord(mergeRecords(safeBase, safePatch))
}

/**
 * Copies and freezes one JSON value without retaining caller-owned objects.
 *
 * @category utils
 * @since 1.0.0-rc.0
 */
export const deepFreeze = <A extends ConfigValue>(value: A): A => {
  const admitted = Boundary.admit(value)
  if (!admitted.ok) throw invalid(admitted.path, admitted.complaint)
  return admitted.value as A
}

/**
 * Admits a raw pre-resolution configuration as an immutable snapshot.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const snapshot = (config: unknown): Effect.Effect<FlowsConfig, PluginError> =>
  Effect.try({ try: () => snapshotRecord(config), catch: (cause) => cause as PluginError })

/**
 * Decodes the post-waterfall configuration into its final immutable form.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const resolve = (config: unknown): Effect.Effect<ResolvedConfig, PluginError> => snapshot(config)
