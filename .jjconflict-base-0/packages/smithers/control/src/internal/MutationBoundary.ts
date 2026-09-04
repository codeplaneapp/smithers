/**
 * Bounded inert JSON admission for control mutations.
 *
 * @since 1.0.0-rc.0
 * @private
 */

/** Maximum canonical bytes accepted for one mutation identity. */
const maximumBytes = 4 * 1024 * 1024

/** Maximum nesting accepted below a mutation root. */
const maximumDepth = 128

/** Maximum total values accepted in one mutation. */
const maximumNodes = 100_000

/** Maximum total array items and object fields accepted in one mutation. */
const maximumMembers = 100_000

/** Detached JSON data owned by the control package. */
type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/** Result of admitting an unknown mutation value. */
type Result =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly complaint: string }

const shortEscaped = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

/** Encoded JSON-string bytes without allocating the encoded string. */
const stringBytes = (value: string): number | undefined => {
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
    if (bytes > maximumBytes) return undefined
  }
  return bytes
}

/**
 * Copies one mutation without reading property values or consulting `toJSON`.
 *
 * Only enumerable own data properties cross. Accessors, sparse arrays,
 * symbols, cycles, non-plain objects, ill-formed text, and values beyond the
 * resource budget are refused.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const admit = (input: unknown): Result => {
  let bytes = 0
  let members = 0
  let nodes = 0
  const active = new WeakSet<object>()
  const refuse = (complaint: string): Result => ({ ok: false, complaint })
  const add = (count: number): boolean => {
    bytes += count
    return Number.isSafeInteger(bytes) && bytes <= maximumBytes
  }

  const visit = (value: unknown, depth: number): Result => {
    if (depth > maximumDepth) return refuse(`exceeds the maximum JSON depth of ${maximumDepth}`)
    if (++nodes > maximumNodes) return refuse(`contains more than ${maximumNodes} JSON values`)
    if (value === null) return add(4) ? { ok: true, value: null } : refuse("exceeds the JSON byte limit")
    switch (typeof value) {
      case "boolean":
        return add(value ? 4 : 5) ? { ok: true, value } : refuse("exceeds the JSON byte limit")
      case "number":
        if (!Number.isFinite(value)) return refuse("contains a non-finite number")
        return add(String(value).length) ? { ok: true, value } : refuse("exceeds the JSON byte limit")
      case "string": {
        const size = stringBytes(value)
        if (size === undefined) return refuse("contains oversized or ill-formed text")
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
        members += length.value
        if (members > maximumMembers) return refuse(`contains more than ${maximumMembers} JSON members`)
        if (!add(2 + Math.max(0, length.value - 1))) return refuse("exceeds the JSON byte limit")
        const output: Array<Json> = []
        for (let index = 0; index < length.value; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(object, String(index))
          if (descriptor === undefined || !("value" in descriptor)) {
            return refuse("contains a sparse or accessor array member")
          }
          const admitted = visit(descriptor.value, depth + 1)
          if (!admitted.ok) return admitted
          output.push(admitted.value)
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
      const entries: Array<readonly [string, unknown]> = []
      for (const key of Reflect.ownKeys(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        if (descriptor === undefined || !descriptor.enumerable) continue
        if (typeof key !== "string") return refuse("contains an enumerable symbol")
        if (!("value" in descriptor)) return refuse("contains an accessor")
        entries.push([key, descriptor.value])
      }
      members += entries.length
      if (members > maximumMembers) return refuse(`contains more than ${maximumMembers} JSON members`)
      if (!add(2 + Math.max(0, entries.length - 1))) return refuse("exceeds the JSON byte limit")
      const output = Object.create(null) as Record<string, Json>
      for (const [key, member] of entries) {
        const keySize = stringBytes(key)
        if (keySize === undefined) return refuse("contains an oversized or ill-formed object key")
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
