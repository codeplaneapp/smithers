/** @jsxImportSource react */
import { useMemo, type ReactNode } from "react";
import {
  processPatch,
  type CodeViewItem,
  type DiffsThemeNames,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { useResolvedTheme } from "../internal/useResolvedTheme";

/**
 * PierreDiffView is the high-fidelity, syntax-highlighted diff surface: it runs
 * a unified patch through `@pierre/diffs` `processPatch` and renders it with the
 * `CodeView` React widget, which tokenizes every line through Shiki. It lives in
 * the `adapters` layer because `@pierre/diffs` is a heavy widget dependency; the
 * base `@smithers-orchestrator/ui` barrel never pulls it in, so consumers opt in
 * through the `@smithers-orchestrator/ui/adapters/pierre-diff-view` subpath.
 *
 * The component is fully props-driven with no app coupling. Multi's original
 * carried an app `Theme` import; here an optional `mode` prop overrides the
 * active house theme and maps onto a `DiffsThemeNames` value. Layout is a
 * `layout` prop (`"split"` side-by-side vs `"inline"` unified).
 */

export type PierreDiffMode = "light" | "dark";

/** Side-by-side (`split`) vs a single unified column (`inline`). */
export type PierreDiffLayout = "split" | "inline";

/**
 * Map the theme `mode` onto the Shiki-bundled `DiffsThemeNames` value CodeView
 * expects. Replaces Multi's coupling to the app `Theme` store.
 */
export function diffsThemeForMode(mode: PierreDiffMode): DiffsThemeNames {
  return mode === "dark" ? "github-dark" : "github-light";
}

/** Map the layout prop onto CodeView's `diffStyle` option. */
export function diffStyleForLayout(layout: PierreDiffLayout): "split" | "unified" {
  return layout === "inline" ? "unified" : "split";
}

/** Strip surrounding quotes and a leading `a/` or `b/` from a diff path. */
export function normalizeDiffPath(path: string | undefined): string {
  return (path ?? "").replace(/^"(.*)"$/, "$1").replace(/^[ab]\//, "");
}

function diffStats(file: FileDiffMetadata): { additions: number; deletions: number } {
  let add = 0;
  let del = 0;
  for (const hunk of file.hunks) {
    add += hunk.additionLines;
    del += hunk.deletionLines;
  }
  return { additions: add, deletions: del };
}

/**
 * Parse a unified patch into the `CodeViewItem[]` CodeView renders, optionally
 * narrowed to a single file by its (normalized) path. `processPatch` runs in
 * throw-on-error mode so a malformed or partially synthesized patch would
 * otherwise throw straight out of render; with no error boundary in the consumer
 * tree that would blank the whole surface, so we degrade honestly to `[]` ("no
 * diff available") instead.
 */
export function patchToCodeViewItems(patch: string, selectedPath?: string | null): CodeViewItem[] {
  if (!patch.trim()) return [];
  let files: FileDiffMetadata[];
  try {
    files = processPatch(patch, "pierre-diff", true).files;
  } catch {
    return [];
  }

  let shown = files;
  if (selectedPath) {
    const selected = files.filter((file) => {
      const path = normalizeDiffPath(file.name);
      const previous = normalizeDiffPath(file.prevName);
      return path === selectedPath || previous === selectedPath;
    });
    if (selected.length > 0) shown = selected;
  }

  return shown.map((file) => ({
    id: normalizeDiffPath(file.name) || file.name,
    type: "diff",
    fileDiff: file,
  }));
}

export type PierreDiffViewProps = {
  /** A unified diff (git-style) patch string. */
  patch: string;
  /** Side-by-side (`split`, default) or unified (`inline`) rendering. */
  layout?: PierreDiffLayout;
  /** Theme mode mapped onto a `DiffsThemeNames` value. Defaults to the active house theme. */
  mode?: PierreDiffMode;
  /** When set, only the matching file in a multi-file patch is shown. */
  selectedPath?: string | null;
  /** Extra class on the CodeView (and the empty-state fallback). */
  className?: string;
  /** Message shown when the patch is empty or unparseable. */
  emptyLabel?: ReactNode;
};

export function PierreDiffView({
  patch,
  layout = "split",
  mode,
  selectedPath = null,
  className,
  emptyLabel,
}: PierreDiffViewProps) {
  useInjectUiCss();
  const houseTheme = useResolvedTheme();
  const resolvedMode = mode ?? houseTheme;
  const items = useMemo(() => patchToCodeViewItems(patch, selectedPath), [patch, selectedPath]);

  if (items.length === 0) {
    return (
      <div className={cn("sui-pierre-diff-empty", className)} data-slot="pierre-diff-view" data-theme-mode={resolvedMode}>
        {emptyLabel ?? "No diff is available for this change."}
      </div>
    );
  }

  const renderStats = (file: FileDiffMetadata) => {
    const stats = diffStats(file);
    return (
      <span className="sui-pierre-diff-stat">
        <span className="sui-pierre-diff-stat-add">+{stats.additions}</span>{" "}
        <span className="sui-pierre-diff-stat-del">-{stats.deletions}</span>
      </span>
    );
  };

  return (
    <div className="sui-pierre-diff-frame" data-slot="pierre-diff-view" data-theme-mode={resolvedMode}>
      <CodeView
        className={cn("sui-pierre-diff", className)}
        disableWorkerPool
        items={items}
        options={{
          collapsedContextThreshold: 12,
          diffIndicators: "bars",
          diffStyle: diffStyleForLayout(layout),
          hunkSeparators: "metadata",
          overflow: "wrap",
          stickyHeaders: true,
          theme: diffsThemeForMode(resolvedMode),
          themeType: resolvedMode,
        }}
        renderHeaderMetadata={(item) =>
          item.type === "diff" ? renderStats(item.fileDiff) : null
        }
      />
    </div>
  );
}
