/**
 * The one canonical JSON encoder both serializers use.
 *
 * A report embeds the raw output of an arbitrary target flow, so the value
 * being serialized is not JSON and cannot be assumed to be finite, acyclic, or
 * even readable. A recursive walker over `JSON.stringify` answered that with a
 * `RangeError` thrown out of a function typed `string`. This encoder is total
 * instead: every shape JSON cannot express is replaced by a marker that names
 * what was there, so a report of a broken run is still a report.
 *
 * @since 0.1.0
 */

/**
 * The nesting depth beyond which a value is replaced by a marker.
 *
 * @since 0.1.0
 * @private
 */
export const maxDepth = 64

/**
 * Default cap on an embedded string, in UTF-16 code units.
 *
 * @since 0.1.0
 * @private
 */
export const maxStringLength = 8192

/**
 * Options accepted by {@link encode}.
 *
 * @since 0.1.0
 * @private
 */
export interface Options {
  /** Cap on embedded strings; `undefined` keeps them whole. */
  readonly maxStringLength?: number | undefined
}

/**
 * Orders keys by UTF-16 code unit, never by locale.
 *
 * @since 0.1.0
 * @private
 */
export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const truncate = (value: string, limit: number | undefined): string =>
  limit === undefined || value.length <= limit
    ? value
    : `${value.slice(0, limit)}[truncated ${value.length - limit} chars]`

const primitive = (value: unknown, options: Options): unknown => {
  if (typeof value === "string") return truncate(value, options.maxStringLength)
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "[NaN]"
    if (value === Number.POSITIVE_INFINITY) return "[Infinity]"
    if (value === Number.NEGATIVE_INFINITY) return "[-Infinity]"
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === "bigint") return `[bigint ${value}]`
  if (typeof value === "function") return "[function]"
  if (typeof value === "symbol") return "[symbol]"
  return value
}

const unreadable = (cause: unknown): string => {
  try {
    return `[unreadable: ${String(cause)}]`
  } catch {
    return "[unreadable]"
  }
}

const entriesOf = (value: object): ReadonlyArray<readonly [string, unknown]> =>
  Object.keys(value).map((key) => {
    try {
      return [key, (value as { readonly [key: string]: unknown })[key]] as const
    } catch (cause) {
      return [key, unreadable(cause)] as const
    }
  })

const objectOf = (
  entries: ReadonlyArray<readonly [string, unknown]>,
  depth: number,
  seen: Set<object>,
  options: Options
): object =>
  Object.fromEntries(
    entries
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, walk(entry, depth + 1, seen, options)])
  )

const walk = (value: unknown, depth: number, seen: Set<object>, options: Options): unknown => {
  if (value === null || typeof value !== "object") return primitive(value, options)
  if (seen.has(value)) return "[circular]"
  if (depth > maxDepth) return "[depth exceeded]"
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[invalid Date]" : value.toISOString()
    seen.add(value)
    try {
      if (value instanceof Error) {
        const properties = new Map(entriesOf(value))
        properties.set("name", String(value.name))
        properties.set("message", String(value.message))
        return objectOf([...properties], depth, seen, options)
      }
      if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1, seen, options))
      if (value instanceof Set) return [...value].map((entry) => walk(entry, depth + 1, seen, options))
      if (value instanceof Map) {
        return [...value.entries()]
          .map(([key, entry]) => [walk(key, depth + 1, seen, options), walk(entry, depth + 1, seen, options)])
      }
      return objectOf(entriesOf(value), depth, seen, options)
    } finally {
      seen.delete(value)
    }
  } catch (cause) {
    return unreadable(cause)
  }
}

/**
 * Rewrites a value into a shape `JSON.stringify` renders deterministically.
 *
 * Object keys are sorted by code unit, `-0` becomes `0`, and `undefined`
 * members are dropped. Everything JSON cannot express becomes a bracketed
 * marker rather than a throw or a silent `null`: `[circular]`,
 * `[depth exceeded]`, `[NaN]`, `[Infinity]`, `[-Infinity]`, `[bigint n]`,
 * `[function]`, `[symbol]`, and `[unreadable: …]` when a foreign operation
 * throws. An `Error` becomes an object containing its own enumerable fields
 * plus `name` and `message`, so typed error fields survive serialization. A
 * `Date` becomes its ISO string, a `Set` an array, and a `Map` an array of
 * key/value pairs.
 *
 * @since 0.1.0
 * @private
 */
export const encode = (value: unknown, options: Options = {}): unknown => walk(value, 0, new Set<object>(), options)

/**
 * Serializes a value as canonical JSON with a trailing newline.
 *
 * @since 0.1.0
 * @private
 */
export const stringify = (value: unknown, options: Options = {}): string =>
  `${JSON.stringify(encode(value, options))}\n`
