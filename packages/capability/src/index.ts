/**
 * @since 0.1.0
 *
 * `@smthrs/capability` — the leaf vocabulary of the permission kernel.
 *
 * Capability values and permission failures live here, apart from the kernel
 * that enforces them, so a protected Host service can declare the failures its
 * guarded interface adds without depending on `@smthrs/kernel`.
 */

/**
 * Capability values, patterns, matching, and effect tiers.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Capability from "./Capability.ts"

/**
 * Typed permission errors, policy rules, and the `PlatformError` projection.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Permission from "./Permission.ts"
