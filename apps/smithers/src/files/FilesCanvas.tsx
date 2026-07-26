import { useEffect } from "react";
import "./files.css";
import { selectIsDirty, useFilesStore } from "./filesStore";
import type { FileTreeEntry } from "./filesApi";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function FileIcon({ entry }: { entry: FileTreeEntry }) {
  if (entry.type === "directory") return <span className="files-icon">dir</span>;
  if (entry.type === "symlink" || !entry.safe) return <span className="files-icon">ln</span>;
  if (entry.binary) return <span className="files-icon">bin</span>;
  return <span className="files-icon">txt</span>;
}

function TreeRows({ path, depth }: { path: string; depth: number }) {
  const entries = useFilesStore((state) => state.treeByPath[path] ?? []);
  const expanded = useFilesStore((state) => state.expanded);
  const selectedPath = useFilesStore((state) => state.selectedPath);
  const loadingTreePath = useFilesStore((state) => state.loadingTreePath);
  const toggleDirectory = useFilesStore((state) => state.toggleDirectory);
  const selectFile = useFilesStore((state) => state.selectFile);

  return (
    <>
      {entries.map((entry) => {
        const open = Boolean(expanded[entry.path]);
        const selected = selectedPath === entry.path;
        const disabled = !entry.safe || entry.type === "other" || entry.type === "symlink";
        return (
          <div key={entry.path || entry.name}>
            <button
              type="button"
              className={selected ? "files-row is-selected" : "files-row"}
              style={{ paddingLeft: 10 + depth * 14 }}
              disabled={disabled}
              onClick={() => {
                if (entry.type === "directory") void toggleDirectory(entry.path);
                else if (entry.type === "file") void selectFile(entry.path);
              }}
              data-testid={entry.type === "directory" ? "files-tree-dir" : "files-tree-file"}
            >
              <span className="files-caret">{entry.type === "directory" ? (open ? "v" : ">") : ""}</span>
              <FileIcon entry={entry} />
              <span className="files-name">{entry.name}</span>
              {entry.type === "file" ? <span className="files-size">{formatBytes(entry.size)}</span> : null}
            </button>
            {entry.type === "directory" && open ? (
              loadingTreePath === entry.path ? (
                <div className="files-loading" style={{ paddingLeft: 24 + (depth + 1) * 14 }}>
                  Loading...
                </div>
              ) : (
                <TreeRows path={entry.path} depth={depth + 1} />
              )
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function EmptyEditor() {
  return (
    <div className="files-empty" data-testid="files-empty">
      <div className="files-empty-title">Select a file</div>
      <div className="files-empty-sub">Text files open in the editor. Large or binary files open safely.</div>
    </div>
  );
}

function FileEditor() {
  const file = useFilesStore((state) => state.file);
  const draft = useFilesStore((state) => state.draft);
  const saved = useFilesStore((state) => state.saved);
  const loadingFile = useFilesStore((state) => state.loadingFile);
  const fileError = useFilesStore((state) => state.fileError);
  const saveError = useFilesStore((state) => state.saveError);
  const saving = useFilesStore((state) => state.saving);
  const dirty = useFilesStore(selectIsDirty);
  const editDraft = useFilesStore((state) => state.editDraft);
  const saveSelected = useFilesStore((state) => state.saveSelected);

  if (loadingFile) return <div className="files-empty">Loading file...</div>;
  if (fileError) return <div className="files-empty is-error">{fileError}</div>;
  if (!file) return <EmptyEditor />;

  const canSave = file.editable && dirty && !saving;

  return (
    <div className="files-editor-pane" data-testid="files-editor">
      <header className="files-editor-head">
        <div className="files-editor-title">
          <span className="files-path">{file.path}</span>
          <span className="files-meta">
            {formatBytes(file.size)} | {formatTime(file.mtimeMs)}
          </span>
        </div>
        <button
          type="button"
          className="files-save"
          disabled={!canSave}
          onClick={() => void saveSelected()}
          data-testid="files-save"
        >
          {saving ? "Saving..." : dirty ? "Save" : "Saved"}
        </button>
      </header>

      {saveError ? <div className="files-alert">{saveError}</div> : null}

      {file.kind === "binary" ? (
        <div className="files-safe-preview" data-testid="files-binary-preview">
          <div className="files-safe-title">Binary file</div>
          <div>{file.reason ?? "Binary files are not opened in the editor."}</div>
        </div>
      ) : file.editable ? (
        <textarea
          className="files-editor"
          value={draft}
          spellCheck={false}
          onChange={(event) => editDraft(event.target.value)}
          data-testid="files-editor-textarea"
        />
      ) : (
        <div className="files-readonly" data-testid="files-readonly-preview">
          <div className="files-alert">{file.reason}</div>
          <pre>{saved}</pre>
        </div>
      )}
    </div>
  );
}

export function FilesCanvas() {
  const rootName = useFilesStore((state) => state.rootName);
  const treeLoaded = useFilesStore((state) => state.treeByPath[""] !== undefined);
  const loadingTreePath = useFilesStore((state) => state.loadingTreePath);
  const treeError = useFilesStore((state) => state.treeError);
  const loadTree = useFilesStore((state) => state.loadTree);

  useEffect(() => {
    if (!treeLoaded && loadingTreePath === null) void loadTree("");
  }, [loadTree, loadingTreePath, treeLoaded]);

  return (
    <section className="files-surface" data-testid="files-canvas">
      <header className="files-head">
        <div>
          <div className="files-title">Files</div>
          <div className="files-sub">{rootName}</div>
        </div>
        <button className="files-refresh" type="button" onClick={() => void loadTree("")}>
          Refresh
        </button>
      </header>
      <div className="files-body">
        <aside className="files-tree" aria-label="Workspace files">
          {treeError ? <div className="files-alert">{treeError}</div> : null}
          {!treeLoaded && loadingTreePath === "" ? (
            <div className="files-loading">Loading workspace...</div>
          ) : (
            <TreeRows path="" depth={0} />
          )}
        </aside>
        <FileEditor />
      </div>
    </section>
  );
}
