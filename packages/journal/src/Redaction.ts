/**
 * Payload redaction for durable journal writes.
 *
 * The journal is permanent and broadly readable: every entry is replayed to
 * sync subscribers and to time-travel consumers. A secret that reaches
 * `payload_json` is therefore not a transient leak, so redaction happens once,
 * on the journal write path, rather than at each reader.
 *
 * Redaction is an **observability** concern and is confined to journal events
 * and export/display surfaces. It is deliberately not applied to executable
 * state — `flows_runs.state_json`, attempt checkpoints, errors, outcomes, and
 * cache results — because those are decoded and re-entered on resume: a
 * placeholder there resumes the flow with the wrong data, and replacing a
 * non-string value with a placeholder string makes the persisted state fail
 * schema decode outright, leaving the run undrivable (issue #72). A value
 * that must never reach durable executable state is a `Redacted` field in the
 * caller's own schema, not a name-suffix guess made at the storage seam.
 *
 * The rule set is adopted from smithers' `_traceRedaction` (its `case22`
 * secret-injection-no-leak fault case), which redacts both structurally — by
 * sensitive field name — and textually, by provider key and bearer-token
 * shape.
 *
 * @since 0.1.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/**
 * A textual redaction rule.
 *
 * `replace` is the substitution for a matched span; when omitted the whole
 * match is replaced by the placeholder.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Rule {
  readonly id: string
  readonly pattern: RegExp
  readonly replace?: string | undefined
}

/**
 * The placeholder written in place of a redacted value.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const placeholder = "[REDACTED]"

/**
 * Textual rules covering the credential shapes Smithers actually carries:
 * provider API keys, bearer tokens, and `key=value` secret assignments.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const defaultRules: ReadonlyArray<Rule> = [
  {
    id: "api-key",
    // Not `\b`, for the reason the assignment rule below gives: an underscore
    // is a word character, so `\bsk` never fires after `ANTHROPIC_` or after
    // Effect's log-span sanitizer folds `token=` into `token_`. The lookbehind
    // excludes only letters and digits, so a key still reads as a key when an
    // underscore or a hyphen runs into it.
    pattern: /(?<![A-Za-z0-9])(?:sk|pk)[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}/g,
    replace: "[REDACTED_API_KEY]"
  },
  {
    id: "bearer-token",
    pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
    replace: "Bearer [REDACTED_TOKEN]"
  },
  {
    id: "assignment",
    // Not `\b`: an underscore is a word character, so `\bapi` never fires
    // after `ANTHROPIC_`, which is exactly how env-style dumps leak.
    pattern: /(?<![A-Za-z0-9])(api[_-]?key|token|secret|password)=[^\s"']+/gi,
    replace: undefined
  }
]

const sensitiveKeySuffixes = ["authorization", "cookie", "apikey", "token", "password", "secret"]

/**
 * Whether a field name names a credential, ignoring case and separators, so
 * `api_key`, `apiKey`, and `x-api-key` are all recognised.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const isSensitiveKey = (key: string): boolean => {
  const canonical = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  return sensitiveKeySuffixes.some((suffix) => canonical.endsWith(suffix))
}

/**
 * A field name with a credential in it replaced outright, not rewritten in place.
 *
 * Redacting part of a key changes what the key reads as. `secret=sk-` rewrites
 * to `secret=[REDACTED]`, which now ENDS in a sensitive name, so a second
 * application would replace a value the first one left alone and redaction
 * would stop being a fixed point. Naming the whole key holds the verdict still:
 * `[REDACTED]` matches no rule and names no credential. Two such keys collapse
 * into one and the later member wins, which is the fidelity trade every other
 * marker here makes.
 */
const redactKey = (key: string, rules: ReadonlyArray<Rule>): string => {
  const redacted = redactString(key, rules)
  return redacted === key ? key : placeholder
}

const redactString = (value: string, rules: ReadonlyArray<Rule>): string =>
  rules.reduce(
    (text, rule) =>
      text.replace(rule.pattern, (match) =>
        rule.replace === undefined
          ? `${match.slice(0, match.indexOf("="))}=${placeholder}`
          : rule.replace),
    value
  )

/**
 * Options for {@link redact}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Options {
  readonly rules?: ReadonlyArray<Rule> | undefined
}

/**
 * How many bytes a view may hold, and how many own members {@link redact} reads
 * off it, before it stops reading them.
 *
 * Enumerating a view's own properties materialises one pair per byte, so the
 * walk costs the buffer's size even though the rendering does not. Both halves
 * of the bound carry load, and neither is a bound on its own. A size alone is
 * not, because `byteLength` was read as an ordinary property and an ordinary
 * property can be shadowed: a pooled chunk that reports the bytes it has used
 * rather than the bytes it holds is a plain pattern, not an adversarial one,
 * and a 4 MB chunk reporting 12 walked one property per byte anyway. A count
 * alone is not, because a caller can hang a million properties on a ten-byte
 * view. So the size is read from the value's own internal slot, where nothing
 * a caller writes can answer for it, and the members are counted as they are
 * walked.
 *
 * @since 0.1.0
 * @category redaction
 * @slop
 */
