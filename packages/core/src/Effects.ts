/**
 * Pure effect declarations used to describe flow read and write envelopes.
 *
 * Governing contract: `packages/core/docs/api.md`, published as
 * https://smithers.sh/api/core.
 *
 * @since 0.0.0
 */
import * as Index from "./internal/effects.ts"

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
 * Envelope entries and declared paths must already be path-normalized: no
 * separator or dot-segment rewriting is performed. A declared path containing
 * a whole `.` or `..` segment is never covered and therefore surfaces from
 * {@link narrow} as an `effect_outside_envelope` diagnostic.
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
 * The grammar is exhaustive: an exact path matches itself; `*` and `**` match
 * everything; `prefix*` matches by string prefix; and `prefix/**` matches
 * `prefix/` and everything below it, but not bare `prefix`. This is
 * intentionally not full minimatch syntax. Envelope entries and declared paths
 * must be normalized. A path containing a whole `.` or `..` segment is never
 * covered, so {@link narrow} reports it as `effect_outside_envelope` rather
 * than silently accepting an escape.
 *
 * @category predicates
 * @since 0.0.0
 * @slop
 */
export const covers = (envelope: string, path: string): boolean => {
  if (Index.hasDotSegment(path)) return false
  return envelope === path || (Index.isGlob(envelope) && path.startsWith(Index.globPrefix(envelope)))
}

/**
 * Verifies that a step declaration stays within an enclosing flow envelope.
 *
 * Read and write paths must be covered independently. A step may tighten
 * `expected` to `hermetic`, but cannot widen `hermetic` to `expected`.
 * Effect tiers narrow from irreversible to compensable to sealed.
 *
 * The envelope's lists are prepared once: exact entries go into a set and
 * covering patterns collapse to their outermost prefixes, sorted, so each step
 * path costs one dot-segment scan, one lookup, and one binary search ending in
 * one prefix comparison, whatever the envelope's width or how many of its
 * patterns nest. `Graph.build` prepares each envelope once for every node it
 * encloses.
 *
 * @category validation
 * @since 0.0.0
 * @slop
 */
export const narrow = (envelope: Declaration, step: Declaration): NarrowResult =>
  Index.narrowPrepared(Index.prepareEnvelope(envelope), step)

/**
 * Returns the concrete or narrower write declarations shared by two effect
 * declarations. The result is sorted and duplicate-free.
 *
 * Two declarations of the same literal path always overlap, including a path
 * {@link covers} refuses to match because it carries a `.` or `..` segment.
 * Glob coverage stays strict for those paths, so an unnormalized declaration
 * still escapes no envelope, but two writers naming the same unnormalized path
 * are still detected as writing the same resource.
 *
 * The union of both declarations is indexed once: the distinct paths are
 * sorted, each is scanned once for a dot segment, and each pattern's prefix
 * is located by binary search. Exact paths then match through a merge of two
 * rank lists and each covering pattern enumerates the other declaration's
 * ranks inside its interval, so the cost is linear in the two declarations
 * plus the matches, whatever the paths' lengths or how many patterns nest.
 *
 * @category analysis
 * @since 0.0.0
 * @slop
 */
export const overlaps = (a: Declaration, b: Declaration): ReadonlyArray<string> => {
  const indexed = Index.indexPaths([a.writes, b.writes])
  return Index.overlapRanks(indexed, Index.rankPaths(indexed, a.writes), Index.rankPaths(indexed, b.writes))
    .map((rank) => indexed.paths[rank]!)
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
