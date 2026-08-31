/**
 * RFC 8785 (JSON Canonicalization Scheme) serialization.
 *
 * Inlined replacement for the `canonicalize` npm package: that library ships
 * ESM-only `exports`, so the CJS build produced for release artifacts could
 * never `require` it. The algorithm is small enough to own — member keys are
 * sorted by UTF-16 code units and numbers use ECMAScript's `JSON.stringify`
 * serialization, both exactly as RFC 8785 specifies.
 *
 * @since 0.1.0
 */

const hasToJson = (value: object): value is { toJSON: () => unknown } =>
  "toJSON" in value && typeof (value as { toJSON: unknown }).toJSON === "function"

/**
 * Refuses a string containing a lone surrogate.
 *
 * A lone surrogate has no UTF-8 encoding, so a document containing one has no
 * canonical byte sequence to hash — different runtimes would substitute
 * different replacement characters and produce different digests. The check
 * runs at the point a string is serialized, which is the only place that sees
 * every string in the output: the input's own strings and keys, and the ones a
 * `toJSON` mints during serialization.
 *
 * @private
 */
const assertWellFormed = (value: string): string => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("Lone surrogate is not allowed")
      }
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Lone surrogate is not allowed")
    }
  }
  return value
}

const serialize = (value: unknown, ancestors: WeakSet<object>): string | undefined => {
  if (typeof value === "number" && Number.isNaN(value)) {
    throw new TypeError("NaN is not allowed")
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Infinity is not allowed")
  }
  if (typeof value === "string") {
    return JSON.stringify(assertWellFormed(value))
  }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return JSON.stringify(value)
  }
  if (ancestors.has(value)) {
    throw new TypeError("Circular reference detected")
  }
  ancestors.add(value)
  try {
    // `JSON.stringify` consults a callable `toJSON` on functions too, so the
    // check runs before functions are dropped, and the result is serialized
    // canonically rather than handed back to `JSON.stringify`.
    if (hasToJson(value)) {
      return serialize(value.toJSON(), ancestors)
    }
    if (typeof value === "function") {
      return undefined
    }
    if (Array.isArray(value)) {
      // An element with no JSON representation (undefined, a symbol, a
      // function, or a toJSON that returned undefined) serializes as null,
      // exactly as JSON.stringify renders it.
      const items = value.map((item) => serialize(item, ancestors) ?? "null")
      return `[${items.join(",")}]`
    }
    const record = value as Record<string, unknown>
    const members = Object.keys(record).sort().flatMap((key) => {
      // A member with no JSON representation is omitted, exactly as
      // JSON.stringify omits it; interpolating the recursive undefined here
      // is what used to emit invalid documents such as `{"x":undefined}`.
      const rendered = serialize(record[key], ancestors)
      return rendered === undefined ? [] : [`${JSON.stringify(assertWellFormed(key))}:${rendered}`]
    })
    return `{${members.join(",")}}`
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Serializes a JSON value into its RFC 8785 canonical form.
 *
 * Returns `undefined` when the top-level value has no JSON representation
 * (`undefined`, a symbol, or a function), mirroring `JSON.stringify`. Nested
 * values with no JSON representation follow `JSON.stringify` too: `null` in
 * array positions, omitted from objects. A callable `toJSON` is honored
 * everywhere `JSON.stringify` honors it, functions included, and its result
 * is canonicalized.
 * Throws on non-finite numbers, circular references, and strings or property
 * names carrying a lone surrogate, none of which RFC 8785 can represent.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const canonicalize = (value: unknown): string | undefined => serialize(value, new WeakSet())
