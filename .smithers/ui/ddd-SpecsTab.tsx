/** @jsxImportSource react */
import { useState } from "react";
import { MarkdownEditor, SpecFileTree, formatStatus, resolveDocLink, type DocsContentEntry } from "./ddd-shared";

export type SpecsTabProps = {
  docs: DocsContentEntry[];
  drafts: Record<string, string>;
  selectedPath: string;
  assetBase: string | undefined;
  changedPaths: string[];
  launchedRunId: string | null;
  launchError: string | null;
  onSelectPath: (path: string) => void;
  onDraftChange: (path: string, markdown: string) => void;
  onDispatch: (paths: string[]) => void;
};

export function docIsTechnical(doc: Pick<DocsContentEntry, "level"> | undefined): boolean {
  return doc?.level === "technical";
}

function docSearchBlob(doc: DocsContentEntry): string {
  return [doc.path, doc.title, doc.level, doc.content].filter(Boolean).join(" ").toLowerCase();
}

export function SpecsTab(props: SpecsTabProps) {
  const { docs, drafts, selectedPath, assetBase, changedPaths, launchedRunId, launchError } = props;
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const productDocsAll = docs.filter((doc) => !docIsTechnical(doc));
  const technicalDocsAll = docs.filter(docIsTechnical);
  const productDocs = productDocsAll.filter((doc) => !needle || docSearchBlob(doc).includes(needle));
  const technicalDocs = technicalDocsAll.filter((doc) => !needle || docSearchBlob(doc).includes(needle));
  const selectedDoc = docs.find((doc) => doc.path === selectedPath) ?? productDocsAll[0] ?? docs[0];
  const selectedTechnical = docIsTechnical(selectedDoc);
  const draftValue = selectedDoc ? drafts[selectedDoc.path] ?? selectedDoc.content : "";
  const currentDirty = !!selectedDoc && changedPaths.includes(selectedDoc.path);

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
              disabled={!currentDirty || selectedTechnical}
              onClick={() => selectedDoc && props.onDispatch([selectedDoc.path])}
            >
              Dispatch agents for this file
            </button>
            <button
              className="button primary"
              type="button"
              data-testid="ddd-create-meta-ticket"
              disabled={changedPaths.length === 0}
              onClick={() => props.onDispatch(changedPaths)}
            >
              Dispatch all changes{changedPaths.length ? ` (${changedPaths.length})` : ""}
            </button>
          </div>
        </div>

        {selectedDoc ? (
          selectedTechnical ? (
            // Derived docs are regenerated wholesale every build; hand-edits
            // would be silently clobbered, so render them read-only.
            <pre className="source technical-doc-view" data-testid="ddd-technical-doc-view">
              {selectedDoc.content}
            </pre>
          ) : (
            <MarkdownEditor
              key={selectedDoc.path}
              docPath={selectedDoc.path}
              initialValue={draftValue}
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
            <span>{launchError ?? `Run ${launchedRunId} dispatched from the docs editor.`}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
