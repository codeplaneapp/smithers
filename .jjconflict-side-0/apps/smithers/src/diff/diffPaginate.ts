import type { Diff, DiffFile, DiffFileStatus, DiffLine } from "./Diff";

/**
 * Pure diff-rendering helpers, ported from the Swift DiffHunkView / DiffFileView
 * / DiffTab parser. Everything here is deterministic and DOM-free so the canvas
 * can lean on it and the domain test can exercise it directly:
 *
 * - `detectBinary`  → the `sawBinaryMarker` heuristic.
 * - `groupHunks`    → splits a file's flat lines into @@-headed hunks.
 * - `paginateHunks` → Swift's `displayedHunks`: trims whole hunks then partials.
 * - `initialExpanded` → Swift's large-diff expand seed (≤3 all, else first 3).
 * - `byteCountString` → the binary placeholder's human size formatter.
 */

/** A contiguous block of diff lines under a single `@@ … @@` header. */
export type Hunk = {
  /** The `@@ -oldStart,oldLen +newStart,newLen @@` header string. */
  header: string;
  lines: DiffLine[];
};

/** A file's normalized status, defaulting to "modified" when unset. */
export function fileStatus(file: DiffFile): DiffFileStatus {
  return file.status ?? "modified";
}

/** The single-letter status badge the rail renders (A/M/D/R/?). */
const STATUS_LETTER: Record<DiffFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  unknown: "?",
};

export function statusLetter(file: DiffFile): string {
  return STATUS_LETTER[fileStatus(file)];
}

/**
 * Detect a binary file. An explicit `isBinary` flag wins; otherwise we scan the
 * line text for git's binary markers (`GIT binary patch`, or a `Binary files …`
 * summary), porting the Swift parser's `sawBinaryMarker` logic.
 */
export function detectBinary(file: DiffFile): boolean {
  if (file.isBinary) return true;
  for (const line of file.lines) {
    const text = line.text;
    if (text.includes("GIT binary patch")) return true;
    if (text.startsWith("Binary files ")) return true;
  }
  return false;
}

/**
 * Group a file's flat line list into hunks. A line whose text starts with `@@`
 * opens a new hunk and supplies its header; any lines before the first header
 * land in a synthetic hunk with an empty header so nothing is dropped.
 */
export function groupHunks(file: DiffFile): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of file.lines) {
    if (line.kind === "context" && line.text.startsWith("@@")) {
      current = { header: line.text, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === null) {
      current = { header: "", lines: [] };
      hunks.push(current);
    }
    current.lines.push(line);
  }
  return hunks;
}

/** Total rendered line count for a file (the lines inside its hunks). */
export function fileLineCount(file: DiffFile): number {
  return groupHunks(file).reduce((sum, hunk) => sum + hunk.lines.length, 0);
}

/** Swift uses a 2000-line render budget per file; pagination kicks in above it. */
export const PAGINATE_THRESHOLD = 2000;
/** …and renders the first 1000 lines before the "Expand remaining" affordance. */
export const PAGINATE_VISIBLE = 1000;

/**
 * Trim a file's hunks to at most `visibleCount` lines, dropping whole trailing
 * hunks and then partially trimming the boundary hunk — exactly like Swift's
 * `displayedHunks`. Returns the kept hunks plus how many lines were hidden, so
 * the view can label the "Expand remaining N lines" button.
 */
export function paginateHunks(
  file: DiffFile,
  visibleCount: number,
): { hunks: Hunk[]; hidden: number } {
  const all = groupHunks(file);
  const total = all.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (visibleCount >= total) return { hunks: all, hidden: 0 };

  const kept: Hunk[] = [];
  let used = 0;
  for (const hunk of all) {
    if (used >= visibleCount) break;
    const remaining = visibleCount - used;
    if (hunk.lines.length <= remaining) {
      kept.push(hunk);
      used += hunk.lines.length;
    } else {
      kept.push({ header: hunk.header, lines: hunk.lines.slice(0, remaining) });
      used += remaining;
      break;
    }
  }
  return { hunks: kept, hidden: total - used };
}

/** A diff is "large" when it has many files or its bytes blow past ~1MB. */
export const LARGE_FILE_COUNT = 50;
export const LARGE_BYTE_LIMIT = 1_000_000;

export function totalBytes(diff: Diff): number {
  return diff.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
}

export function isLargeDiff(diff: Diff): boolean {
  return diff.files.length > LARGE_FILE_COUNT || totalBytes(diff) > LARGE_BYTE_LIMIT;
}

/**
 * The deterministic initial expanded set, ported from Swift: large diffs start
 * fully collapsed; ≤3 files expand every file; otherwise the first 3 expand and
 * the rest stay collapsed. Returns the file paths to mark expanded.
 */
export function initialExpanded(diff: Diff): string[] {
  if (isLargeDiff(diff)) return [];
  const paths = diff.files.map((file) => file.path);
  if (paths.length <= 3) return paths;
  return paths.slice(0, 3);
}

/** Aggregate add/del/file counts, summed from the files (never hardcoded). */
export function diffTotals(diff: Diff): { files: number; add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const file of diff.files) {
    add += file.add;
    del += file.del;
  }
  return { files: diff.files.length, add, del };
}

/**
 * Human byte-count string for the binary placeholder, ported from Swift's
 * `byteCountString`: bytes under 1024, KB under 1MB, else MB; one decimal for
 * the scaled units. An unknown size yields a plain "Binary file" upstream.
 */
export function byteCountString(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The binary placeholder label: sized when known, plain otherwise. */
export function binaryBodyLabel(file: DiffFile): string {
  if (typeof file.sizeBytes === "number") return `Binary file (${byteCountString(file.sizeBytes)})`;
  return "Binary file";
}
