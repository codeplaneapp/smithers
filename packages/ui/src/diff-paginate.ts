import type { Diff, DiffFile, DiffFileStatus, DiffLine, Hunk } from "./diff";

/**
 * Pure, DOM-free diff domain for the {@link file://./diff-hunks.tsx DiffHunks}
 * renderer. Everything here is deterministic so the domain tests can exercise it
 * directly and callers can lean on it without a runtime:
 *
 * - `parseUnifiedFile` / `parseHunks` → turn a raw unified patch into a
 *   `DiffFile` (add/del totals, per-line numbering, status, rename + mode edges).
 * - `detectBinary`  → the git binary-marker heuristic.
 * - `groupHunks`    → split a file's flat lines into `@@`-headed hunks.
 * - `paginateHunks` → trim whole hunks then partials to a line budget.
 * - `initialExpanded` → the large-diff expand seed (≤3 all, else first 3).
 * - `byteCountString` → the binary placeholder's human size formatter.
 */

export type { Hunk } from "./diff";

/** A file's normalized status, defaulting to "modified" when unset. */
export function fileStatus(file: DiffFile): DiffFileStatus {
  return file.status ?? "modified";
}

/** The single-letter status badge a rail renders (A/M/D/R/?). */
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
 * summary).
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
 * Group a file's flat line list into hunks. Parsed header tags open hunks;
 * lines before the first header land in a synthetic hunk with an empty header
 * so nothing is dropped.
 */
export function groupHunks(file: DiffFile): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of file.lines) {
    if (line.header === true) {
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

/** A generous render budget per file; pagination kicks in above it. */
export const PAGINATE_THRESHOLD = 2000;
/** …and renders the first this-many lines before the "Expand remaining" affordance. */
export const PAGINATE_VISIBLE = 1000;

/**
 * Trim a file's hunks to at most `visibleCount` lines, dropping whole trailing
 * hunks and then partially trimming the boundary hunk. Returns the kept hunks
 * plus how many lines were hidden, so the view can label the "Expand remaining
 * N lines" button.
 */
export function paginateHunks(file: DiffFile, visibleCount: number): { hunks: Hunk[]; hidden: number } {
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
 * The deterministic initial expanded set: large diffs start fully collapsed; ≤3
 * files expand every file; otherwise the first 3 expand and the rest stay
 * collapsed. Returns the file paths to mark expanded.
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
 * Human byte-count string for the binary placeholder: bytes under 1024, KB
 * under 1MB, else MB; one decimal for the scaled units. An unknown size yields
 * a plain "Binary file" upstream.
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

/* -------------------------------------------------------------------------- */
/* Unified-patch parsing                                                      */
/* -------------------------------------------------------------------------- */

const BINARY_PATCH_RE = /(^GIT binary patch$)|(^Binary files )/m;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse the hunk body of a unified patch into flat `DiffLine`s, counting
 * additions and deletions and numbering each side. `@@ … @@` headers ride along
 * as tagged `context` lines so {@link groupHunks} can re-split later. `partial`
 * is true when the text looks like it has hunks but none parsed (a truncated
 * patch).
 */
export function parseHunks(diffText: string): {
  lines: DiffLine[];
  add: number;
  del: number;
  partial: boolean;
} {
  const lines: DiffLine[] = [];
  let add = 0;
  let del = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let sawHunk = false;

  for (const raw of diffText.split(/\r?\n/)) {
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      sawHunk = true;
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: "context", header: true, text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw === "") {
      lines.push({ kind: "context", lnOld: oldLine, ln: newLine, text: raw });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (raw.startsWith("\\ No newline")) continue;
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", ln: newLine, text: raw.slice(1) });
      newLine += 1;
      add += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ kind: "del", lnOld: oldLine, text: raw.slice(1) });
      oldLine += 1;
      del += 1;
      continue;
    }
    if (raw.startsWith(" ")) {
      lines.push({ kind: "context", lnOld: oldLine, ln: newLine, text: raw.slice(1) });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (raw.startsWith("diff --git ") || raw.startsWith("@@ ")) {
      inHunk = false;
    }
  }

  return { lines, add, del, partial: diffText.includes("@@ ") && !sawHunk };
}

function statusFromDiffText(diffText: string): DiffFileStatus {
  if (/^rename from /m.test(diffText) || /^rename to /m.test(diffText)) return "renamed";
  if (/^new file mode /m.test(diffText) || /^--- \/dev\/null$/m.test(diffText)) return "added";
  if (/^deleted file mode /m.test(diffText) || /^\+\+\+ \/dev\/null$/m.test(diffText)) return "deleted";
  return "modified";
}

function pathFromDiffText(diffText: string): string {
  const git = /^diff --git a\/(.+?) b\/(.+)$/m.exec(diffText);
  if (git) return git[2]!.trim();
  const rename = /^rename to (.+)$/m.exec(diffText)?.[1]?.trim();
  if (rename) return rename;
  const plus = /^\+\+\+ b\/(.+)$/m.exec(diffText)?.[1]?.trim();
  if (plus && plus !== "/dev/null") return plus;
  const minus = /^--- a\/(.+)$/m.exec(diffText)?.[1]?.trim();
  if (minus && minus !== "/dev/null") return minus;
  return "";
}

function oldPathFrom(diffText: string): string | undefined {
  const renamed = /^rename from (.+)$/m.exec(diffText)?.[1]?.trim();
  if (renamed) return renamed;
  const header = /^--- a\/(.+)$/m.exec(diffText)?.[1]?.trim();
  return header && header !== "/dev/null" ? header : undefined;
}

function modeChangesFrom(diffText: string): string[] {
  return diffText
    .split(/\r?\n/)
    .filter((line) =>
      /^(old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index) /.test(line),
    );
}

/** Overrides for {@link parseUnifiedFile} when metadata is known out of band. */
export type ParseUnifiedFileOverrides = {
  /** Force the file path instead of reading it from the patch headers. */
  path?: string;
  /** Force the status instead of inferring it from the patch headers. */
  status?: DiffFileStatus;
  /** Mark the file binary regardless of markers (skips hunk parsing). */
  isBinary?: boolean;
  /** Byte size for the binary placeholder. */
  sizeBytes?: number;
};

/**
 * Parse one file's unified patch into a `DiffFile`: path, add/del totals,
 * per-line numbering, status, rename `oldPath`, and any mode-change lines.
 * Binary patches (or an explicit `isBinary` override) skip hunk parsing and
 * render a placeholder instead of lines.
 */
export function parseUnifiedFile(diffText: string, overrides: ParseUnifiedFileOverrides = {}): DiffFile {
  const path = (overrides.path ?? pathFromDiffText(diffText)).trim();
  const binary = overrides.isBinary === true || BINARY_PATCH_RE.test(diffText);
  const parsed = binary ? { lines: [], add: 0, del: 0, partial: false } : parseHunks(diffText);
  const oldPath = oldPathFrom(diffText);
  const modeChanges = modeChangesFrom(diffText);
  return {
    path,
    add: parsed.add,
    del: parsed.del,
    lines: parsed.lines,
    status: overrides.status ?? statusFromDiffText(diffText),
    ...(binary ? { isBinary: true } : {}),
    ...(typeof overrides.sizeBytes === "number" ? { sizeBytes: overrides.sizeBytes } : {}),
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    ...(modeChanges.length > 0 ? { modeChanges } : {}),
    ...(parsed.partial ? { partial: true } : {}),
  };
}
