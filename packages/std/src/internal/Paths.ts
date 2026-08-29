/**
 * Path containment checks against a declared effect envelope.
 *
 * @since 0.1.0
 */
import * as Effects from "@smthrs/core/Effects"

const normalize = (path: string): string => path.length > 1 ? path.replace(/\/+$/, "") : path

/**
 * Whether a path is covered by any entry of a declared read or write set.
 *
 * An entry covers itself, everything beneath it when it names a directory,
 * and everything matched by the prefix-glob subset `/core` supports.
 *
 * @category predicates
 * @since 0.1.0
 */
export const withinEnvelope = (declared: ReadonlyArray<string>, path: string): boolean => {
  const candidate = normalize(path)
  return declared.some((entry) => {
    const normalized = normalize(entry)
    return Effects.covers(normalized, candidate) || candidate.startsWith(`${normalized}/`)
  })
}