export const binaryWalkLimit = 65_536

/**
 * The byte-length getters, taken from the prototypes rather than from a value.
 *
 * `%TypedArray%.prototype`, `DataView.prototype` and `ArrayBuffer.prototype`
 * each define `byteLength` as an accessor over an internal slot, and applying
 * one to a value that has no such slot throws. Reading the size this way is
 * therefore a brand check as well as a measurement: a caller's own `byteLength`
 * property, accessor or not, never answers it.
 */
const byteLengthGetters = [
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype) as object, "byteLength")!.get!,
  Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!,
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!
] as ReadonlyArray<() => number>

/** A value's byte length from its own internal slot, or `undefined` when it has none. */
const byteLength = (node: object): number | undefined => {
  for (const getter of byteLengthGetters) {
    try {
      return Reflect.apply(getter, node, [])
    } catch {
      // Not that kind of view. Another getter answers, or none does and the
      // bytes are named without the members being read.
    }
  }
  return undefined
}

/** The prototypes every binary view inherits from. */
const binaryPrototypes: ReadonlySet<unknown> = new Set([
  Object.getPrototypeOf(Uint8Array.prototype),
  DataView.prototype,
  ArrayBuffer.prototype
])

/** How many prototypes {@link isBinary} climbs before it stops asking. */
const prototypeWalkLimit = 64

/**
 * Whether `node` is a binary view, including one held behind a proxy.
 *
 * `ArrayBuffer.isView` reads an internal slot, and a proxy has none of its own,
 * so it answers `false` for a proxy over a view. That sent a proxied 2 MB
 * buffer to the object branch, which rebuilt it one key per byte: 2,000 ms and
 * 22.9 million characters for one logged value. A proxy forwards
 * `getPrototypeOf` to its target, so the prototype chain answers where the
 * brand check cannot. The climb is capped because a proxy is free to hand back
 * a fresh object every time it is asked, which is an endless chain.
 */
const isBinary = (node: object): boolean => {
  if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) return true
  try {
    let prototype = Object.getPrototypeOf(node) as object | null
    for (let step = 0; prototype !== null && step < prototypeWalkLimit; step++) {
      if (binaryPrototypes.has(prototype)) return true
      prototype = Object.getPrototypeOf(prototype) as object | null
    }
  } catch {
    // A revoked proxy refuses to be asked. It is not a view, and the object
    // branch names it.
  }
  return false
}

/** Own keys of a binary view that name one of its bytes rather than a property. */
const indexKey = /^(?:0|[1-9][0-9]*)$/

/** `Uint8Array 1024 bytes`, or the bare marker when the value will not say. */
const describeBinary = (node: object, size: number | undefined): string => {
  if (size === undefined) return binaryMarker
  try {
    return `${node.constructor.name} ${size} bytes`
  } catch {
    return binaryMarker
  }
}

/**
 * The key {@link redact} files a binary view's size under.
 *
 * @since 0.1.0
 * @category redaction
 * @slop
 */
export const binaryMarker = "[Binary]"

/**
 * What {@link redact} writes in place of a function or a class object.
 *
 * @since 0.1.0
 * @category redaction
 * @slop
 */
export const functionMarker = "[Function]"

/**
 * What {@link redact} writes in place of a symbol.
 *
 * @since 0.1.0
 * @category redaction
 * @slop
 */
export const symbolMarker = "[Symbol]"

/**
 * How deep {@link redact} walks before it names a value instead.
 *
 * @since 0.1.0
 * @category redaction
 * @slop
 */
export const depthLimit = 200

/**
 * What {@link redact} writes in place of a value nested past {@link depthLimit}.
 *
 * @since 0.1.0
 * @category redaction
 * @slop
 */
export const depthMarker = "[Deep]"

/**
 * Returns `value` with credentials removed.
 *
 * Objects and arrays are rebuilt: a field whose name {@link isSensitiveKey}
 * is replaced wholesale, every other string is run through the textual rules,
 * and a cycle is collapsed to `"[Circular]"` so the result always encodes.
 * Non-string leaves are returned untouched — redacting a number or a boolean
 * would destroy data without protecting anything.
 *
 * @since 0.1.0
 * @category redaction
 * @slop
 */
