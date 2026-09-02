/**
 * Pure effect declarations used to describe flow read and write envelopes.
 *
 * Governing contract: `packages/core/docs/api.md`, published as
 * https://smithers.sh/api/core.
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

const hasDotSegment = (path: string): boolean => path.split("/").some((segment) => segment === "." || segment === "..")

/**
 * Whether an entry is a pattern. {@link covers} treats only a trailing `*` as
 * one; every other entry matches itself alone.
 */
const isGlob = (entry: string): boolean => entry.endsWith("*")

/**
 * The string prefix a glob entry matches by: everything for `*` and `**`,
 * `prefix/` for `prefix/**`, and `prefix` for `prefix*`. This is the whole
 * pattern grammar, so a sorted path list can answer "which paths does this
 * glob cover" from one binary search.
 */
const globPrefix = (glob: string): string =>
  glob === "*" || glob === "**" ? "" : glob.endsWith("/**") ? glob.slice(0, -2) : glob.slice(0, -1)

/**
 * Returns the paths in code-unit order, reusing the array {@link make} already
 * sorted and copying only a caller-assembled declaration.
 */
const sorted = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  for (let index = 1; index < paths.length; index++) {
    if (paths[index - 1]! > paths[index]!) return [...paths].sort()
  }
  return paths
}

/**
 * Returns every entry of a sorted list that starts with `prefix`. Those
 * entries are contiguous in code-unit order, so the block is found by binary
 * search and the cost is the number of matches rather than the list length.
 */
const prefixed = (paths: ReadonlyArray<string>, prefix: string): ReadonlyArray<string> => {
  let low = 0
  let high = paths.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (paths[middle]! < prefix) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  let end = low
  while (end < paths.length && paths[end]!.startsWith(prefix)) end++
  return paths.slice(low, end)
}

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
  if (hasDotSegment(path)) return false
  return envelope === path || (isGlob(envelope) && path.startsWith(globPrefix(envelope)))
}

/**
 * Returns the paths no envelope entry covers. Exact entries are indexed in a
 * set and only the glob entries are scanned per path, so a wide literal
 * envelope costs one lookup per path instead of one comparison per pair.
 */
const outside = (envelope: ReadonlyArray<string>, paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const exact = new Set<string>()
  const prefixes: Array<string> = []
  for (const entry of envelope) {
    if (isGlob(entry)) {
      prefixes.push(globPrefix(entry))
    } else {
      exact.add(entry)
    }
  }
  return paths.filter((path) =>
    hasDotSegment(path) || (!exact.has(path) && !prefixes.some((prefix) => path.startsWith(prefix)))
  )
}

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
 * Two declarations of the same literal path always overlap, including a path
 * {@link covers} refuses to match because it carries a `.` or `..` segment.
 * Glob coverage stays strict for those paths, so an unnormalized declaration
 * still escapes no envelope, but two writers naming the same unnormalized path
 * are still detected as writing the same resource.
 *
 * Exact paths are matched through a set and the paths a glob covers are found
 * by binary search over the sorted declaration, so the cost is linear in the
 * two declarations plus the matches rather than their product.
 *
 * @category analysis
 * @since 0.0.0
 * @slop
 */
export const overlaps = (a: Declaration, b: Declaration): ReadonlyArray<string> => {
  const matches: Array<string> = []
  const leftSorted = sorted(a.writes)
  const rightSorted = sorted(b.writes)
  const rightPaths = new Set(b.writes)
  // A pair matches from the left when `a`'s entry is the same path or a glob
  // covering `b`'s entry. An exact entry can only equal, so it costs one set
  // lookup; a glob enumerates the block of `b`'s paths under its prefix.
  for (const left of a.writes) {
    if (isGlob(left)) {
      for (const right of prefixed(rightSorted, globPrefix(left))) {
        if (left === right || !hasDotSegment(right)) matches.push(right)
      }
    } else if (rightPaths.has(left)) {
      matches.push(left)
    }
  }
  // Otherwise the pair matches from the right when `b`'s glob covers `a`'s
  // entry. `b`'s exact entries were settled above, so only its globs are
  // enumerated, each over the block of `a`'s paths under its prefix.
  for (const right of b.writes) {
    if (!isGlob(right)) continue
    const rightDotted = hasDotSegment(right)
    for (const left of prefixed(leftSorted, globPrefix(right))) {
      if (left === right || hasDotSegment(left)) continue
      if (isGlob(left) && !rightDotted && right.startsWith(globPrefix(left))) continue
      matches.push(left)
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
