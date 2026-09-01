/**
 * Diff domain types for the {@link file://./diff-hunks.tsx DiffHunks} renderer.
 *
 * A `DiffFile` is one file's unified diff, already parsed into a flat list of
 * `DiffLine`s (context / add / del). `@@ … @@` hunk headers ride along as
 * tagged `context` lines, so {@link file://./diff-paginate.ts groupHunks} can
 * split a file back into hunks without guessing from file content. All types
 * are pure data with zero third-party imports.
 */

/** The three roles a rendered diff line can play. */
export type DiffLineKind = "context" | "add" | "del";

export type DiffLine = {
  kind: DiffLineKind;
  /** True only for a parsed `@@ … @@` hunk header. */
  header?: true;
  /** Line number in the OLD file (omitted for additions). */
  lnOld?: number;
  /** Line number in the new file (omitted for deletions). */
  ln?: number;
  text: string;
};

/**
 * A file's git status. Mirrors the VCS `ChangeStatus` letters a rail renders:
 * A added / M modified / D deleted / R renamed / ? unknown.
 */
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "unknown";

export type DiffFile = {
  path: string;
  add: number;
  del: number;
  lines: DiffLine[];
  /** A added / M modified / D deleted / R renamed / ? unknown (defaults modified). */
  status?: DiffFileStatus;
  /** True for binary blobs; a content pane renders a placeholder, never hunks. */
  isBinary?: boolean;
  /** Byte size, used by the binary placeholder's `byteCountString`. */
  sizeBytes?: number;
  /** The pre-rename path, shown as `(from oldPath)` for renamed files. */
  oldPath?: string;
  /** Raw mode-change lines (e.g. `old mode 100644` / `new mode 100755`). */
  modeChanges?: string[];
  /** The parser could not render every hunk; the view shows a warning. */
  partial?: boolean;
};

/** A whole diff: many files plus aggregate add/del counts. */
export type Diff = {
  id: string;
  title: string;
  files: DiffFile[];
  totalAdd: number;
  totalDel: number;
};

/** A contiguous block of diff lines under a single `@@ … @@` header. */
export type Hunk = {
  /** The `@@ -oldStart,oldLen +newStart,newLen @@` header string. */
  header: string;
  lines: DiffLine[];
};