export const redact = (value: unknown, options?: Options): unknown => {
  const rules = options?.rules ?? defaultRules
  /**
   * A binary view named by its type and size, with its own properties walked.
   *
   * Its bytes are not text the rules can read, and rebuilding it from its
   * entries wrote one key per byte: a 100 kB buffer rendered 1.4 MB. Handing
   * the view back untouched is not the answer either, because `redact` is the
   * journal's own write path, so a caller's `apiKey` property hung on a buffer
   * went into a durable row in clear. Name the bytes, keep walking the text.
   */
  const binary = (node: object, ancestors: WeakSet<object>, depth: number): unknown => {
    const size = byteLength(node)
    // The description is text read off the value, so it meets the rules like
    // any other text: a class name is caller data, and a view whose
    // constructor is named after a credential wrote it into a durable row.
    const entries: Array<[string, unknown]> = [[binaryMarker, redactString(describeBinary(node, size), rules)]]
    // `Object.entries` on a view materialises one pair per byte before the
    // index filter can discard them, which cost 312 ms for 1 MB on the journal
    // write path. Past the bound the bytes are named and nothing else is read,
    // so a member a caller hung on a large view is dropped rather than shown.
    // A value that will not answer from its internal slot, such as a proxy over
    // a view, is named and never enumerated at all.
    if (size !== undefined && size <= binaryWalkLimit) {
      let walked = 0
      for (const [key, field] of Object.entries(node as Record<string, unknown>)) {
        // An index is one of the bytes just named, not a property a caller set.
        if (indexKey.test(key)) continue
        // The size bounds the bytes, not the properties: a caller can hang a
        // million members on a ten-byte view, and each one costs three rule
        // scans over its name and a walk of its value.
        if (walked >= binaryWalkLimit) break
        walked++
        entries.push([redactKey(key, rules), isSensitiveKey(key) ? placeholder : walk(field, ancestors, depth + 1)])
      }
    }
    // `Object.fromEntries`, not `named[key] = …`, for the reason the object
    // branch below gives: a literal `__proto__` key would route through the
    // inherited setter and the member would vanish from the row.
    return Object.fromEntries(entries)
  }

  const walk = (node: unknown, ancestors: WeakSet<object>, depth = 0): unknown => {
    if (typeof node === "string") return redactString(node, rules)
    // A function, a class object or a symbol carries text a walk never reaches
    // (own properties, a description, a body), and the renderer prints it. None
    // of it can be redacted in place, so the value is named instead.
    if (typeof node === "function") return functionMarker
    if (typeof node === "symbol") return symbolMarker
    if (node === null || typeof node !== "object") return node
    if (isBinary(node)) return binary(node, ancestors, depth)
    if (ancestors.has(node)) return "[Circular]"
    // A journal row is bounded by its schema, but a LOGGED value is arbitrary:
    // the logger sends every non-Error value here, and a chain deep enough to
    // exhaust the stack would throw while the line is rendering, killing the
    // run the line describes. Past the cap the value is named, the way a cycle
    // is named.
    if (depth >= depthLimit) return depthMarker
    ancestors.add(node)
    try {
      if (Array.isArray(node)) {
        return node.map((element) => walk(element, ancestors, depth + 1))
      }
      // `result[key] = …` routes a literal `__proto__` key through the
      // inherited setter, so the field would silently become the result's
      // prototype instead of a member: the payload loses data and redaction
      // stops being a fixed point. `Object.fromEntries` defines own data
      // properties and has no such hole.
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map((
          [key, field]
        ) => [
          // The KEY is text too. Rewriting only values let a credential used as
          // a log annotation key reach the operator, since Effect renders an
          // annotation as `key=value`, and become an OTLP span attribute name.
          redactKey(key, rules),
          isSensitiveKey(key) ? placeholder : walk(field, ancestors, depth + 1)
        ])
      )
    } finally {
      ancestors.delete(node)
    }
  }
  return walk(value, new WeakSet())
}

/**
 * A redaction function, as the journal consumes it.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Redactor = (value: unknown) => unknown

/**
 * Builds a redactor over a rule set.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (options?: Options): Redactor => (value) => redact(value, options)

/**
 * Applies a redactor to an already-encoded JSON string, returning the
 * re-encoded result.
 *
 * For export and display surfaces that hold a column verbatim — a rendered
 * `state_json`, a support bundle — where the value is already encoded and must
 * not be decoded into the executable path. A string that does not parse is
 * returned untouched: validation is the caller's, and rejecting here would
 * turn a redaction concern into a schema error.
 *
 * @since 0.1.0
 * @category redaction
 * @slop
 */
export const redactJsonString = (json: string, redactor: Redactor): string => {
  const decoded = Schema.decodeUnknownResult(UnknownFromJsonString)(json)
  if (Result.isFailure(decoded)) return json
  const encoded = Schema.encodeUnknownResult(UnknownFromJsonString)(redactor(decoded.success))
  return Result.isSuccess(encoded) ? encoded.success : json
}

/**
 * The identity redactor, for callers that persist payloads verbatim by
 * choice — a trusted single-tenant store, or a suite asserting on raw input.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const makeNoop = (): Redactor => (value) => value
