/**
 * Inert JSON admission for values crossing the step-cache boundary.
 *
 * @since 1.0.0-rc.0
 */

/**
 * Resource limits for one admitted JSON tree.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Limits {
  readonly maxBytes: number
  readonly maxDepth: number
  readonly maxMembers: number
  readonly maxNodes: number
  readonly maxStringBytes: number
  readonly maxKeyBytes: number
}

/**
 * Detached JSON value accepted by the cache persistence boundary.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/**
 * Result of admitting or refusing an unknown JSON candidate.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Result =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly complaint: string }

/** Backspace, tab, newline, form feed, and carriage return. */
const shortEscaped = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

/**
 * Encoded JSON-string bytes without allocating an encoded copy.
 *
 * The count has to match what the canonical encoder emits, or the budget
 * refuses a value whose encoded form is inside it. RFC 8785 and
 * `JSON.stringify` write the five controls above as a two-character escape and
 * every other C0 control as `\u00XX`, so those five cost two bytes here and the
 * rest cost six.
 */
const stringBytes = (value: string, maximum: number): number | undefined => {
  let bytes = 2
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return undefined
      bytes += 4
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return undefined
    else if (unit === 0x22 || unit === 0x5c || shortEscaped.has(unit)) bytes += 2
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
 * @category validation
 * @since 1.0.0-rc.0
 */
export const admit = (input: unknown, limits: Limits): Result => {
  let bytes = 0
  let nodes = 0
  const active = new WeakSet<object>()

  const refuse = (reason: string): Result => ({ ok: false, complaint: reason })
  const add = (count: number): boolean => {
    bytes += count
    return Number.isSafeInteger(bytes) && bytes <= limits.maxBytes
  }

  const visit = (value: unknown, depth: number): Result => {
    if (depth > limits.maxDepth) return refuse(`exceeds the maximum JSON depth of ${limits.maxDepth}`)
    if (++nodes > limits.maxNodes) return refuse(`contains more than ${limits.maxNodes} JSON values`)
    if (value === null) return add(4) ? { ok: true, value: null } : refuse("exceeds the JSON byte limit")
    switch (typeof value) {
      case "boolean":
        return add(value ? 4 : 5) ? { ok: true, value } : refuse("exceeds the JSON byte limit")
      case "number":
        if (!Number.isFinite(value)) return refuse("contains a non-finite number")
        return add(String(value).length) ? { ok: true, value } : refuse("exceeds the JSON byte limit")
      case "string": {
        const size = stringBytes(value, limits.maxStringBytes)
        if (size === undefined) return refuse("contains unbounded or ill-formed text")
        return add(size) ? { ok: true, value } : refuse("exceeds the JSON byte limit")
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
        if (length.value > limits.maxMembers) return refuse(`contains more than ${limits.maxMembers} members`)
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
        return { ok: true, value: Object.freeze(output) }
      }

      const prototype = Object.getPrototypeOf(object)
      if (prototype !== Object.prototype && prototype !== null) return refuse("contains a non-plain object")
      const members: Array<readonly [string, unknown]> = []
      for (const key of Reflect.ownKeys(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        if (descriptor === undefined || !descriptor.enumerable) continue
        if (typeof key !== "string") return refuse("contains an enumerable symbol")
        if (!("value" in descriptor)) return refuse("contains an accessor")
        members.push([key, descriptor.value])
      }
      if (members.length > limits.maxMembers) return refuse(`contains more than ${limits.maxMembers} members`)
      if (!add(2 + Math.max(0, members.length - 1))) return refuse("exceeds the JSON byte limit")
      const output = Object.create(null) as Record<string, Json>
      for (const [key, member] of members) {
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
      return { ok: true, value: Object.freeze(output) }
    } catch {
      return refuse("cannot be inspected without executing object code")
    } finally {
      active.delete(object)
    }
  }

  return visit(input, 0)
}
