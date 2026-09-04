/**
 * Object-shape checks used before walking untrusted values.
 *
 * @since 1.0.0
 */

/**
 * Narrows a typed JSON-like value while preserving its member type.
 *
 * @since 1.0.0
 * @category guards
 */
export function isRecord<A>(
  value: Readonly<Record<string, A>> | ReadonlyArray<A> | string | number | boolean | null | undefined
): value is Readonly<Record<string, A>>
/**
 * Accepts non-null objects and excludes arrays. This is a shape guard, not
 * a plain-object or JSON validator: it neither reads properties nor rejects
 * class instances.
 *
 * @since 1.0.0
 * @category guards
 */
export function isRecord(value: unknown): value is Record<string, unknown>
/**
 * Checks the container without inspecting its members.
 *
 * @since 1.0.0
 * @category guards
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
