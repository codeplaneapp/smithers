/** Strictly parse unified-diff hunks.  A malformed patch is never a source of
 * inline-comment capabilities. */
export type LineInterval = readonly [start: number, end: number];
export type UnifiedPatchStats = { additions: number; deletions: number; rightLines: Set<number> };

/** A canonical immutable Set facade backed by diff intervals rather than one
 * allocation per line. Iteration remains Set-compatible for existing callers,
 * while authorization checks can consume the compact intervals directly. */
export class CanonicalReviewLineSet extends Set<number> {
  readonly intervals: readonly LineInterval[];
  readonly #lineCount: number;

  constructor(intervals: readonly LineInterval[]) {
    super();
    let previous = 0;
    let lineCount = 0;
    const canonical = intervals.map(([start, end]) => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || start <= previous) {
        throw new Error("review line intervals are noncanonical");
      }
      const count = end - start + 1;
      lineCount += count;
      if (!Number.isSafeInteger(lineCount)) throw new Error("review line interval count is oversized");
      previous = end;
      return Object.freeze([start, end] as const);
    });
    this.intervals = Object.freeze(canonical);
    this.#lineCount = lineCount;
    Object.freeze(this);
  }

  override get size(): number { return this.#lineCount; }

  override has(value: number): boolean {
    return intervalContains(this.intervals, value, value);
  }

  override *values(): SetIterator<number> {
    for (const [start, end] of this.intervals) {
      for (let line = start; line <= end; line += 1) yield line;
    }
  }

  override keys(): SetIterator<number> { return this.values(); }

  override *entries(): SetIterator<[number, number]> {
    for (const line of this.values()) yield [line, line];
  }

  override [Symbol.iterator](): SetIterator<number> { return this.values(); }

  override forEach(callbackfn: (value: number, value2: number, set: Set<number>) => void, thisArg?: unknown): void {
    for (const line of this.values()) callbackfn.call(thisArg, line, line, this);
  }

  override add(_value: number): this { throw new Error("review line capabilities are immutable"); }
  override delete(_value: number): boolean { throw new Error("review line capabilities are immutable"); }
  override clear(): void { throw new Error("review line capabilities are immutable"); }
}

const MATERIALIZED_LINE_SET_LIMIT = 10_000;

/** Preserve ordinary Set behavior for normal diffs while switching large
 * capabilities to the interval-backed representation before memory scales
 * with line count. */
export function reviewLineSet(intervals: readonly LineInterval[]): Set<number> {
  const compact = new CanonicalReviewLineSet(intervals);
  return compact.size <= MATERIALIZED_LINE_SET_LIMIT ? new Set(compact) : compact;
}

export function canonicalLineIntervals(lines: ReadonlySet<number>): readonly LineInterval[] {
  if (lines instanceof CanonicalReviewLineSet) return lines.intervals;
  const intervals: LineInterval[] = [];
  let previous = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line) || line <= previous) {
      throw new Error("immutable patch capability lines are noncanonical");
    }
    const last = intervals.at(-1);
    if (last && line === previous + 1) intervals[intervals.length - 1] = [last[0], line];
    else intervals.push([line, line]);
    previous = line;
  }
  return intervals;
}

