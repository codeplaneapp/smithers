/**
 * Shared text normalization, hashing, search, and byte helpers.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"

/**
 * Compares text in ascending code-unit order.
 *
 * @category ordering
 * @since 0.1.0
 */
export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }
  if (typeof value !== "object" || value === null) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, member]) => [key, sortJson(member)])
  )
}

/**
 * Encodes a detached JSON value with recursively sorted object keys.
 *
 * @category encoding
 * @since 0.1.0
 */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortJson(value)) ?? ""

/**
 * Replaces every unpaired UTF-16 surrogate with U+FFFD.
 *
 * @category normalization
 * @since 0.1.0
 */
export const wellFormed = (value: string): string =>
  Array.from(value, (character) => {
    const first = character.charCodeAt(0)
    return character.length === 1 && first >= 0xd800 && first <= 0xdfff ? "\uFFFD" : character
  }).join("")

/**
 * Returns the full lowercase SHA-256 digest of a JavaScript string.
 *
 * Unpaired UTF-16 surrogates are replaced with U+FFFD before delegating to
 * `Digest.digest`, making this helper total for every JavaScript string.
 *
 * @category hashing
 * @since 0.1.0
 */
export const digest = (text: string): string => Digest.digest(wellFormed(text))

/**
 * Selects the text indexed for an authoritative memory value.
 *
 * @category projections
 * @since 0.1.0
 */
export const searchableText = (value: unknown): string => {
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "object" && value !== null && "content" in value && typeof value.content === "string") {
    return value.content
  }
  return JSON.stringify(value) ?? ""
}

/**
 * Retains string tags from a model-written memory value.
 *
 * @category projections
 * @since 0.1.0
 */
export const retainedTags = (value: unknown): ReadonlyArray<string> => {
  if (typeof value !== "object" || value === null || !("tags" in value) || !Array.isArray(value.tags)) {
    return []
  }
  return value.tags.filter((tag): tag is string => typeof tag === "string")
}

/**
 * Encodes Float32 vector values explicitly in little-endian byte order.
 *
 * @category encoding
 * @since 0.1.0
 */
export const vectorBytes = (vector: ArrayLike<number>): Uint8Array => {
  const bytes = new Uint8Array(vector.length * 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let index = 0; index < vector.length; index++) {
    view.setFloat32(index * 4, vector[index]!, true)
  }
  return bytes
}

/**
 * Escapes user text into quoted FTS5 terms with implicit AND semantics.
 *
 * @category queries
 * @since 0.1.0
 */
export const literalFtsQuery = (query: string): string => {
  const trimmed = wellFormed(query).replaceAll("\0", " ").trim()
  return trimmed.length === 0
    ? ""
    : trimmed
      .split(/\s+/u)
      .map((term) => `"${term.replaceAll("\"", "\"\"")}"`)
      .join(" ")
}

const encoder = new TextEncoder()

/**
 * Truncates text to complete Unicode code points within a UTF-8 byte limit.
 *
 * @category encoding
 * @since 0.1.0
 */
export const truncateBytes = (text: string, maxBytes: number): string => {
  if (encoder.encode(text).byteLength <= maxBytes) return text
  const characters = [...text]
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encoder.encode(characters.slice(0, middle).join("")).byteLength <= maxBytes) low = middle
    else high = middle - 1
  }
  return characters.slice(0, low).join("")
}
