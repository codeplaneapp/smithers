/**
 * Defines one way a provider misses the contract.
 *
 * @since 0.1.0
 */

/**
 * One conformance check that did not hold.
 *
 * A violation names the check, what the contract requires, and what the
 * provider did instead. The three together are what a plugin author needs to
 * fix an adapter without reading this package's source.
 *
 * @category models
 * @since 0.1.0
 */
export interface Violation {
  /** The check that failed, as a stable kebab-case id. */
  readonly check: string
  /** What the `Provider` contract requires. */
  readonly expected: string
  /** What this provider did instead. */
  readonly actual: string
}

/**
 * Renders violations as one message.
 *
 * @category formatting
 * @since 0.1.0
 */
export const format = (violations: ReadonlyArray<Violation>): string =>
  violations.length === 0
    ? "provider conforms"
    : violations
      .map((violation) => `${violation.check}: expected ${violation.expected}, got ${violation.actual}`)
      .join("\n")
