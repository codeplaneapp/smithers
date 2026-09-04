/**
 * One structural canonicalizer and one structural equality, shared by every
 * assertion in the package that has to decide whether two arbitrary values are
 * the same.
 *
 * Four modules used to carry a private copy of the same nine-line `same`, and
 * each copy compared a non-plain object by `Object.keys`, which is empty for a
 * `Date`, a `Map`, a `Set`, and most class instances. Two different `Date`s,
 * a `Map` beside a `Set`, `-0` beside `0`, and `NaN` beside `Infinity` all
 * compared equal, so a replay pin certifying a third-party engine, and the
 * fixture-drift detector in `Divergence`, both passed on genuinely different
 * journals.
 *
 * {@link canonical} is total: it tags every value it cannot render as plain
 * JSON rather than throwing, so a cycle, a `BigInt`, or a symbol reaches the
 * caller as a comparable marker instead of a `RangeError` or a `TypeError`
 * escaping a typed error channel.
 *
 * This module is internal: `./internal/*` is null-mapped in the export map and
 * carries no compatibility promise.
 *
 * @since 0.0.0
 */

/**
 * Maximum plain-data depth followed by either traversal.
 *
 * This is deliberately the same 128-level boundary as
 * `Fixture.canonicalize`: a snapshot must stop before the host stack does, then
 * leave the original tail for the fixture encoder to reject with its typed
 * `too-deep` error.
 *
 * Exported because a caller that walks a {@link snapshot} has to stop at the
 * same boundary: below it the value is the caller's own object rather than the
 * copy, so following it further both recurses without a bound and reaches
 * something the snapshot does not own.
 *
 * @since 0.0.0
 * @category encoding
 */
export const maximumDepth = 128

// Registered symbols cannot be WeakMap keys. Keeping their small process
// identity table strongly is preferable to making `canonical` partial again.
const symbolIdentities = new Map<symbol, number>()
const functionIdentities = new WeakMap<object, number>()
let nextSymbolIdentity = 0
let nextFunctionIdentity = 0

/** Returns one stable process-local ordinal for a symbol reference. */
const symbolIdentity = (value: symbol): number => {
  const existing = symbolIdentities.get(value)
  if (existing !== undefined) return existing
  const identity = nextSymbolIdentity++
  symbolIdentities.set(value, identity)
  return identity
}

/** Returns one stable process-local ordinal for a function reference. */
const functionIdentity = (value: object): number => {
  const existing = functionIdentities.get(value)
  if (existing !== undefined) return existing
  const identity = nextFunctionIdentity++
  functionIdentities.set(value, identity)
  return identity
}

/**
 * Renders one property without invoking an accessor.
 *
 * Reading `value[key]` made equality execute user code and allowed a throwing
 * getter to escape a typed assertion channel. The descriptor is stable data;
 * accessor function identity keeps two different accessors distinct while the
 * same descriptor remains comparable across calls.
 */
const member = (
  descriptor: PropertyDescriptor,
  ancestors: Set<object>,
  depth: number
): string =>
  "value" in descriptor
    ? render(descriptor.value, ancestors, depth)
    : `{"_tag":"Accessor","get":${render(descriptor.get, ancestors, depth)},"set":${
      render(descriptor.set, ancestors, depth)
    }}`

/** Renders one own-enumerable record in sorted key order. */
const record = (
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
  ancestors: Set<object>,
  depth: number
): string => {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return `{${
    [...keys].sort().map((key) => `${JSON.stringify(key)}:${member(descriptors[key]!, ancestors, depth + 1)}`)
      .join(",")
  }}`
}

/** Distinguishes the numbers `JSON.stringify` collapses. */
const number = (value: number): string => {
  if (Number.isNaN(value)) return `{"_tag":"NaN"}`
  if (value === Number.POSITIVE_INFINITY) return `{"_tag":"Infinity","sign":1}`
  if (value === Number.NEGATIVE_INFINITY) return `{"_tag":"Infinity","sign":-1}`
  // `Object.is` separates the two zeros; `JSON.stringify` renders both as `0`.
  return Object.is(value, -0) ? `{"_tag":"NegativeZero"}` : JSON.stringify(value)
}

