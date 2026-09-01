// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Defines filesystem boundary enforcement modes.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Schema for how strictly an action's filesystem boundary is enforced.
 *
 * `hard` rejects undeclared access. `expected` records access for validation
 * after execution without requiring the sandbox to reject it immediately.
 *
 * @category models
 * @since 0.1.0
 */
export const BoundaryMode = Schema.Literals(["hard", "expected"])

/**
 * How strictly an action's filesystem boundary is enforced.
 *
 * @category models
 * @since 0.1.0
 */
export type BoundaryMode = typeof BoundaryMode.Type
