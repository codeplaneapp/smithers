/** A unified diff the agent produced, shown as a card and a review canvas. */
export type DiffLineKind = "context" | "add" | "del";

export type DiffLine = {
  kind: DiffLineKind;
  /** Line number in the OLD file (omitted for additions). */
  lnOld?: number;
  /** Line number in the new file (omitted for deletions). */
  ln?: number;
  text: string;
};

/**
 * A file's git status. Mirrors the VCS `ChangeStatus` letters the rail renders:
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
  /** True for binary blobs; the content pane renders a placeholder, never hunks. */
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

export type Diff = {
  id: string;
  title: string;
  files: DiffFile[];
  totalAdd: number;
  totalDel: number;
};