const render = (value: unknown, ancestors: Set<object>, depth: number): string => {
  if (value === undefined) return `{"_tag":"Undefined"}`
  if (value === null) return "null"
  switch (typeof value) {
    case "number":
      return number(value)
    case "string":
    case "boolean":
      return JSON.stringify(value)
    case "bigint":
      return `{"_tag":"BigInt","value":${JSON.stringify(String(value))}}`
    case "symbol":
      return `{"_tag":"Symbol","description":${JSON.stringify(value.description ?? null)},"identity":${
        symbolIdentity(value)
      }}`
    case "function":
      return `{"_tag":"Function","name":${JSON.stringify(value.name)},"identity":${functionIdentity(value)}}`
  }
  if (depth >= maximumDepth) return `{"_tag":"TooDeep"}`
  const object: object = value
  // A cycle is reported rather than followed. The unbounded recursion this
  // replaces threw `RangeError: Maximum call stack size exceeded` out of an
  // `Effect` declared to fail only with its own typed error.
  if (ancestors.has(object)) return `{"_tag":"Circular"}`
  ancestors.add(object)
  try {
    if (Array.isArray(value)) return `[${value.map((item) => render(item, ancestors, depth + 1)).join(",")}]`
    if (value instanceof Date) {
      const time = value.getTime()
      return `{"_tag":"Date","value":${Number.isNaN(time) ? `"Invalid Date"` : String(time)}}`
    }
    if (value instanceof RegExp) return `{"_tag":"RegExp","value":${JSON.stringify(String(value))}}`
    if (value instanceof Map) {
      const entries = [...value].map(([key, item]) =>
        `[${render(key, ancestors, depth + 1)},${render(item, ancestors, depth + 1)}]`
      )
      return `{"_tag":"Map","entries":[${[...entries].sort().join(",")}]}`
    }
    if (value instanceof Set) {
      const items = [...value].map((item) => render(item, ancestors, depth + 1))
      return `{"_tag":"Set","values":[${[...items].sort().join(",")}]}`
    }
    if (value instanceof Error) {
      // `name` and `message` are the identity-bearing parts and are not own
      // enumerable properties. `stack` is deliberately excluded: it differs on
      // every construction, so including it would report a divergence between
      // two runs that failed identically.
      const { stack: _stack, ...own } = value as Error & Record<string, unknown>
      return `{"_tag":"Error","name":${JSON.stringify(value.name)},"message":${
        JSON.stringify(value.message)
      },"fields":${record(own, Object.keys(own), ancestors, depth)}}`
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    const fields = value as Readonly<Record<string, unknown>>
    if (prototype === Object.prototype || prototype === null) {
      return record(fields, Object.keys(fields), ancestors, depth)
    }
    // Anything else keeps its constructor name, so a class instance never
    // renders as the `{}` that made two different instances compare equal.
    const name = typeof (prototype as { constructor?: { name?: unknown } })?.constructor?.name === "string"
      ? (prototype as { constructor: { name: string } }).constructor.name
      : "Object"
    return `{"_tag":"Foreign","constructor":${JSON.stringify(name)},"fields":${
      record(fields, Object.keys(fields), ancestors, depth)
    }}`
  } finally {
    ancestors.delete(object)
  }
}

/**
 * Renders any value as a canonical string: object keys sort, array order is
 * retained, and every value JSON cannot express is tagged rather than dropped.
 * Never throws.
 *
 * @since 0.0.0
 * @category encoding
 */
export const canonical = (value: unknown): string => render(value, new Set<object>(), 0)

/**
 * Structural equality over the {@link canonical} rendering, so two values are
 * equal exactly when their canonical strings are.
 *
 * @since 0.0.0
 * @category encoding
 */
export const same = (left: unknown, right: unknown): boolean =>
  Object.is(left, right) || canonical(left) === canonical(right)

const copy = (value: unknown, ancestors: Set<object>, depth: number): unknown => {
  if (depth >= maximumDepth) return value
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return value
    ancestors.add(value)
    const result = value.map((item) => copy(item, ancestors, depth + 1))
    ancestors.delete(value)
    return result
  }
  if (typeof value !== "object" || value === null) return value
  const prototype: unknown = Object.getPrototypeOf(value)
  // Anything that is not a plain record passes through by reference. A fixture
  // cannot store it anyway, and `Fixture.canonicalize` must still see the
  // original so it can reject it with the path that reached it.
  if (prototype !== Object.prototype && prototype !== null) return value
  if (ancestors.has(value)) return value
  ancestors.add(value)
  const result: Record<PropertyKey, unknown> = {}
  // `Reflect.ownKeys`, not `Object.keys`: a symbol-keyed property must survive
  // the copy so the encoder rejects it instead of silently dropping it.
  for (const key of Reflect.ownKeys(value)) {
    result[key] = copy((value as Record<PropertyKey, unknown>)[key], ancestors, depth + 1)
  }
  ancestors.delete(value)
  return result
}

/**
 * A deep copy of the plain-record and array spine of `value`, so a later
 * mutation of the caller's object cannot change what was recorded.
 *
 * Unlike `structuredClone` it never throws: a function, a class instance, or a
 * cycle is passed through by reference rather than rejected, leaving the
 * fixture encoder to report it with a typed error naming its path.
 *
 * @since 0.0.0
 * @category encoding
 */
export const snapshot = <A>(value: A): A => copy(value, new Set<object>(), 0) as A

/**
 * Code-unit ordering, the comparator every stable rendering in this package
 * sorts with.
 *
 * `String.prototype.localeCompare` with no locale argument resolves the host
 * default locale and its ICU collation, so a plan whose node ids contain a
 * non-ASCII character renders in a different order on a machine whose locale
 * differs. Snapshot assertions promise byte-identical output, and code-unit
 * order is the only ordering that keeps that promise. It is also the order the
 * bare `Array.prototype.sort` used beside these comparators already produces.
 *
 * @since 0.0.0
 * @category encoding
 */
export const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
