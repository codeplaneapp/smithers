/**
 * Path indexing shared by effect matching and the graph's write-conflict pass.
 *
 * The pattern grammar is exhaustive: an entry ending in `*` matches by string
 * prefix and every other entry matches itself alone. Every path is read a
 * bounded number of times: once to look for a dot segment, once to detect a
 * pattern, and once per comparison a binary search needs while the distinct
 * paths are sorted and each pattern's prefix is located. After that a path is
 * an integer rank and every match is an integer comparison, so matching two
 * declarations costs their combined length plus the matches, whatever the
 * paths' lengths or how many patterns nest.
 *
 * Governing contract: `packages/core/docs/api.md`, published as
 * https://smithers.sh/api/core.
 *
 * @since 1.0.0-rc.0
 */

const SLASH = 47
const DOT = 46
const STAR = 42

/**
 * Whether `path` contains a whole `.` or `..` segment.
 *
 * A path with no `.` costs one native search. Otherwise the segments from the
 * one holding the first `.` onward are scanned once, without allocating.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const hasDotSegment = (path: string): boolean => {
  const first = path.indexOf(".")
  if (first === -1) return false
  const length = path.length
  let start = path.lastIndexOf("/", first) + 1
  for (let index = start; index <= length; index++) {
    if (index === length || path.charCodeAt(index) === SLASH) {
      const size = index - start
      if (size === 1 && path.charCodeAt(start) === DOT) return true
      if (size === 2 && path.charCodeAt(start) === DOT && path.charCodeAt(start + 1) === DOT) return true
      start = index + 1
    }
  }
  return false
}

/**
 * Whether an entry is a pattern: only a trailing `*` makes one.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const isGlob = (entry: string): boolean => entry.charCodeAt(entry.length - 1) === STAR

/**
 * The string prefix a pattern matches by: everything for `*` and `**`,
 * `prefix/` for `prefix/**`, and `prefix` for `prefix*`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const globPrefix = (glob: string): string =>
  glob === "*" || glob === "**" ? "" : glob.endsWith("/**") ? glob.slice(0, -2) : glob.slice(0, -1)

/**
 * Whether a pattern's prefix already holds a whole `.` or `..` segment. Every
 * path under such a prefix carries that segment, so the pattern covers nothing
 * and matches only an identical entry.
 */
const inertPrefix = (prefix: string): boolean => hasDotSegment(prefix.slice(0, prefix.lastIndexOf("/") + 1))

/**
 * The smallest string greater than every string that starts with `prefix`,
 * or `undefined` when no such string exists. Strings starting with `prefix`
 * are exactly those in `[prefix, successor(prefix))` in code-unit order, so a
 * sorted list answers "which entries start with `prefix`" with two binary
 * searches whose comparisons are native.
 */
const successor = (prefix: string): string | undefined => {
  let end = prefix.length
  while (end > 0 && prefix.charCodeAt(end - 1) === 0xffff) end--
  if (end === 0) return undefined
  return prefix.slice(0, end - 1) + String.fromCharCode(prefix.charCodeAt(end - 1) + 1)
}

/** The first position in a sorted list whose entry is not less than `value`. */
const lowerBound = (sorted: ReadonlyArray<string>, value: string): number => {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle]! < value) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/** The first position in a sorted rank list whose rank is not less than `value`. */
const lowerBoundRank = (sorted: Int32Array, value: number): number => {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle]! < value) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/**
 * The distinct paths of one or more declarations in code-unit order, with
 * what matching needs to know about each: its rank, whether it carries a dot
 * segment, whether it is a pattern that can cover anything, and for such a
 * pattern the rank interval its prefix covers.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface PathIndex {
  readonly paths: ReadonlyArray<string>
  readonly rank: ReadonlyMap<string, number>
  readonly dotted: Uint8Array
  readonly glob: Uint8Array
  readonly low: Int32Array
  readonly high: Int32Array
}

/**
 * Indexes the union of the given path lists.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const indexPaths = (lists: Iterable<ReadonlyArray<string>>): PathIndex => {
  const distinct = new Set<string>()
  for (const list of lists) {
    for (const path of list) distinct.add(path)
  }
  const paths = [...distinct].sort()
  const rank = new Map<string, number>()
  const count = paths.length
  const dotted = new Uint8Array(count)
  const glob = new Uint8Array(count)
  const low = new Int32Array(count).fill(-1)
  const high = new Int32Array(count).fill(-1)
  for (let index = 0; index < count; index++) {
    const path = paths[index]!
    rank.set(path, index)
    if (hasDotSegment(path)) dotted[index] = 1
    if (!isGlob(path)) continue
    const prefix = globPrefix(path)
    if (inertPrefix(prefix)) continue
    glob[index] = 1
    low[index] = lowerBound(paths, prefix)
    const next = successor(prefix)
    high[index] = next === undefined ? count : lowerBound(paths, next)
  }
  return { paths, rank, dotted, glob, low, high }
}

/**
 * One declaration's paths as ranks of a {@link PathIndex}: every path in
 * ascending rank order, and the patterns whose prefix intervals are not
 * contained in another of the declaration's patterns. Those intervals are
 * disjoint and ascending, so enumerating them visits each covered rank once.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Ranked {
  readonly ranks: Int32Array
  readonly globs: Int32Array
}

/**
 * Ranks a declaration's paths against an index that contains them.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const rankPaths = (index: PathIndex, paths: ReadonlyArray<string>): Ranked => {
  const ranks = Int32Array.from(paths, (path) => index.rank.get(path)!).sort()
  let distinct = 0
  for (let position = 0; position < ranks.length; position++) {
    if (position === 0 || ranks[position] !== ranks[position - 1]) ranks[distinct++] = ranks[position]!
  }
  const unique = ranks.subarray(0, distinct)
  const candidates: Array<number> = []
  for (const rank of unique) {
    if (index.glob[rank] === 1 && index.low[rank]! < index.high[rank]!) candidates.push(rank)
  }
  candidates.sort((left, right) =>
    index.low[left]! - index.low[right]! || index.high[right]! - index.high[left]!
  )
  const globs: Array<number> = []
  let coveredTo = -1
  for (const rank of candidates) {
    if (index.high[rank]! <= coveredTo) continue
    globs.push(rank)
    coveredTo = index.high[rank]!
  }
  return { ranks: unique, globs: Int32Array.from(globs) }
}

/** The ranks two ascending rank lists share, ascending. */
const shared = (a: Int32Array, b: Int32Array): Array<number> => {
  const matches: Array<number> = []
  let left = 0
  let right = 0
  while (left < a.length && right < b.length) {
    const x = a[left]!
    const y = b[right]!
    if (x === y) {
      matches.push(x)
      left++
      right++
    } else if (x < y) {
      left++
    } else {
      right++
    }
  }
  return matches
}

