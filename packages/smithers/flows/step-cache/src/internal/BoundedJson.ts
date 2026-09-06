/**
 * Step-cache limits over the shared inert JSON boundary.
 * @since 1.0.0
 */
import * as BoundedJson from "@smthrs/canonical/BoundedJson"

/** Cache values always have finite byte and per-container member budgets.
 * @category models
 * @since 1.0.0
 */
export type Limits = Required<Omit<BoundedJson.Limits, "maxTotalMembers">>

/** Detached JSON value accepted by the cache boundary.
 * @category models
 * @since 1.0.0
 */
export type Json = BoundedJson.Json

/** The cache's admission result.
 * @category models
 * @since 1.0.0
 */
export type Result =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly complaint: string }

/** Copies an inert JSON tree under the cache's limits.
 * @category validation
 * @since 1.0.0
 */
export const admit = (input: unknown, limits: Limits): Result => {
  const result = BoundedJson.admit(input, limits)
  return result.ok ? { ok: true, value: result.value } : { ok: false, complaint: result.complaint }
}
