/** @jsxImportSource react */
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

export function SpecsTab(props: SpecsTabProps) {
  const { docs, drafts, selectedPath, assetBase, changedPaths, launchedRunId, launchError } = props;
  const productDocs = docs.filter((doc) => !docIsTechnical(doc));
  const technicalDocs = docs.filter(docIsTechnical);
  const selectedDoc = docs.find((doc) => doc.path === selectedPath) ?? productDocs[0] ?? docs[0];
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
        <div className="tree-section">
          <span className="tree-section-title">Product docs</span>
          {productDocs.length > 0 ? (
            <SpecFileTree files={productDocs} selectedPath={selectedPath} onSelect={props.onSelectPath} />
          ) : (
            <p className="tree-empty">No product docs yet.</p>
          )}
        </div>
        <details className="tree-section technical-docs" data-testid="ddd-technical-docs">
          <summary className="tree-section-title tree-section-toggle">
            Technical docs (for agents) <span className="count">{technicalDocs.length}</span>
          </summary>
          <p className="agent-docs-callout" data-testid="ddd-agent-docs-callout">
            Generated, low-level reference docs. We recommend asking your agent to read these instead of reading
            them yourself, e.g. "Read .smithers/spec/content/features/cli.md and close the gap it describes."
            Stay on the product docs; your agent works down here.
          </p>
          <SpecFileTree files={technicalDocs} selectedPath={selectedPath} onSelect={props.onSelectPath} />
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
