/**
 * Dot-path reads over decoded provider payloads.
 *
 * Webhook payloads are large, deeply nested, and versioned by somebody else.
 * The correlation values this package extracts live at fixed paths inside them
 * (`repository.full_name`, `issue.number`, `data.team.key`), so the decoders
 * read those paths instead of type-asserting their way down the object.
 *
 * @since 1.0.0
 */

import type { RawInbound } from "@smthrs/control/Channels"

/**
 * The value at `path` inside `value`, or `undefined` when any segment is
 * missing or a segment lands on a non-object.
 *
 * An empty, `null`, or `undefined` path returns `value` itself. Arrays are
 * treated as non-objects: every path this package reads addresses a record.
 *
 * @category getters
 * @since 1.0.0
 */
export const readJsonPath = (value: unknown, path?: string | null): unknown => {
  if (path === undefined || path === null || path === "") return value
  let current = value
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
    if (current === undefined) return undefined
  }
  return current
}

/**
 * The value at `path` when it is a non-empty string, otherwise `undefined`.
 *
 * @category getters
 * @since 1.0.0
 */
export const readString = (value: unknown, path: string): string | undefined => {
  const found = readJsonPath(value, path)
  return typeof found === "string" && found.length > 0 ? found : undefined
}

/**
 * The value at `path` when it is an integer, otherwise `undefined`.
 *
 * @category getters
 * @since 1.0.0
 */
export const readInteger = (value: unknown, path: string): number | undefined => {
  const found = readJsonPath(value, path)
  return typeof found === "number" && Number.isInteger(found) ? found : undefined
}

/**
 * A header value, matched case-insensitively.
 *
 * A Node HTTP server lowercases incoming header names, but `RawInbound` is a
 * transport-neutral record a caller may build by hand, so the lookup does not
 * assume the transport normalized it.
 *
 * @category getters
 * @since 1.0.0
 */
export const readHeader = (raw: RawInbound, name: string): string | undefined => {
  const wanted = name.toLowerCase()
  const direct = raw.headers[wanted]
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(raw.headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}
