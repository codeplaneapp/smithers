/** @jsxImportSource react */
import { useState } from "react";
import { MarkdownEditor, MarkdownPreview, SpecFileTree, formatStatus, resolveDocLink, type DocsContentEntry } from "./ddd-shared";

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
  onSelectPath: (path: string) => void;
  onDraftChange: (path: string, markdown: string) => void;
  onDiscardDrafts?: (paths: string[]) => void;
  onDispatch: (paths: string[]) => void;
};

export function docIsTechnical(doc: Pick<DocsContentEntry, "level"> | undefined): boolean {
  return doc?.level === "technical";
}

function docSearchBlob(doc: DocsContentEntry): string {
  return [doc.path, doc.title, doc.level, doc.content].filter(Boolean).join(" ").toLowerCase();
}

export function SpecsTab(props: SpecsTabProps) {
  const { docs, drafts, selectedPath, assetBase, changedPaths, launchPending = false, launchedRunId, launchError, recoveredPaths = [], editorResetKey = 0 } = props;
  const [query, setQuery] = useState("");
  const [technicalView, setTechnicalView] = useState<"preview" | "source">("preview");
  const needle = query.trim().toLowerCase();
  const productDocsAll = docs.filter((doc) => !docIsTechnical(doc));
  const technicalDocsAll = docs.filter(docIsTechnical);
  const productDocs = productDocsAll.filter((doc) => !needle || docSearchBlob(doc).includes(needle));
  const technicalDocs = technicalDocsAll.filter((doc) => !needle || docSearchBlob(doc).includes(needle));
  const selectedDoc = docs.find((doc) => doc.path === selectedPath) ?? productDocsAll[0] ?? docs[0];
  const selectedTechnical = docIsTechnical(selectedDoc);
  const draftValue = selectedDoc ? drafts[selectedDoc.path] ?? selectedDoc.content : "";
  const currentDirty = !!selectedDoc && changedPaths.includes(selectedDoc.path);
  const dispatchableChangedPaths = changedPaths.filter((path) => {
    const doc = docs.find((item) => item.path === path);
    return !!doc && !docIsTechnical(doc);
  });
  const dispatchLabel = launchPending ? "Dispatching..." : "Dispatch agents for this file";
  const dispatchAllLabel = launchPending
    ? "Dispatching changes..."
    : `Dispatch all changes${dispatchableChangedPaths.length ? ` (${dispatchableChangedPaths.length})` : ""}`;

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
            Product docs <span className="count">{productDocs.length}{needle ? ` of ${productDocsAll.length}` : ""}</span>
          </span>
          {productDocs.length > 0 ? (
            <SpecFileTree files={productDocs} selectedPath={selectedPath} changedPaths={changedPaths} onSelect={props.onSelectPath} />
          ) : (
            <p className="tree-empty">{needle ? "No product docs match." : "No product docs yet."}</p>
          )}
        </div>
        <details className="tree-section technical-docs" data-testid="ddd-technical-docs" open={needle.length > 0 || selectedTechnical}>
          <summary className="tree-section-title tree-section-toggle">
            Technical docs (for agents) <span className="count">{technicalDocs.length}{needle ? ` of ${technicalDocsAll.length}` : ""}</span>
          </summary>
          <p className="agent-docs-callout" data-testid="ddd-agent-docs-callout">
            Generated, low-level reference docs. We recommend asking your agent to read these instead of reading
            them yourself, e.g. "Read .smithers/spec/content/features/cli.md and close the gap it describes."
            Stay on the product docs; your agent works down here.
          </p>
          {technicalDocs.length > 0 ? (
            <SpecFileTree files={technicalDocs} selectedPath={selectedPath} changedPaths={changedPaths} onSelect={props.onSelectPath} />
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
                <span className="badge muted" data-testid="ddd-doc-generated-badge">Generated · read-only</span>
              ) : (
                <span className={`badge ${currentDirty ? "warn" : "muted"}`}>
                  {currentDirty ? "Unsaved" : "Clean"}
                </span>
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
              className="button"
              type="button"
              data-testid="ddd-discard-all"
              disabled={dispatchableChangedPaths.length === 0}
              onClick={() => props.onDiscardDrafts?.(dispatchableChangedPaths)}
            >
              Discard all
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
          <p className="empty">No narrative docs found under .smithers/spec/content.</p>
        )}

        {launchedRunId || launchError ? (
          <div className="meta-status" data-testid="ddd-meta-ticket-status">
            <span className={`badge ${launchError ? "bad" : "ok"}`}>{formatStatus(launchError ? "failed" : "queued")}</span>
            <span>{launchError ?? `Run ${launchedRunId} dispatched from the docs editor. Drafts stay local until the agent applies them.`}</span>
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
            <span>{recoveredPaths.length} local draft{recoveredPaths.length === 1 ? "" : "s"} restored from this browser.</span>
            <button type="button" className="button" onClick={() => props.onDiscardDrafts?.(recoveredPaths)}>
              Discard recovered
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
