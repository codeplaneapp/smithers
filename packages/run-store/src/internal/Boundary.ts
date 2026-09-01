/**
 * Inert text and JSON admission for values crossing run-store boundaries.
 *
 * @since 1.0.0-rc.0
 * @private
 */

/**
 * Maximum UTF-16 length of one durable identifier.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const maximumIdentifierLength = 1_024

/**
 * Resource limits for one admitted JSON tree.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface JsonLimits {
  readonly maxBytes: number
  readonly maxDepth: number
  readonly maxMembers: number
  readonly maxNodes: number
  readonly maxStringBytes: number
  readonly maxKeyBytes: number
}

/**
 * Detached JSON value accepted by the persistence boundary.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/**
 * Result of admitting or refusing an unknown JSON candidate.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type JsonResult =
  | { readonly ok: true; readonly value: Json; readonly bytes: number }
  | { readonly ok: false; readonly complaint: string }

/**
 * Whether text has a complete UTF-16 encoding and contains no NUL.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const isDurableText = (value: unknown, maximum = maximumIdentifierLength): value is string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) return false
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/** Encoded JSON-string bytes without allocating an encoded copy. */
const stringBytes = (value: string, maximum: number): number | undefined => {
  let bytes = 2
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return undefined
      bytes += 4
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return undefined
    else if (unit === 0x22 || unit === 0x5c) bytes += 2
    else if (unit <= 0x1f) bytes += 6
    else if (unit <= 0x7f) bytes++
    else if (unit <= 0x7ff) bytes += 2
    else bytes += 3
    if (bytes > maximum) return undefined
  }
  return bytes
}

/**
 * Copies a JSON tree without invoking getters or `toJSON`, under explicit
 * byte, depth, node, and member limits.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const admitJson = (input: unknown, limits: JsonLimits): JsonResult => {
  let bytes = 0
  let nodes = 0
  let members = 0
  const active = new WeakSet<object>()
  const refuse = (complaint: string): JsonResult => ({ ok: false, complaint })
  const add = (count: number): boolean => {
    bytes += count
    return Number.isSafeInteger(bytes) && bytes <= limits.maxBytes
  }

  const visit = (value: unknown, depth: number): JsonResult => {
    if (depth > limits.maxDepth) return refuse(`exceeds the maximum JSON depth of ${limits.maxDepth}`)
    if (++nodes > limits.maxNodes) return refuse(`contains more than ${limits.maxNodes} JSON values`)
    if (value === null) return add(4) ? { ok: true, value: null, bytes } : refuse("exceeds the JSON byte limit")
    switch (typeof value) {
      case "boolean":
        return add(value ? 4 : 5) ? { ok: true, value, bytes } : refuse("exceeds the JSON byte limit")
      case "number":
        if (!Number.isFinite(value)) return refuse("contains a non-finite number")
        return add(String(value).length) ? { ok: true, value, bytes } : refuse("exceeds the JSON byte limit")
      case "string": {
        const size = stringBytes(value, limits.maxStringBytes)
        if (size === undefined) return refuse("contains unbounded or ill-formed text")
        return add(size) ? { ok: true, value, bytes } : refuse("exceeds the JSON byte limit")
      }
      case "object":
        break
      default:
        return refuse(`contains a non-JSON ${typeof value}`)
    }

    const object = value
    if (active.has(object)) return refuse("contains a cycle")
    active.add(object)
    try {
      if (Array.isArray(object)) {
        const length = Object.getOwnPropertyDescriptor(object, "length")
        if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value)) {
          return refuse("has an invalid array length")
        }
        members += length.value
        if (members > limits.maxMembers) return refuse(`contains more than ${limits.maxMembers} JSON members`)
        if (!add(2 + Math.max(0, length.value - 1))) return refuse("exceeds the JSON byte limit")
        const output: Array<Json> = []
        for (let index = 0; index < length.value; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(object, String(index))
          if (descriptor === undefined || !("value" in descriptor)) {
            return refuse("contains a sparse or accessor array member")
          }
          const member = visit(descriptor.value, depth + 1)
          if (!member.ok) return member
          output.push(member.value)
        }
        for (const key of Reflect.ownKeys(object)) {
          if (key === "length") continue
          if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) {
            const index = Number(key)
            if (index < length.value && String(index) === key) continue
          }
          if (Object.getOwnPropertyDescriptor(object, key)?.enumerable) {
            return refuse("has an enumerable non-index array member")
          }
        }
        return { ok: true, value: Object.freeze(output), bytes }
      }

      const prototype = Object.getPrototypeOf(object)
      if (prototype !== Object.prototype && prototype !== null) return refuse("contains a non-plain object")
      const entries: Array<readonly [string, unknown]> = []
      for (const key of Reflect.ownKeys(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        if (descriptor === undefined || !descriptor.enumerable) continue
        if (typeof key !== "string") return refuse("contains an enumerable symbol")
        if (!("value" in descriptor)) return refuse("contains an accessor")
        entries.push([key, descriptor.value])
      }
      members += entries.length
      if (members > limits.maxMembers) return refuse(`contains more than ${limits.maxMembers} JSON members`)
      if (!add(2 + Math.max(0, entries.length - 1))) return refuse("exceeds the JSON byte limit")
      const output = Object.create(null) as Record<string, Json>
      for (const [key, member] of entries) {
        const keySize = stringBytes(key, limits.maxKeyBytes)
        if (keySize === undefined) return refuse("contains an unbounded or ill-formed object key")
        if (!add(keySize + 1)) return refuse("exceeds the JSON byte limit")
        const admitted = visit(member, depth + 1)
        if (!admitted.ok) return admitted
        Object.defineProperty(output, key, {
          value: admitted.value,
          enumerable: true,
          configurable: false,
          writable: false
        })
      }
      return { ok: true, value: Object.freeze(output), bytes }
    } catch {
      return refuse("cannot be inspected without executing object code")
    } finally {
      active.delete(object)
    }
  }

  return visit(input, 0)
}

/**
 * Parses and bounds JSON text while preserving the caller's original bytes.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const admitJsonText = (
  input: unknown,
  limits: JsonLimits
):
  | { readonly ok: true; readonly value: string; readonly json: Json }
  | { readonly ok: false; readonly complaint: string } =>
{
  if (typeof input !== "string" || input.length === 0) return { ok: false, complaint: "must be non-empty JSON text" }
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    return { ok: false, complaint: "must be valid JSON text" }
  }
  const admitted = admitJson(parsed, limits)
  if (!admitted.ok) return admitted
  if (new TextEncoder().encode(input).byteLength > limits.maxBytes) {
    return { ok: false, complaint: "exceeds the JSON byte limit" }
  }
  return { ok: true, value: input, json: admitted.value }
}
