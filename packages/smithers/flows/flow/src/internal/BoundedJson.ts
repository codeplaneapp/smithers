/**
 * Inert, bounded admission for JSON that crosses a durable boundary.
 *
 * The walk reads own data descriptors only. It never calls getters or
 * `toJSON`, never follows prototypes, rejects cycles and non-JSON values, and
 * returns a detached null-prototype snapshot suitable for later encoding.
 *
 * @since 1.0.0
 */

/**
 * Resource limits for one admitted JSON tree.
 *
 * @private
 * @since 1.0.0
 */
export interface Limits {
  readonly maxNodes: number
  readonly maxDepth: number
  readonly maxBytes: number
  readonly maxStringBytes: number
  readonly maxKeyBytes: number
  readonly maxMembers: number
}

/** One inert JSON value. */
type Json = null | boolean | number | string | JsonArray | JsonObject

/** One inert JSON array snapshot. */
type JsonArray = ReadonlyArray<Json>

/** One inert JSON object snapshot. */
interface JsonObject {
  readonly [key: string]: Json
}

/** A successfully admitted snapshot. */
interface Admitted {
  readonly ok: true
  readonly value: Json
}

/** A bounded refusal that never retains caller data. */
interface Refused {
  readonly ok: false
  readonly complaint: string
}

/** Result of bounded JSON admission. */
type Result = Admitted | Refused

interface Budget {
  nodes: number
  bytes: number
}

const refused = (path: ReadonlyArray<string>, reason: string): Refused => ({
  ok: false,
  complaint: `${
    path.length === 0
      ? "the value"
      : `"${path.map((segment) => scalarPrefix(segment, 64)).join(".")}"`
  } ${reason}`
})

/**
 * Returns encoded JSON bytes, or `undefined` for malformed or unbounded text.
 *
 * @private
 * @since 1.0.0
 */
export const encodedStringBytes = (value: string, maximum: number): number | undefined => {
  let bytes = 2 // quotes
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return undefined
      bytes += 4
      index++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return undefined
    } else if (unit === 0x22 || unit === 0x5c) {
      bytes += 2
    } else if (unit <= 0x1f) {
      bytes += unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d ? 2 : 6
    } else if (unit <= 0x7f) {
      bytes++
    } else if (unit <= 0x7ff) {
      bytes += 2
    } else {
      bytes += 3
    }
    if (bytes > maximum) return undefined
  }
  return bytes
}

/**
 * Whether text is well-formed and fits its encoded JSON byte budget.
 *
 * @private
 * @since 1.0.0
 */
export const textFits = (value: string, maximum: number): boolean => encodedStringBytes(value, maximum) !== undefined

/**
 * Copies one untrusted JSON value under explicit resource limits.
 *
 * @private
 * @since 1.0.0
 */
