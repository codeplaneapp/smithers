/** @jsxImportSource react */
import { MarkdownEditor, SpecFileTree, resolveDocLink, type DocsContentEntry } from "./ddd-shared";

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

export function SpecsTab(props: SpecsTabProps) {
  const { docs, drafts, selectedPath, assetBase, changedPaths, launchedRunId, launchError } = props;
  const selectedDoc = docs.find((doc) => doc.path === selectedPath) ?? docs[0];
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
        <SpecFileTree files={docs} selectedPath={selectedPath} onSelect={props.onSelectPath} />
      </div>
      <div className="specs-main">
        <div className="editor-bar">
          <span className="path">{selectedDoc?.path ?? "No spec selected"}</span>
          <div className="dispatch-actions">
            <button
              className="button"
              type="button"
              data-testid="ddd-dispatch-file"
              disabled={!currentDirty}
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
          <MarkdownEditor
            key={selectedDoc.path}
            docPath={selectedDoc.path}
            initialValue={draftValue}
            assetBase={assetBase}
            onChange={(markdown) => props.onDraftChange(selectedDoc.path, markdown)}
            onLinkClick={openLink}
          />
        ) : (
          <p className="empty">No narrative docs found under .smithers/spec/content.</p>
        )}

        {launchedRunId || launchError ? (
          <div className="meta-status" data-testid="ddd-meta-ticket-status">
            <span className={`badge ${launchError ? "bad" : "ok"}`}>{launchError ? "failed" : "queued"}</span>
            <span>{launchError ?? `Run ${launchedRunId} dispatched from the docs editor.`}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