export function intervalContains(intervals: readonly LineInterval[], start: number, end: number): boolean {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return false;
  let low = 0;
  let high = intervals.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (intervals[middle][0] <= start) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate >= 0 && intervals[candidate][1] >= end;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

export function parseUnifiedPatch(patch: string, options: { canonical?: boolean } = {}): UnifiedPatchStats {
  // The renderer deliberately remains liberal for diffs obtained from APIs.
  // Immutable manifests use the canonical mode: Git's LF-terminated wire
  // representation, with no invisible trailing blank record.
  if (options.canonical) {
    // Git always separates patch records with LF, but hunk payload bytes may
    // legitimately contain carriage returns from a CRLF source file. JSONL
    // escapes those bytes, and the hunk parser keys only on the operation byte,
    // so preserving them is both unambiguous and necessary for Windows files.
    if (!patch.endsWith("\n") || patch.endsWith("\n\n")) {
      throw new Error("unified patch is not canonical Git text");
    }
  } else {
    if (patch.includes("\r")) patch = patch.replace(/\r\n/g, "\n");
    if (patch.includes("\r")) throw new Error("unified patch contains bare CR bytes");
  }
  const lines = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
  const rightLines = new Set<number>();
  const compactIntervals: LineInterval[] = [];
  let additions = 0;
  let deletions = 0;
  let sawHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  let nextRight = 0;
  // Git emits the no-newline marker immediately after the affected line, not
  // after the hunk.  A replacement where both sides lack a final newline has
  // two markers with a `+` line between them, so this is deliberately not an
  // end-of-hunk sentinel.
  let previous: "old" | "new" | "both" | undefined;
  let oldClosed = false;
  let newClosed = false;
  let hunkEnded = false;
  let previousOldEnd = 0;
  let previousNewEnd = 0;
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      if (oldClosed || newClosed) throw new Error("unified patch has content after a no-newline file end");
      if (!sawHunk || oldRemaining !== 0 || newRemaining !== 0 || !hunkEnded) {
        if (sawHunk) throw new Error("unified patch hunk count is mismatched");
      }
      const oldStart = Number(hunk[1]); const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const newStart = Number(hunk[3]); const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart)
        || !Number.isSafeInteger(oldCount) || !Number.isSafeInteger(newCount)
        || oldStart < 0 || newStart < 0 || oldCount < 0 || newCount < 0
        || (oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)) throw new Error("unified patch hunk range is invalid");
      const oldEnd = oldStart + oldCount;
      const newEnd = newStart + newCount;
      if (!Number.isSafeInteger(oldEnd) || !Number.isSafeInteger(newEnd)) throw new Error("unified patch hunk range is invalid");
      if (options.canonical) {
        // Git omits a count of one and never emits leading-zero range numbers.
        // A zero-count range may start after line zero (for example a
        // zero-context insertion in the middle of a file), so its start is not
        // constrained to zero.
        if ((hunk[2] === undefined) !== (oldCount === 1) || (hunk[4] === undefined) !== (newCount === 1)
          || hunk[1] !== String(oldStart) || hunk[3] !== String(newStart)
          || (hunk[2] !== undefined && hunk[2] !== String(oldCount))
          || (hunk[4] !== undefined && hunk[4] !== String(newCount))
          || (sawHunk && (oldStart < previousOldEnd || newStart < previousNewEnd))) {
          throw new Error("unified patch hunk range is not canonical");
        }
      }
      oldRemaining = oldCount; newRemaining = newCount; nextRight = newStart; sawHunk = true;
      previousOldEnd = oldEnd;
      previousNewEnd = newEnd;
      if (options.canonical && newCount > 0) {
        const end = newEnd - 1;
        const last = compactIntervals.at(-1);
        if (last && newStart === last[1] + 1) compactIntervals[compactIntervals.length - 1] = [last[0], end];
        else compactIntervals.push([newStart, end]);
      }
      previous = undefined; hunkEnded = oldCount === 0 && newCount === 0;
      continue;
    }
    if (!sawHunk) continue; // manifest validation owns preamble grammar
    if (line === "\\ No newline at end of file") {
      // It applies to the immediately preceding hunk line.  Counters may
      // still be nonzero because the other side of a replacement follows.
      if (!previous) throw new Error("unified patch has misplaced no-newline marker");
      if ((previous === "old" && oldClosed) || (previous === "new" && newClosed)
        || (previous === "both" && (oldClosed || newClosed))) {
        throw new Error("unified patch has duplicate no-newline marker");
      }
      // A context line exists on both sides. Git uses one marker for it when
      // both files end there, so it closes both sides rather than being
      // ambiguous. Any following hunk content is consequently rejected.
      if (previous === "both") { oldClosed = true; newClosed = true; }
      else if (previous === "old") oldClosed = true;
      else newClosed = true;
      previous = undefined;
      continue;
    }
    if (oldRemaining === 0 && newRemaining === 0) {
      throw new Error("unified patch has content outside a hunk");
    }
    const first = line[0];
    if (first === " ") {
      if (oldRemaining < 1 || newRemaining < 1 || oldClosed || newClosed) throw new Error("unified patch hunk count is mismatched");
      oldRemaining--; newRemaining--;
      if (!options.canonical) rightLines.add(nextRight);
      nextRight++;
      previous = "both";
    } else if (first === "+") {
      if (newRemaining < 1 || newClosed) throw new Error("unified patch hunk count is mismatched");
      newRemaining--; additions++;
      if (!options.canonical) rightLines.add(nextRight);
      nextRight++;
      previous = "new";
    } else if (first === "-") {
      if (oldRemaining < 1 || oldClosed) throw new Error("unified patch hunk count is mismatched");
      oldRemaining--; deletions++;
      previous = "old";
    } else throw new Error("unified patch line is invalid");
    hunkEnded = oldRemaining === 0 && newRemaining === 0;
  }
  if (!sawHunk) {
    if (options.canonical) throw new Error("unified patch has no hunks");
    return { additions, deletions, rightLines };
  }
  if (oldRemaining !== 0 || newRemaining !== 0 || !hunkEnded) throw new Error("unified patch hunk count is mismatched");
  return {
    additions,
    deletions,
    rightLines: options.canonical ? reviewLineSet(compactIntervals) : rightLines,
  };
}

export function parsePatchCommentableLines(patch: string): Set<number> {
  if (!patch.trim()) return new Set();
  return parseUnifiedPatch(patch).rightLines;
}
