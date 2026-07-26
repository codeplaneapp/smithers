import { useEffect } from "react";
import "./vcs.css";
import type { VcsChange, VcsRepoState, VcsSnapshot } from "./vcsDomain";
import { useVcsStore } from "./vcsStore";

function repoLabel(snapshot: VcsSnapshot): string {
  if (snapshot.primary === "jj") return snapshot.detected.git ? "Jujutsu primary, Git present" : "Jujutsu";
  if (snapshot.primary === "git") return "Git";
  return "No repository";
}

function changeTone(change: VcsChange): string {
  switch (change.category) {
    case "added":
    case "copied":
      return "added";
    case "modified":
    case "renamed":
      return "modified";
    case "deleted":
      return "deleted";
    case "conflicted":
      return "conflicted";
    default:
      return "neutral";
  }
}

function ChangeRow({ change }: { change: VcsChange }) {
  return (
    <div className="vcs-change-row" data-testid="vcs-change-row">
      <span className={`vcs-change-status ${changeTone(change)}`}>{change.status}</span>
      <span className="vcs-change-path">{change.oldPath ? `${change.oldPath} -> ${change.path}` : change.path}</span>
    </div>
  );
}

function RepoPanel({ state, primary }: { state: VcsRepoState; primary: boolean }) {
  const title = state.kind === "jj" ? "Jujutsu" : "Git";
  const cleanLabel = state.clean ? "Clean" : `${state.changes.length} changed`;

  return (
    <section className={primary ? "vcs-panel is-primary" : "vcs-panel"} data-testid={`vcs-${state.kind}`}>
      <header className="vcs-panel-head">
        <div>
          <h2>{title}</h2>
          <p>{state.repoRoot ?? "Unavailable"}</p>
        </div>
        <span className={state.clean ? "vcs-pill clean" : "vcs-pill dirty"}>{cleanLabel}</span>
      </header>

      {state.error ? (
        <div className="surface-empty vcs-empty">{state.error}</div>
      ) : (
        <>
          <div className="vcs-meta-grid">
            <div>
              <span className="vcs-meta-label">{state.kind === "jj" ? "Working copy" : "Branch"}</span>
              <strong>{state.current ?? "Unknown"}</strong>
            </div>
            <div>
              <span className="vcs-meta-label">{state.kind === "jj" ? "Bookmarks" : "Branches"}</span>
              <strong>{state.bookmarks.length}</strong>
            </div>
          </div>

          {state.bookmarks.length > 0 ? (
            <div className="vcs-bookmarks" data-testid={`vcs-${state.kind}-bookmarks`}>
              {state.bookmarks.slice(0, 12).map((bookmark) => (
                <span key={bookmark} className="vcs-bookmark">
                  {bookmark}
                </span>
              ))}
            </div>
          ) : null}

          {state.changes.length > 0 ? (
            <div className="vcs-change-list" data-testid={`vcs-${state.kind}-changes`}>
              {state.changes.map((change) => (
                <ChangeRow key={`${change.status}:${change.oldPath ?? ""}:${change.path}`} change={change} />
              ))}
            </div>
          ) : (
            <div className="surface-empty vcs-empty">Working tree is clean.</div>
          )}
        </>
      )}
    </section>
  );
}

function SnapshotView({ snapshot }: { snapshot: VcsSnapshot }) {
  const repos = [snapshot.jj, snapshot.git].filter((repo): repo is VcsRepoState => repo !== null);

  if (repos.length === 0) {
    return (
      <div className="surface-empty vcs-empty" data-testid="vcs-no-repo">
        No local git or jj repository was detected for this workspace.
      </div>
    );
  }

  return (
    <div className="vcs-panels">
      {repos.map((repo) => (
        <RepoPanel key={repo.kind} state={repo} primary={repo.kind === snapshot.primary} />
      ))}
    </div>
  );
}

export function VcsCanvas() {
  const snapshot = useVcsStore((state) => state.snapshot);
  const loading = useVcsStore((state) => state.loading);
  const error = useVcsStore((state) => state.error);
  const load = useVcsStore((state) => state.load);
  const refresh = useVcsStore((state) => state.refresh);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="surface vcs-surface">
      <header className="surface-head vcs-head">
        <div>
          <p className="surface-eyebrow">Local VCS</p>
          <h1>Version Control</h1>
          <p className="surface-subtitle">
            {snapshot ? `${repoLabel(snapshot)} · ${snapshot.workspacePath}` : "Reading local workspace status"}
          </p>
        </div>
        <button type="button" className="btn-brand" onClick={refresh} disabled={loading}>
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </header>

      {error ? <div className="vcs-banner error">{error}</div> : null}
      {snapshot ? (
        <SnapshotView snapshot={snapshot} />
      ) : (
        <div className="surface-empty vcs-empty">Loading VCS status...</div>
      )}
    </div>
  );
}
