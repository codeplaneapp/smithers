/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MarkdownEditor,
  MarkdownPreview,
  SpecFileTree,
  formatStatus,
  resolveDocLink,
  type DocsContentEntry,
  type DraftRunNotice,
} from "./ddd-shared";

export type SpecsTabProps = {
  docs: DocsContentEntry[];
  drafts: Record<string, string>;
  selectedPath: string;
  assetBase: string | undefined;
  changedPaths: string[];
  launchPending?: boolean;
  launchedRunId: string | null;
  launchError: string | null;
  recoveredPaths?: string[];
  editorResetKey?: number;
  draftRunNotice?: DraftRunNotice | null;
  onSelectPath: (path: string) => void;
  onDraftChange: (path: string, markdown: string) => void;
  onDiscardDrafts?: (paths: string[]) => void;
  onDispatch: (paths: string[]) => void;
  onReload?: () => void;
};

export function docIsTechnical(doc: Pick<DocsContentEntry, "level"> | undefined): boolean {
  return doc?.level === "technical";
}

function docSearchBlob(doc: DocsContentEntry): string {
  return [doc.path, doc.title, doc.level, doc.content].filter(Boolean).join(" ").toLowerCase();
}

export function SpecsTab(props: SpecsTabProps) {
  const {
    docs,
    drafts,
    selectedPath,
    assetBase,
    changedPaths,
    launchPending = false,
    launchedRunId,
    launchError,
    recoveredPaths = [],
    editorResetKey = 0,
    draftRunNotice,
  } = props;
  const [query, setQuery] = useState("");
  const [technicalView, setTechnicalView] = useState<"preview" | "source">("preview");
  // "Discard all" wipes every local draft, so require a second confirming click
  // (auto-disarms after 4s) instead of firing destructively on one misclick.
  const [discardAllArmed, setDiscardAllArmed] = useState(false);
  const discardArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (discardArmTimer.current) clearTimeout(discardArmTimer.current);
    },
    [],
  );
  const needle = query.trim().toLowerCase();
  const productDocsAll = docs.filter((doc) => !docIsTechnical(doc));
  const technicalDocsAll = docs.filter(docIsTechnical);
  const productDocs = productDocsAll.filter((doc) => !needle || docSearchBlob(doc).includes(needle));
  const technicalDocs = technicalDocsAll.filter((doc) => !needle || docSearchBlob(doc).includes(needle));
  const visibleDocs = useMemo(() => [...productDocs, ...technicalDocs], [productDocs, technicalDocs]);
  const selectedDoc = needle
    ? (visibleDocs.find((doc) => doc.path === selectedPath) ?? visibleDocs[0])
    : (docs.find((doc) => doc.path === selectedPath) ?? productDocsAll[0] ?? docs[0]);
  const renderedSelectedPath = selectedDoc?.path ?? selectedPath;
  const selectedTechnical = docIsTechnical(selectedDoc);
  const draftValue = selectedDoc ? (drafts[selectedDoc.path] ?? selectedDoc.content) : "";
  const currentDirty = !!selectedDoc && changedPaths.includes(selectedDoc.path);
  const dispatchableChangedPaths = changedPaths.filter((path) => {
    const doc = docs.find((item) => item.path === path);
    return !!doc && !docIsTechnical(doc);
  });
  const dispatchLabel = launchPending ? "Dispatching..." : "Dispatch agents for this file";
  const dispatchAllLabel = launchPending
    ? "Dispatching changes..."
    : `Dispatch all changes${dispatchableChangedPaths.length ? ` (${dispatchableChangedPaths.length})` : ""}`;

  useEffect(() => {
    if (!needle || visibleDocs.length === 0) return;
    if (visibleDocs.some((doc) => doc.path === selectedPath)) return;
    props.onSelectPath(visibleDocs[0]!.path);
  }, [needle, selectedPath, visibleDocs, props.onSelectPath]);

  // An in-spec markdown link (e.g. "features/x.md", "../overview.md") opens
  // that doc in the tree rather than navigating the browser to a dead URL.
  function openLink(href: string) {
    if (!selectedDoc) return;
    const target = resolveDocLink(selectedDoc.path, href, (path) => docs.some((doc) => doc.path === path));
    if (target?.kind === "doc") props.onSelectPath(target.path);
  }

  return (
    <div className="specs pane" data-testid="ddd-specs-tab">
      <div className="specs-tree">
        <label className="doc-tree-search">
          <span>Search docs</span>
          <input
            className="search-input"
            type="search"
            value={query}
            data-testid="ddd-doc-search"
            placeholder="Path, title, content"
            onInput={(event) => setQuery(event.currentTarget.value)}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <div className="tree-section">
          <span className="tree-section-title">
            Product docs{" "}
            <span className="count">
              {productDocs.length}
              {needle ? ` of ${productDocsAll.length}` : ""}
            </span>
          </span>
          {productDocs.length > 0 ? (
            <SpecFileTree
              files={productDocs}
              selectedPath={renderedSelectedPath}
              changedPaths={changedPaths}
              onSelect={props.onSelectPath}
            />
          ) : (
            <p className="tree-empty">{needle ? "No product docs match." : "No product docs yet."}</p>
          )}
        </div>
        <details
          className="tree-section technical-docs"
          data-testid="ddd-technical-docs"
          open={needle.length > 0 || selectedTechnical}
        >
          <summary className="tree-section-title tree-section-toggle">
            Technical docs (for agents){" "}
            <span className="count">
              {technicalDocs.length}
              {needle ? ` of ${technicalDocsAll.length}` : ""}
            </span>
          </summary>
          <p className="agent-docs-callout" data-testid="ddd-agent-docs-callout">
            Generated, low-level reference docs. We recommend asking your agent to read these instead of reading them
            yourself, e.g. "Read .smithers/spec/content/features/cli.md and close the gap it describes." Stay on the
            product docs; your agent works down here.
          </p>
          {technicalDocs.length > 0 ? (
            <SpecFileTree
              files={technicalDocs}
              selectedPath={renderedSelectedPath}
              changedPaths={changedPaths}
              onSelect={props.onSelectPath}
            />
          ) : (
            <p className="tree-empty">{needle ? "No technical docs match." : "No technical docs yet."}</p>
          )}
        </details>
      </div>
      <div className="specs-main">
        <div className="editor-bar">
          <div className="editor-title">
            <span className="path">{selectedDoc?.path ?? "No spec selected"}</span>
            {selectedDoc ? (
              selectedTechnical ? (
                <span className="badge muted" data-testid="ddd-doc-generated-badge">
                  Generated · read-only
                </span>
              ) : (
                <span className={`badge ${currentDirty ? "warn" : "muted"}`}>{currentDirty ? "Unsaved" : "Clean"}</span>
              )
            ) : null}
          </div>
          <div className="dispatch-actions">
            <button
              className="button"
              type="button"
              data-testid="ddd-dispatch-file"
              disabled={launchPending || !currentDirty || selectedTechnical}
              onClick={() => selectedDoc && props.onDispatch([selectedDoc.path])}
            >
              {dispatchLabel}
            </button>
            <button
              className="button primary"
              type="button"
              data-testid="ddd-create-meta-ticket"
              disabled={launchPending || dispatchableChangedPaths.length === 0}
              onClick={() => props.onDispatch(dispatchableChangedPaths)}
            >
              {dispatchAllLabel}
            </button>
            <button
              className="button"
              type="button"
              data-testid="ddd-discard-file"
              disabled={!currentDirty || selectedTechnical}
              onClick={() => selectedDoc && props.onDiscardDrafts?.([selectedDoc.path])}
            >
              Revert file
            </button>
            <button
              className={`button danger${discardAllArmed ? " is-armed" : ""}`}
              type="button"
              data-testid="ddd-discard-all"
              disabled={dispatchableChangedPaths.length === 0}
              aria-label={discardAllArmed ? "Confirm discarding all local drafts" : "Discard all local drafts"}
              onClick={() => {
                if (discardArmTimer.current) clearTimeout(discardArmTimer.current);
                if (!discardAllArmed) {
                  setDiscardAllArmed(true);
                  discardArmTimer.current = setTimeout(() => setDiscardAllArmed(false), 4000);
                  return;
                }
                setDiscardAllArmed(false);
                props.onDiscardDrafts?.(dispatchableChangedPaths);
              }}
            >
              {discardAllArmed ? `Confirm discard ${dispatchableChangedPaths.length}?` : "Discard all"}
            </button>
          </div>
        </div>

        {selectedDoc ? (
          selectedTechnical ? (
            // Derived docs are regenerated wholesale every build; hand-edits
            // would be silently clobbered, so render them read-only.
            <div className="technical-doc-shell" data-testid="ddd-technical-doc-view">
              <div className="preview-toolbar" role="group" aria-label="Technical doc view">
                <button
                  type="button"
                  className={technicalView === "preview" ? "segmented is-active" : "segmented"}
                  data-testid="ddd-technical-preview-toggle"
                  onClick={() => setTechnicalView("preview")}
                >
                  Preview
                </button>
                <button
                  type="button"
                  className={technicalView === "source" ? "segmented is-active" : "segmented"}
                  data-testid="ddd-technical-source-toggle"
                  onClick={() => setTechnicalView("source")}
                >
                  Source
                </button>
              </div>
              {technicalView === "preview" ? (
                <MarkdownPreview markdown={selectedDoc.content} onLinkClick={openLink} />
              ) : (
                <pre className="source technical-doc-source" data-testid="ddd-technical-doc-source">
                  {selectedDoc.content}
                </pre>
              )}
            </div>
          ) : (
            <MarkdownEditor
              key={selectedDoc.path}
              docPath={selectedDoc.path}
              initialValue={draftValue}
              resetKey={editorResetKey}
              assetBase={assetBase}
              onChange={(markdown) => props.onDraftChange(selectedDoc.path, markdown)}
              onLinkClick={openLink}
            />
          )
        ) : (
          <p className="empty">
            {needle
              ? "No docs match the current search. Clear the filter to return to the selected document."
              : "No narrative docs found under .smithers/spec/content."}
          </p>
        )}

        {launchedRunId || launchError ? (
          <div className="meta-status" data-testid="ddd-meta-ticket-status">
            <span className={`badge ${launchError ? "bad" : "ok"}`}>
              {formatStatus(launchError ? "failed" : "queued")}
            </span>
            <span>
              {launchError ??
                `Run ${launchedRunId} dispatched from the docs editor. Drafts stay local until the agent applies them.`}
            </span>
          </div>
        ) : null}
        {launchPending ? (
          <div className="meta-status" data-testid="ddd-meta-ticket-launching">
            <span className="badge warn">Launching</span>
            <span>Dispatching a docs-driven-development run. Buttons are disabled until the gateway responds.</span>
          </div>
        ) : null}
        {recoveredPaths.length ? (
          <div className="meta-status" data-testid="ddd-draft-recovered">
            <span className="badge warn">Recovered</span>
            <span>
              {recoveredPaths.length} local draft{recoveredPaths.length === 1 ? "" : "s"} restored from this browser.
            </span>
            <button type="button" className="button" onClick={() => props.onDiscardDrafts?.(recoveredPaths)}>
              Discard recovered
            </button>
          </div>
        ) : null}
        {draftRunNotice ? (
          <div className="meta-status draft-run-state" data-testid="ddd-draft-run-state">
            <span
              className={`badge ${draftRunNotice.state === "failed" ? "bad" : draftRunNotice.state === "not-applied" || draftRunNotice.state === "retained" ? "warn" : "ok"}`}
            >
              {draftRunNotice.state === "failed"
                ? "Run failed"
                : draftRunNotice.state === "applied"
                  ? "Applied"
                  : draftRunNotice.state === "retained"
                    ? "Applied with local edits"
                    : "Not applied"}
            </span>
            <span>
              <strong>Run {draftRunNotice.runId}</strong> {draftRunNotice.summary}
            </span>
            <button type="button" className="button" data-testid="ddd-draft-run-reload" onClick={props.onReload}>
              Reload docs
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
