import "./diff.css";
import { useEffect } from "react";
import type { DiffFile } from "./Diff";
import { AUTH_REFACTOR_DIFF } from "./authRefactorDiff";
import {
  binaryBodyLabel,
  detectBinary,
  diffTotals,
  fileStatus,
  initialExpanded,
  isLargeDiff,
  statusLetter,
} from "./diffPaginate";
import { useDiffStore } from "./diffStore";
import { DiffHunks } from "./DiffHunks";

/** Tone class for a file's status letter badge. */
function statusTone(file: DiffFile): string {
  switch (fileStatus(file)) {
    case "added":
      return "tone-ok";
    case "deleted":
      return "tone-failed";
    case "renamed":
      return "tone-info";
    case "unknown":
      return "tone-idle";
    default:
      return "tone-running";
  }
}

function DocIcon() {
  return (
    <svg className="diff-binary-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 3h7l5 5v13H7zM14 3v5h5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The body of the selected file: binary placeholder, status notice, or hunks. */
function FileBody({ diffId, file }: { diffId: string; file: DiffFile }) {
  const revealed = useDiffStore((state) => (state.revealedByDiff[diffId] ?? []).includes(file.path));
  const revealRemaining = useDiffStore((state) => state.revealRemaining);
  const status = fileStatus(file);

  if (detectBinary(file)) {
    return (
      <div className="diff-binary-body">
        <DocIcon />
        <span>{binaryBodyLabel(file)}</span>
      </div>
    );
  }

  return (
    <>
      {status === "deleted" ? <div className="diff-notice is-deleted">File deleted</div> : null}
      {status === "added" ? <div className="diff-notice is-added">New file</div> : null}
      {file.partial ? <div className="diff-partial-warn">Partial parse: some hunks could not be rendered.</div> : null}
      {file.lines.length > 0 ? (
        <DiffHunks file={file} revealed={revealed} onReveal={() => revealRemaining(diffId, file.path)} />
      ) : null}
    </>
  );
}

/**
 * The full diff review surface: a left file-selector rail and a right content
 * pane. The rail rows carry a status badge, a binary tag, per-file counts, and a
 * collapse/expand chevron; the content pane renders the active file's hunks (or
 * a binary/status placeholder). Aggregate counts, the large-diff warning, and
 * the expand seed are all derived purely from the seed.
 */
export function DiffCanvas() {
  const diff = AUTH_REFACTOR_DIFF;
  const totals = diffTotals(diff);
  const large = isLargeDiff(diff);
  const seedExpanded = initialExpanded(diff);

  const active = useDiffStore((state) => state.activeByDiff[diff.id] ?? 0);
  // Fall back to the deterministic seed when this diff hasn't been touched yet.
  const expandedRaw = useDiffStore((state) => state.expandedByDiff[diff.id]);
  const expanded = expandedRaw ?? seedExpanded;
  const selectFile = useDiffStore((state) => state.selectFile);
  const toggleExpanded = useDiffStore((state) => state.toggleExpanded);
  const expandAll = useDiffStore((state) => state.expandAll);
  const collapseAll = useDiffStore((state) => state.collapseAll);
  const resetReveal = useDiffStore((state) => state.resetReveal);

  const allPaths = diff.files.map((file) => file.path);
  const activeFile = diff.files[active];

  // Seed the store's expanded set with the displayed default ONCE, so per-file
  // toggles (the head chevron and the row auto-expand below) operate on what is
  // actually shown. Without this, `toggleExpanded` starts from an empty set
  // while the canvas renders `seedExpanded` (the first few files), so the first
  // interaction wrongly collapses every OTHER file instead of toggling the one
  // clicked. Re-runs are no-ops once `expandedRaw` is defined (incl. after
  // Collapse-all sets it to []), so this never fights the user's own toggles.
  useEffect(() => {
    if (expandedRaw === undefined) expandAll(diff.id, seedExpanded);
  }, [diff.id, expandedRaw, seedExpanded, expandAll]);

  // Selecting a row re-paginates the file we're leaving (Swift resets
  // showRemainingLines on file.id change) and expands the row we land on.
  const onSelect = (index: number) => {
    if (activeFile && index !== active) resetReveal(diff.id, activeFile.path);
    const target = diff.files[index];
    if (target && !expanded.includes(target.path)) toggleExpanded(diff.id, target.path);
    selectFile(diff.id, index);
  };

  if (diff.files.length === 0) {
    return (
      <section className="surface" data-testid="diff-canvas">
        <header className="surface-head">
          <span className="surface-title">{diff.title}</span>
        </header>
        <div className="surface-empty">No file changes.</div>
      </section>
    );
  }

  return (
    <section className="surface" data-testid="diff-canvas">
      <header className="surface-head">
        <span className="surface-title">{diff.title}</span>
        <span className="surface-sub">
          {totals.files} file{totals.files === 1 ? "" : "s"} · <span className="delta-add">+{totals.add}</span>{" "}
          <span className="delta-del">−{totals.del}</span>
        </span>
        <div className="seg" data-testid="diff-expand-controls">
          <button type="button" onClick={() => expandAll(diff.id, allPaths)}>
            Expand all
          </button>
          <button type="button" onClick={() => collapseAll(diff.id)}>
            Collapse all
          </button>
        </div>
      </header>

      <div className="diff-body">
        <div className="diff-filelist">
          {diff.files.map((file, index) => {
            const binary = detectBinary(file);
            return (
              <button
                key={file.path}
                type="button"
                className={index === active ? "diff-file is-on" : "diff-file"}
                onClick={() => onSelect(index)}
                data-testid="diff-file-row"
              >
                <span className={`diff-file-status ${statusTone(file)}`}>{statusLetter(file)}</span>
                <span className="diff-file-path">{file.path}</span>
                {binary ? <span className="diff-file-binary">Binary</span> : null}
                <span className="diff-file-delta">
                  <span className="delta-add">+{file.add}</span>
                  <span className="delta-del">−{file.del}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="diff-view">
          {large ? <div className="diff-large-warn">Large diff — expand files individually.</div> : null}
          {diff.files.map((file, index) => {
            const open = expanded.includes(file.path);
            const binary = detectBinary(file);
            return (
              <div
                key={file.path}
                className={open ? "diff-file-block" : "diff-file-block diff-collapsed"}
                data-active={index === active ? "true" : undefined}
              >
                <button
                  type="button"
                  className="diff-file-head"
                  onClick={() => toggleExpanded(diff.id, file.path)}
                  data-testid="diff-file-head"
                >
                  <span className="diff-file-toggle">
                    <span className={open ? "diff-chevron is-open" : "diff-chevron"}>▸</span>
                  </span>
                  <span className={`diff-file-status ${statusTone(file)}`}>{statusLetter(file)}</span>
                  <span className="diff-file-path">{file.path}</span>
                  {fileStatus(file) === "renamed" && file.oldPath ? (
                    <span className="diff-mode-change">(from {file.oldPath})</span>
                  ) : null}
                  {binary ? <span className="diff-file-binary">Binary</span> : null}
                  <span className="diff-file-delta">
                    <span className="delta-add">+{file.add}</span>
                    <span className="delta-del">−{file.del}</span>
                  </span>
                </button>
                {open ? (
                  <>
                    {file.modeChanges && file.modeChanges.length > 0
                      ? file.modeChanges.map((mode) => (
                          <div className="diff-mode-change" key={mode}>
                            {mode}
                          </div>
                        ))
                      : null}
                    <FileBody diffId={diff.id} file={file} />
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
