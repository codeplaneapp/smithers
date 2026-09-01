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
 * state, `flows_runs.state_json`, attempt checkpoints, errors, outcomes, and
 * cache results, because those are decoded and re-entered on resume: a
 * placeholder there resumes the flow with the wrong data, and replacing a
 * non-string value with a placeholder string makes the persisted state fail
 * schema decode outright, leaving the run undrivable (issue #72). A value
 * that must never reach durable executable state is a `Redacted` field in the
 * caller's own schema, not a name-suffix guess made at the storage seam.
 *
 * The rule set is a best-effort textual net over credential shapes seen in
 * real bug reports, plus structural redaction by sensitive field name. It is
 * finite, so a value that must never persist belongs in a `Redacted` field of
 * the caller's own schema. See `docs/pages/concepts/journal.md` for the journal
 * durability contract.
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
 */
export const placeholder = "[REDACTED]"

/**
 * Best-effort textual rules for credential shapes observed in real reports.
 * Every replacement reaches a fixed point so replaying or exporting an entry
 * cannot mutate it again.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultRules: ReadonlyArray<Rule> = [
  {
    id: "url-credentials",
    // The scheme is bounded rather than open. `-` is not a word character, so
    // `\b[a-z][a-z0-9+.-]*` starts a fresh scan after every hyphen, and on a
    // long run of that shape the rule rescanned the tail from each one: 400 kB
    // of `aaaaaaaa-` cost 11 seconds, on the path every journal write and every
    // log line takes. A scheme longer than 30 characters is not one this net is
    // for, and the cap makes each start position cost a constant.
    pattern: /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]+):(?!\[REDACTED\]@)[^\s:@/]+@/gi,
    replace: "$1:[REDACTED]@"
  },
  {
    id: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{4,}=*/gi,
    replace: "Bearer [REDACTED_TOKEN]"
  },
  {
    id: "api-key",
    pattern: /\b(?:sk|pk)[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g,
    replace: "[REDACTED_API_KEY]"
  },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
    replace: "[REDACTED]"
  },
  {
    id: "github-fine-grained-token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/g,
    replace: "[REDACTED]"
  },
  {
    id: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: "[REDACTED]"
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
    replace: "[REDACTED]"
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35,}(?![0-9A-Za-z_-])/g,
    replace: "[REDACTED]"
  },
  {
    id: "assignment",
    // The output drops quotes consistently. Excluding that exact output keeps
    // repeated journal and export passes at a fixed point.
    pattern:
      /\b([A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?)=(?!\[REDACTED\])("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?!["'])\S+)/gi,
    replace: "$1=[REDACTED]"
  },
  {
    id: "embedded-json-credential",
    pattern:
      /"([A-Za-z0-9_-]*(?:key|token|secret|password|credential)[A-Za-z0-9_-]*)"(\s*:\s*)"(?!\[REDACTED\]")(?:[^"\\]|\\.)*"/gi,
    replace: "\"$1\"$2\"[REDACTED]\""
  }
]

const sensitiveKeySuffixes = ["authorization", "cookie", "apikey", "token", "password", "secret"]

/**
 * Whether a field name names a credential, ignoring case and separators, so
 * `api_key`, `apiKey`, and `x-api-key` are all recognised.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isSensitiveKey = (key: string): boolean => {
  const canonical = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  return sensitiveKeySuffixes.some((suffix) => canonical.endsWith(suffix))
}

const redactString = (value: string, rules: ReadonlyArray<Rule>): string =>
  rules.reduce((text, rule) => text.replace(rule.pattern, rule.replace ?? placeholder), value)

/**
 * Maximum number of container edges traversed from a redaction root.
 *
 * Journal event schemas never approach 256 nested containers. This bound is
 * far above practical payloads while keeping traversal safely below Node's
 * call-stack limit for hostile input.
 *
 * @since 1.0.0
 * @category constants
 */
export const maxDepth = 256

/**
 * Options for {@link redact}.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly rules?: ReadonlyArray<Rule> | undefined
}

/**
 * Returns `value` with credentials removed.
 *
 * Objects and arrays are rebuilt: a field whose name {@link isSensitiveKey}
 * is replaced wholesale, every other string is run through the textual rules,
 * and a cycle is collapsed to `"[Circular]"` so the result always encodes.
 * Non-string leaves are returned untouched: redacting a number or a boolean
 * would destroy data without protecting anything.
 *
 * Traversal accepts at most {@link maxDepth} container edges. A deeper value
 * throws so the journal boundary can report a typed `invalid_event` instead
 * of overflowing the runtime stack.
 *
 * @since 0.1.0
 * @category redaction
 */
export const redact = (value: unknown, options?: Options): unknown => {
  const rules = (options?.rules ?? defaultRules).map((rule) =>
    rule.pattern.flags.includes("g")
      ? rule
      : { ...rule, pattern: new RegExp(rule.pattern.source, `${rule.pattern.flags}g`) }
  )
  const walk = (node: unknown, ancestors: WeakSet<object>, depth: number): unknown => {
    if (depth > maxDepth) throw new Error(`redaction depth exceeds ${maxDepth}`)
    if (typeof node === "string") return redactString(node, rules)
    if (node === null || (typeof node !== "object" && typeof node !== "function")) return node
    if (ancestors.has(node)) return "[Circular]"
    ancestors.add(node)
    try {
      const toJSON = (node as { toJSON?: unknown }).toJSON
      if (typeof toJSON === "function") return walk(toJSON.call(node), ancestors, depth)
      if (typeof node === "function") return node
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
        ) => [key, isSensitiveKey(key) ? placeholder : walk(field, ancestors, depth + 1)])
      )
    } finally {
      ancestors.delete(node)
    }
  }
  return walk(value, new WeakSet(), 0)
}

/**
 * A redaction function, as the journal consumes it.
 *
 * @since 0.1.0
 * @category models
 */
export type Redactor = (value: unknown) => unknown

/**
 * Builds a redactor over a rule set.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options?: Options): Redactor => (value) => redact(value, options)

/**
 * Applies a redactor to an already-encoded JSON string, returning the
 * re-encoded result.
 *
 * For export and display surfaces that hold a column verbatim, a rendered
 * `state_json`, a support bundle, where the value is already encoded and must
 * not be decoded into the executable path. A string that does not parse is
 * returned untouched: validation is the caller's, and rejecting here would
 * turn a redaction concern into a schema error. Once parsing succeeds, a
 * throwing redactor or an encoding failure returns the valid JSON string
 * `"[REDACTED]"`; the original parsed text is never returned.
 *
 * @since 0.1.0
 * @category redaction
 */
export const redactJsonString = (json: string, redactor: Redactor): string => {
  const decoded = Schema.decodeUnknownResult(UnknownFromJsonString)(json)
  if (Result.isFailure(decoded)) return json
  const attempted = Result.try(() => Schema.encodeUnknownResult(UnknownFromJsonString)(redactor(decoded.success)))
  if (Result.isFailure(attempted)) return JSON.stringify(placeholder)
  return Result.isSuccess(attempted.success) ? attempted.success.success : JSON.stringify(placeholder)
}

/**
 * The identity redactor, for a caller that persists payloads verbatim by
 * choice: a trusted single-tenant store, or a suite asserting on raw input.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (): Redactor => (value) => value
