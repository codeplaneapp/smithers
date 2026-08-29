/**
 * Pure effect declarations used to describe flow read and write envelopes.
 *
 * Governing contract: `docs/specs/Concepts/Effect Taxonomy.md`.
 *
 * @since 0.0.0
 */

/**
 * A normalized description of the resources a flow or step may read and
 * write.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Declaration {
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly mode: "hermetic" | "expected"
  readonly onConflict: "serialize" | "lane" | "fail"
  readonly tier?: "sealed" | "compensable" | "irreversible" | undefined
}

/**
 * Input accepted by {@link make}. Iterables are normalized into sorted,
 * duplicate-free arrays so declarations are deterministic key material.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface MakeOptions {
  readonly reads: Iterable<string>
  readonly writes: Iterable<string>
  readonly mode: "hermetic" | "expected"
  readonly onConflict: "serialize" | "lane" | "fail"
  readonly tier?: "sealed" | "compensable" | "irreversible" | undefined
}

/**
 * A result of checking that a step declaration narrows a flow envelope.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type NarrowResult =
  | { readonly ok: true }
  | {
    readonly ok: false
    readonly code: "effect_outside_envelope" | "effect_mode_widening" | "effect_tier_widening"
    readonly paths: ReadonlyArray<string>
  }

const normalize = (paths: Iterable<string>): ReadonlyArray<string> => [...new Set(paths)].sort()

/**
 * Constructs a deterministic effect declaration.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const make = (input: MakeOptions): Declaration => ({
  reads: normalize(input.reads),
  writes: normalize(input.writes),
  mode: input.mode,
  onConflict: input.onConflict,
  ...(input.tier === undefined ? {} : { tier: input.tier })
})

/**
 * Checks whether `path` is covered by an envelope entry.
 *
 * The supported subset is exact paths plus prefix globs ending in `*` or
 * `/**`. A prefix glob matches every path beginning with the text before its
 * final star; this is intentionally not full minimatch syntax.
 *
 * @category predicates
 * @since 0.0.0
 * @slop
 */
export const covers = (envelope: string, path: string): boolean =>
  envelope === path ||
  (envelope.endsWith("/**") && path.startsWith(envelope.slice(0, -2))) ||
  (envelope.endsWith("*") && path.startsWith(envelope.slice(0, -1)))

const outside = (envelope: ReadonlyArray<string>, paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.filter((path) => !envelope.some((entry) => covers(entry, path)))

/**
 * Verifies that a step declaration stays within an enclosing flow envelope.
 *
 * Read and write paths must be covered independently. A step may tighten
 * `expected` to `hermetic`, but cannot widen `hermetic` to `expected`.
 * Effect tiers narrow from irreversible to compensable to sealed.
 *
 * @category validation
 * @since 0.0.0
 * @slop
 */
export const narrow = (envelope: Declaration, step: Declaration): NarrowResult => {
  const paths = normalize([...outside(envelope.reads, step.reads), ...outside(envelope.writes, step.writes)])
  if (paths.length > 0) {
    return { ok: false, code: "effect_outside_envelope", paths }
  }
  if (envelope.mode === "hermetic" && step.mode === "expected") {
    return { ok: false, code: "effect_mode_widening", paths: [] }
  }
  const tierRank = {
    sealed: 0,
    compensable: 1,
    irreversible: 2
  } as const
  if (tierRank[step.tier ?? "sealed"] > tierRank[envelope.tier ?? "sealed"]) {
    return { ok: false, code: "effect_tier_widening", paths: [] }
  }
  return { ok: true }
}

/**
 * Returns the concrete or narrower write declarations shared by two effect
 * declarations. The result is sorted and duplicate-free.
 *
 * @category analysis
 * @since 0.0.0
 * @slop
 */
export const overlaps = (a: Declaration, b: Declaration): ReadonlyArray<string> => {
  const matches: Array<string> = []
  for (const left of a.writes) {
    for (const right of b.writes) {
      if (covers(left, right)) {
        matches.push(right)
      } else if (covers(right, left)) {
        matches.push(left)
      }
    }
  }
  return normalize(matches)
}

/**
 * Returns a sealed, hermetic copy of an effect declaration.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const sealed = (declaration: Declaration): Declaration =>
  make({ ...declaration, mode: "hermetic", tier: "sealed" })
