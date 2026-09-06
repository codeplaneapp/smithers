/**
 * Inert JSON admission for plugin configuration and cache identity.
 *
 * Reflection is descriptor-only: accessors never execute, hostile proxies are
 * refused, and accepted values are detached before they are frozen.
 *
 * @private
 * @since 1.0.0-rc.0
 */

/**
 * Strict JSON value accepted by the boundary.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/**
 * Resource bounds for one admitted tree.
 *
 * @private
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
 * Successful admission.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export interface AdmissionSuccess {
  readonly ok: true
  readonly value: Json
}

/**
 * Refusal with a stable value path.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export interface AdmissionFailure {
  readonly ok: false
  readonly path: string
  readonly complaint: string
}

/**
 * Result of inert JSON admission.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export type Admission = AdmissionSuccess | AdmissionFailure

/**
 * Default configuration bounds.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const defaultLimits: Limits = Object.freeze({
  maxBytes: 1024 * 1024,
  maxDepth: 64,
  maxMembers: 4_096,
  maxNodes: 8_192,
  maxStringBytes: 64 * 1024,
  maxKeyBytes: 1_024
})

const encoder = new TextEncoder()
const dangerousKeys = new Set(["__proto__", "constructor", "prototype"])

/**
 * Tests whether a string contains paired UTF-16 surrogate units.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const isWellFormedText = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

const childPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`

const encodedStringBytes = (value: string): number => encoder.encode(JSON.stringify(value)).byteLength

interface Frame {
  readonly input: unknown
  readonly path: string
  readonly depth: number
  readonly assign: (value: Json) => void
}

/**
 * Copies one strict JSON tree under explicit resource bounds.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const admit = (input: unknown, limits: Limits = defaultLimits): Admission => {
  let root: Json = null
  let bytes = 0
  let members = 0
  let nodes = 0
  const seen = new WeakSet<object>()
  const containers: Array<ReadonlyArray<Json> | { readonly [key: string]: Json }> = []
  const frames: Array<Frame> = [{ input, path: "$", depth: 0, assign: (value) => root = value }]
  let activePath = "$"
  const fail = (path: string, complaint: string): AdmissionFailure => ({ ok: false, path, complaint })
  const addBytes = (count: number, path: string): AdmissionFailure | undefined => {
    bytes += count
    return bytes > limits.maxBytes ? fail(path, `exceeds the ${limits.maxBytes}-byte limit`) : undefined
  }

  try {
    while (frames.length > 0) {
      const frame = frames.pop()!
      activePath = frame.path
      nodes += 1
      if (nodes > limits.maxNodes) return fail(frame.path, `exceeds the ${limits.maxNodes}-node limit`)

      const value = frame.input
      if (value === null) {
        const exceeded = addBytes(4, frame.path)
        if (exceeded) return exceeded
        frame.assign(null)
        continue
      }
      if (typeof value === "boolean") {
        const exceeded = addBytes(value ? 4 : 5, frame.path)
        if (exceeded) return exceeded
        frame.assign(value)
        continue
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) return fail(frame.path, "must be a finite JSON number")
        const exceeded = addBytes(encoder.encode(JSON.stringify(value)).byteLength, frame.path)
        if (exceeded) return exceeded
        frame.assign(value)
        continue
      }
      if (typeof value === "string") {
        if (!isWellFormedText(value)) return fail(frame.path, "contains an unpaired UTF-16 surrogate")
        const stringBytes = encodedStringBytes(value)
        if (stringBytes > limits.maxStringBytes) {
          return fail(frame.path, `exceeds the ${limits.maxStringBytes}-byte string limit`)
        }
        const exceeded = addBytes(stringBytes, frame.path)
        if (exceeded) return exceeded
        frame.assign(value)
        continue
      }
      if (typeof value !== "object") return fail(frame.path, "must contain only JSON values")
      if (frame.depth >= limits.maxDepth) return fail(frame.path, `exceeds the depth limit of ${limits.maxDepth}`)
      if (seen.has(value)) return fail(frame.path, "contains a cycle or repeated object reference")
      seen.add(value)

      const keys = Reflect.ownKeys(value)
      const prototype = Object.getPrototypeOf(value)
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype) return fail(frame.path, "must be an ordinary array")
        const length = value.length
        if (!Number.isSafeInteger(length)) return fail(frame.path, "has an invalid array length")
        members += length
        if (members > limits.maxMembers) return fail(frame.path, `exceeds the ${limits.maxMembers}-member limit`)
        if (keys.length !== length + 1 || !keys.includes("length")) {
          return fail(frame.path, "must be a dense array with no extra properties")
        }
        const output: Array<Json> = new Array(length)
        frame.assign(output)
        containers.push(output)
        const exceeded = addBytes(2 + Math.max(0, length - 1), frame.path)
        if (exceeded) return exceeded
        for (let index = length - 1; index >= 0; index--) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            return fail(`${frame.path}[${index}]`, "must be an enumerable data property")
          }
          frames.push({
            input: descriptor.value,
            path: `${frame.path}[${index}]`,
            depth: frame.depth + 1,
            assign: (item) => output[index] = item
          })
        }
        continue
      }

      if (prototype !== Object.prototype && prototype !== null) {
        return fail(frame.path, "must be an ordinary record")
      }
      if (keys.some((key) => typeof key === "symbol")) return fail(frame.path, "must not contain symbol keys")
      const stringKeys = keys as Array<string>
      members += stringKeys.length
      if (members > limits.maxMembers) return fail(frame.path, `exceeds the ${limits.maxMembers}-member limit`)
      const output: Record<string, Json> = {}
      frame.assign(output)
      containers.push(output)
      let structuralBytes = 2 + Math.max(0, stringKeys.length - 1)
      const children: Array<{ readonly key: string; readonly value: unknown; readonly path: string }> = []
      for (const key of stringKeys) {
        const path = childPath(frame.path, key)
        if (!isWellFormedText(key)) return fail(path, "has an ill-formed property name")
        if (dangerousKeys.has(key)) return fail(path, "uses a reserved property name")
        const keyBytes = encodedStringBytes(key)
        if (keyBytes > limits.maxKeyBytes) return fail(path, `exceeds the ${limits.maxKeyBytes}-byte key limit`)
        structuralBytes += keyBytes + 1
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          return fail(path, "must be an enumerable data property")
        }
        children.push({ key, value: descriptor.value, path })
      }
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index]!
        frames.push({
          input: child.value,
          path: child.path,
          depth: frame.depth + 1,
          assign: (item) =>
            Object.defineProperty(output, child.key, {
              value: item,
              enumerable: true,
              configurable: true,
              writable: true
            })
        })
      }
      const exceeded = addBytes(structuralBytes, frame.path)
      if (exceeded) return exceeded
    }

    for (let index = containers.length - 1; index >= 0; index--) Object.freeze(containers[index])
    return { ok: true, value: root }
  } catch {
    return fail(activePath, "could not be inspected without executing user code")
  }
}

/**
 * Admits only a JSON record at the root.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const record = (
  input: unknown,
  limits: Limits = defaultLimits
): AdmissionSuccess | AdmissionFailure => {
  const admitted = admit(input, limits)
  return admitted.ok && (admitted.value === null || Array.isArray(admitted.value) || typeof admitted.value !== "object")
    ? { ok: false, path: "$", complaint: "must be a JSON record" }
    : admitted
}
