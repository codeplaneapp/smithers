/**
 * Scorer bindings attached to target flow declarations.
 *
 * @see docs/specs/Concepts/Scoring.md
 *
 * @since 0.1.0
 */
import type { Flow } from "@smthrs/core"
import type { Sampling } from "./Sampling.ts"
import type { Scorer } from "./Scorer.ts"

/**
 * A scorer, optional ground truth, and deterministic sampling policy attached
 * to a target flow. The target value is retained unchanged, so binding never
 * changes its step key.
 *
 * @category models
 * @since 0.1.0
 */
export interface Binding {
  readonly scorer: Scorer
  readonly appliesTo: Flow.Any
  readonly groundTruth?: unknown
  readonly context?: unknown
  readonly sampling: Sampling
}

/**
 * Creates a scorer binding, defaulting to sampling every target step.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Omit<Binding, "sampling"> & { readonly sampling?: Sampling | undefined }
): Binding => ({ ...options, sampling: options.sampling ?? "all" })
