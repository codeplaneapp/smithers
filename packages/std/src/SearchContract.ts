/**
 * Public validation and matching rules for Search implementations.
 *
 * External peers use this module to share the same regex and glob semantics as
 * the Search implementations included with this package.
 *
 * @since 0.1.0
 */
import * as Internal from "./internal/SearchContract.ts"

/**
 * Validates a pattern against Smithers Ripgrep ASCII v1.
 *
 * @category validation
 * @since 0.1.0
 */
export const validatePattern = Internal.validatePattern

/**
 * Validates a glob against the portable search grammar.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateGlob = Internal.validateGlob

/**
 * Rewrites a glob into the canonical spelling every Search peer uses.
 *
 * @category matching
 * @since 0.1.0
 */
export const canonicalGlob = Internal.canonicalGlob

/**
 * Matches a glob against one root-relative candidate path.
 *
 * @category matching
 * @since 0.1.0
 */
export const matchesGlob = Internal.matchesGlob

/**
 * Applies ordered include and exclude globs to one candidate path.
 *
 * @category matching
 * @since 0.1.0
 */
export const includedByGlobs = Internal.includedByGlobs

/**
 * Compiles one validated search pattern with shared peer semantics.
 *
 * @category matching
 * @since 0.1.0
 */
export const expression = Internal.expression

/**
 * Explains positive globs that no file under a search root can match.
 *
 * @category diagnostics
 * @since 0.1.0
 */
export const unsatisfiableNotice = Internal.unsatisfiableNotice
