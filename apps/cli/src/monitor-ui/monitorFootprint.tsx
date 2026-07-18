/** @jsxImportSource react */
import { Chip } from "./monitorShell.tsx";
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

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="mon-footprint-counts">
      <span className="mon-footprint-plus">+{added}</span> <span className="mon-footprint-minus">−{removed}</span>
    </span>
  );
}

function FootprintFileRow({ file, onFocusNode }: { file: FootprintFile; onFocusNode: (id: string) => void }) {
  return (
    <div className="mon-footprint-file" data-testid="footprint-file">
      <span className="mon-footprint-name" title={file.path}>{file.path}</span>
      <Counts added={file.added} removed={file.removed} />
      <span className="mon-footprint-owner">
        {file.owner ? (
          <Chip
            data-testid="footprint-node"
            title={`Inspect ${file.owner.nodeId}`}
            onClick={() => onFocusNode(footprintNodeKey(file.owner!.nodeId, file.owner!.iteration))}
          >
            {file.owner.nodeId}
          </Chip>
        ) : null}
      </span>
    </div>
  );
}

export function FootprintPanel({ runId, live, onFocusNode }: FootprintPanelProps) {
  const api = useJsonApi(`/v1/api/runs/${encodeURIComponent(runId)}/footprint`, live ? 15_000 : null);
  const footprint = footprintOf(api.body);
  const files = rankedFiles(footprint);
  const note = footprintNote(footprint);

  // Nothing to drill into yet (still loading, unavailable, or genuinely no
  // changes): collapse to one quiet row instead of a bare lowercase line.
  if (!footprint || footprint.totalFiles === 0) {
    const status = !api.loaded && !api.failed
      ? "loading…"
      : !footprint ? "footprint unavailable" : "no changes yet";
    return (
      <section className="mon-panel mon-panel-quiet" data-testid="footprint-panel">
        <h2 className="mon-kicker">Footprint</h2>
        <span className="mon-dim" data-testid="footprint-summary">{status}</span>
      </section>
    );
  }

  return (
    <details className="mon-panel mon-footprint-panel" data-testid="footprint-panel">
      <summary data-testid="footprint-summary" title={formatFootprintSummary(footprint)}>
        <span className="mon-diff-caret" aria-hidden>▸</span>
        <span className="mon-kicker">Footprint</span>
        <span className="mon-footprint-rollup">
          {footprint.totalFiles} {footprint.totalFiles === 1 ? "file" : "files"} ·{" "}
          <span className="mon-footprint-plus">+{footprint.added}</span>{" "}
          <span className="mon-footprint-minus">−{footprint.removed}</span>
        </span>
      </summary>
      <div data-testid="footprint-content">
        {api.failed && api.loaded ? <div className="mon-dim" data-testid="footprint-degraded">refresh failed; showing last good data</div> : null}
        {note ? <div className="mon-dim" data-testid="footprint-note">{note}</div> : null}
        {rankedDirectories(footprint).map((directory) => {
          const directoryFiles = files.filter((file) => directoryFor(file.path) === directory.path);
          return (
            <section key={directory.path} data-testid="footprint-directory">
              <div className="mon-footprint-directory">
                <strong className="mon-footprint-name" title={directory.path}>{directory.path}</strong>
                <Counts added={directory.added} removed={directory.removed} />
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
