/** @jsxImportSource react */
import { useJsonApi } from "./monitorShared.tsx";
import {
  footprintNodeKey,
  footprintNote,
  footprintOf,
  formatFootprintSummary,
  rankedDirectories,
  rankedFiles,
  type FootprintDirectory,
  type FootprintFile,
} from "./monitorFootprintModel.ts";

type FootprintPanelProps = {
  runId: string;
  live: boolean;
  onFocusNode: (id: string) => void;
};

function directoryFor(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}

function ChangeBar({ added, removed }: Pick<FootprintDirectory, "added" | "removed">) {
  const total = added + removed;
  // A 0/0 directory (renames, mode flips) keeps the neutral track, not a full
  // removed bar.
  const addedWidth = total === 0 ? 0 : (added / total) * 100;
  const removedWidth = total === 0 ? 0 : 100 - addedWidth;
  return (
    <span className="mon-footprint-bar" aria-label={`+${added} −${removed}`}>
      <span className="mon-footprint-added" style={{ width: `${addedWidth}%` }} />
      <span className="mon-footprint-removed" style={{ width: `${removedWidth}%` }} />
    </span>
  );
}

function FootprintFileRow({ file, onFocusNode }: { file: FootprintFile; onFocusNode: (id: string) => void }) {
  return (
    <div className="mon-footprint-file" data-testid="footprint-file">
      <span>{file.path} +{file.added}/−{file.removed}</span>
      {file.owner ? (
        <button
          type="button"
          className="mon-chip"
          data-testid="footprint-node"
          onClick={() => onFocusNode(footprintNodeKey(file.owner!.nodeId, file.owner!.iteration))}
        >
          {file.owner.nodeId}
        </button>
      ) : null}
    </div>
  );
}

export function FootprintPanel({ runId, live, onFocusNode }: FootprintPanelProps) {
  const api = useJsonApi(`/v1/api/runs/${encodeURIComponent(runId)}/footprint`, live ? 15_000 : null);
  const footprint = footprintOf(api.body);
  const files = rankedFiles(footprint);
  const note = footprintNote(footprint);
  const summary = !api.loaded && !api.failed ? "loading footprint…" : formatFootprintSummary(footprint);

  return (
    <details className="mon-panel mon-footprint-panel" data-testid="footprint-panel">
      <summary data-testid="footprint-summary">{summary}</summary>
      <div data-testid="footprint-content">
        {api.failed && api.loaded ? <div data-testid="footprint-degraded">refresh failed; showing last good data</div> : null}
        {note ? <div className="mon-dim" data-testid="footprint-note">{note}</div> : null}
        {rankedDirectories(footprint).map((directory) => {
          const directoryFiles = files.filter((file) => directoryFor(file.path) === directory.path);
          return (
            <section key={directory.path} data-testid="footprint-directory">
              <div className="mon-footprint-directory">
                <strong>{directory.path}</strong>
                <span>+{directory.added}/−{directory.removed}</span>
                <ChangeBar added={directory.added} removed={directory.removed} />
              </div>
              {directoryFiles.map((file) => <FootprintFileRow key={file.path} file={file} onFocusNode={onFocusNode} />)}
            </section>
          );
        })}
      </div>
    </details>
  );
}