export const admit = (input: unknown, limits: Limits): Result => {
  const budget: Budget = { nodes: 0, bytes: 0 }
  const active = new WeakSet<object>()

  const addBytes = (count: number, path: ReadonlyArray<string>): Refused | undefined => {
    budget.bytes += count
    return budget.bytes > limits.maxBytes
      ? refused(path, `exceeds the ${limits.maxBytes}-byte JSON limit.`)
      : undefined
  }

  const visit = (value: unknown, path: ReadonlyArray<string>, depth: number): Result => {
    if (depth > limits.maxDepth) {
      return refused(path, `exceeds the maximum JSON depth of ${limits.maxDepth}.`)
    }
    budget.nodes++
    if (budget.nodes > limits.maxNodes) {
      return refused(path, `makes the value too large to check: it contains more than ${limits.maxNodes} JSON values.`)
    }

    if (value === null) {
      const overflow = addBytes(4, path)
      return overflow ?? { ok: true, value: null }
    }
    switch (typeof value) {
      case "boolean": {
        const overflow = addBytes(value ? 4 : 5, path)
        return overflow ?? { ok: true, value }
      }
      case "number": {
        if (!Number.isFinite(value)) return refused(path, "is not a finite JSON number.")
        const overflow = addBytes(String(value).length, path)
        return overflow ?? { ok: true, value }
      }
      case "string": {
        const bytes = encodedStringBytes(value, limits.maxStringBytes)
        if (bytes === undefined) {
          return refused(path, `is not well-formed text within ${limits.maxStringBytes} encoded bytes.`)
        }
        const overflow = addBytes(bytes, path)
        return overflow ?? { ok: true, value }
      }
      case "object":
        break
      default:
        return refused(path, `is a ${typeof value}, not a JSON value.`)
    }

    const object = value
    if (active.has(object)) return refused(path, "contains a cycle.")
    active.add(object)
    try {
      if (Array.isArray(object)) {
        const length = Object.getOwnPropertyDescriptor(object, "length")
        if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value)) {
          return refused(path, "has an invalid array length.")
        }
        if (length.value > limits.maxMembers) {
          return refused(path, `contains more than ${limits.maxMembers} array members.`)
        }
        const overflow = addBytes(2 + Math.max(0, length.value - 1), path)
        if (overflow !== undefined) return overflow
        const output: Array<Json> = []
        for (let index = 0; index < length.value; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(object, String(index))
          if (descriptor === undefined || !("value" in descriptor)) {
            return refused([...path, String(index)], "is missing or accessor-backed.")
          }
          const admitted = visit(descriptor.value, [...path, String(index)], depth + 1)
          if (!admitted.ok) return admitted
          output.push(admitted.value)
        }
        for (const key of Reflect.ownKeys(object)) {
          if (key === "length") continue
          if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) {
            const index = Number(key)
            if (Number.isSafeInteger(index) && index < length.value && String(index) === key) continue
          }
          const descriptor = Object.getOwnPropertyDescriptor(object, key)
          if (descriptor?.enumerable) return refused(path, "has an enumerable non-index array member.")
        }
        return { ok: true, value: Object.freeze(output) }
      }

      const prototype = Object.getPrototypeOf(object)
      if (prototype !== Object.prototype && prototype !== null) {
        return refused(path, "is not a plain JSON object.")
      }
      const keys = Reflect.ownKeys(object)
      const enumerable: Array<readonly [string, unknown]> = []
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        if (descriptor === undefined || !descriptor.enumerable) continue
        if (typeof key !== "string") return refused(path, "has an enumerable symbol key.")
        if (!("value" in descriptor)) return refused([...path, key], "is accessor-backed.")
        enumerable.push([key, descriptor.value])
      }
      if (enumerable.length > limits.maxMembers) {
        return refused(path, `contains more than ${limits.maxMembers} object members.`)
      }
      const structural = addBytes(2 + Math.max(0, enumerable.length - 1), path)
      if (structural !== undefined) return structural
      const output = Object.create(null) as Record<string, Json>
      for (const [key, member] of enumerable) {
        const keyBytes = encodedStringBytes(key, limits.maxKeyBytes)
        if (keyBytes === undefined) {
          return refused([...path, key], `has a key outside the ${limits.maxKeyBytes}-byte text limit.`)
        }
        const keyOverflow = addBytes(keyBytes + 1, [...path, key])
        if (keyOverflow !== undefined) return keyOverflow
        const admitted = visit(member, [...path, key], depth + 1)
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
      return refused(path, "cannot be inspected without executing object code.")
    } finally {
      active.delete(object)
    }
  }

  return visit(input, [], 0)
}

/**
 * Returns a Unicode-scalar-safe bounded prefix.
 *
 * @private
 * @since 1.0.0
 */
export function scalarPrefix(value: string, maximumCodeUnits: number): string {
  let output = ""
  for (let index = 0; index < value.length;) {
    const unit = value.charCodeAt(index)
    let next: string
    let width = 1
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        next = value.slice(index, index + 2)
        width = 2
      } else {
        next = "\ufffd"
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      next = "\ufffd"
    } else {
      next = value[index]!
    }
    if (output.length + next.length > maximumCodeUnits) break
    output += next
    index += width
  }
  return output
}

/**
 * Renders an untrusted value without invoking its code or allocating from its full size.
 *
 * @private
 * @since 1.0.0
 */
export const render = (value: unknown, maximumCodeUnits: number): string => {
  if (typeof value === "string") {
    const prefix = scalarPrefix(value, Math.max(0, maximumCodeUnits - 2))
    const quoted = JSON.stringify(prefix)
    return prefix.length < value.length
      ? `${quoted} [${value.length - prefix.length} characters dropped]`
      : quoted
  }
  if (typeof value === "bigint") return scalarPrefix(`${value}n`, maximumCodeUnits)
  if (typeof value === "symbol") return "[symbol]"
  if (typeof value === "function") return "[function]"
  if (value === undefined) return "[undefined]"

  const admitted = admit(value, {
    maxNodes: 64,
    maxDepth: 6,
    maxBytes: Math.max(64, maximumCodeUnits * 4),
    maxStringBytes: Math.max(64, maximumCodeUnits * 4),
    maxKeyBytes: Math.max(32, maximumCodeUnits * 2),
    maxMembers: 32
  })
  if (!admitted.ok) return scalarPrefix(`[${admitted.complaint}]`, maximumCodeUnits)
  const rendered = JSON.stringify(admitted.value)
  const prefix = scalarPrefix(rendered, maximumCodeUnits)
  return prefix.length < rendered.length
    ? `${prefix} [${rendered.length - prefix.length} characters dropped]`
    : prefix
}
