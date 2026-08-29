/**
 * YAML frontmatter parsing for markdown flow sources. Split out so the
 * fence handling — BOM, CRLF, an unterminated document — is stated once and
 * tested directly.
 *
 * @since 0.1.0
 */
import type * as Schema from "effect/Schema"
import * as Yaml from "yaml"
import type { DiscoveryWarning } from "../Descriptor.ts"

const openingFence = /^(?:\uFEFF)?---(?:\r?\n|$)/
const closingFence = /^---[ \t]*(?=\r?\n|$)/m

/**
 * Separates a leading YAML frontmatter document from its markdown body.
 *
 * @since 0.1.0
 * @category parsing
 */
export const split = (text: string): { readonly frontmatter: string | undefined; readonly body: string } => {
  const opening = openingFence.exec(text)
  if (opening === null) {
    return { frontmatter: undefined, body: text }
  }

  const rest = text.slice(opening[0].length)
  const closing = closingFence.exec(rest)
  if (closing === null) {
    return { frontmatter: undefined, body: text }
  }

  const body = rest.slice(closing.index + closing[0].length)
  return {
    frontmatter: rest.slice(0, closing.index),
    body: body.replace(/^\r?\n/, "")
  }
}

/**
 * Returns whether a source prefix contains all leading frontmatter metadata.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isMetadataComplete = (text: string): boolean => {
  const source = text.replace(/^\uFEFF/, "")
  if (source.length < 3) {
    return false
  }
  if (!source.startsWith("---")) {
    return true
  }
  const opening = openingFence.exec(source)
  if (opening === null) {
    return source.includes("\n")
  }
  return closingFence.test(source.slice(opening[0].length))
}

/**
 * Parses a leading YAML frontmatter document without allowing malformed input
 * to interrupt discovery.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  options: { readonly text: string; readonly path: string }
): { readonly fields: Record<string, Schema.Json>; readonly warnings: ReadonlyArray<DiscoveryWarning> } => {
  const { frontmatter } = split(options.text)
  if (frontmatter === undefined || frontmatter.trim() === "") {
    return { fields: {}, warnings: [] }
  }

  try {
    const document = Yaml.parse(frontmatter, { schema: "failsafe" }) as unknown
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      return {
        fields: {},
        warnings: [frontmatterParseError(options.path, "Frontmatter must be a YAML object")]
      }
    }
    const sanitized = sanitizeJson(document, new WeakSet())
    return {
      fields: sanitized.value as Record<string, Schema.Json>,
      warnings: sanitized.changed
        ? [{
          code: "non_serializable_frontmatter",
          path: options.path,
          message: "Non-serializable frontmatter values were replaced with null"
        }]
        : []
    }
  } catch (cause) {
    return {
      fields: {},
      warnings: [frontmatterParseError(options.path, `Could not parse frontmatter: ${String(cause)}`, cause)]
    }
  }
}

const sanitizeJson = (
  value: unknown,
  ancestors: WeakSet<object>
): { readonly value: Schema.Json; readonly changed: boolean } => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return { value, changed: false }
  }
  if (typeof value !== "object") {
    return { value: null, changed: true }
  }
  if (ancestors.has(value)) {
    return { value: null, changed: true }
  }

  ancestors.add(value)
  let changed = false
  if (Array.isArray(value)) {
    const result = value.map((item) => {
      const sanitized = sanitizeJson(item, ancestors)
      changed ||= sanitized.changed
      return sanitized.value
    })
    ancestors.delete(value)
    return { value: result, changed }
  }

  const result: Record<string, Schema.Json> = {}
  for (const [key, item] of Object.entries(value)) {
    const sanitized = sanitizeJson(item, ancestors)
    changed ||= sanitized.changed
    result[key] = sanitized.value
  }
  ancestors.delete(value)
  return { value: result, changed }
}

const frontmatterParseError = (path: string, message: string, cause?: unknown): DiscoveryWarning => ({
  code: "frontmatter_parse_error",
  path,
  message,
  cause
})