/** Merges ascending, duplicate-free rank lists into one, dropping repeats. */
const union = (lists: ReadonlyArray<ReadonlyArray<number>>): Array<number> => {
  const merged: Array<number> = []
  const cursors = lists.map(() => 0)
  while (true) {
    let smallest = -1
    for (let list = 0; list < lists.length; list++) {
      const cursor = cursors[list]!
      if (cursor < lists[list]!.length && (smallest === -1 || lists[list]![cursor]! < smallest)) {
        smallest = lists[list]![cursor]!
      }
    }
    if (smallest === -1) return merged
    merged.push(smallest)
    for (let list = 0; list < lists.length; list++) {
      const cursor = cursors[list]!
      if (cursor < lists[list]!.length && lists[list]![cursor] === smallest) cursors[list] = cursor + 1
    }
  }
}

/**
 * The ranks of the paths two write declarations share, ascending: a path of
 * `b` that `a` names or covers, and a path of `a` that `b` covers unless it is
 * the same pattern or itself covers that pattern. This is the pairwise
 * definition, exact paths matched through the merge of two sorted rank lists
 * and each covering pattern enumerating the ranks of the other declaration
 * inside its interval. Each of the three passes yields an ascending list, so
 * the result is their merge and no sort is needed.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const overlapRanks = (index: PathIndex, a: Ranked, b: Ranked): Array<number> => {
  const covered: Array<number> = []
  for (const glob of a.globs) {
    const high = index.high[glob]!
    for (let position = lowerBoundRank(b.ranks, index.low[glob]!); position < b.ranks.length; position++) {
      const rank = b.ranks[position]!
      if (rank >= high) break
      if (index.dotted[rank] === 0) covered.push(rank)
    }
  }
  const covering: Array<number> = []
  for (const glob of b.globs) {
    const high = index.high[glob]!
    const globDotted = index.dotted[glob] === 1
    for (let position = lowerBoundRank(a.ranks, index.low[glob]!); position < a.ranks.length; position++) {
      const rank = a.ranks[position]!
      if (rank >= high) break
      if (rank === glob || index.dotted[rank] === 1) continue
      if (index.glob[rank] === 1 && !globDotted && index.low[rank]! <= glob && glob < index.high[rank]!) continue
      covering.push(rank)
    }
  }
  const exact = shared(a.ranks, b.ranks)
  if (covered.length === 0 && covering.length === 0) return exact
  return union([exact, covered, covering])
}

/**
 * The ranks of `paths` that no entry of `envelope` names or covers, ascending.
 * A path carrying a dot segment is never covered.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const outsideRanks = (index: PathIndex, envelope: Ranked, paths: Ranked): Array<number> => {
  const covered = new Uint8Array(index.paths.length)
  let left = 0
  let right = 0
  while (left < envelope.ranks.length && right < paths.ranks.length) {
    const x = envelope.ranks[left]!
    const y = paths.ranks[right]!
    if (x === y) {
      covered[x] = 1
      left++
      right++
    } else if (x < y) {
      left++
    } else {
      right++
    }
  }
  for (const glob of envelope.globs) {
    const high = index.high[glob]!
    for (let position = lowerBoundRank(paths.ranks, index.low[glob]!); position < paths.ranks.length; position++) {
      const rank = paths.ranks[position]!
      if (rank >= high) break
      if (index.dotted[rank] === 0) covered[rank] = 1
    }
  }
  const outside: Array<number> = []
  for (const rank of paths.ranks) {
    if (index.dotted[rank] === 1 || covered[rank] === 0) outside.push(rank)
  }
  return outside
}
