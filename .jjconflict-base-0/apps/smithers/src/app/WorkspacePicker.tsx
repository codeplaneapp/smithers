import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { setWorkspaceRootSearchParam } from "./navigation";
import { useWorkspaceStore, type WorkspaceReadinessStatus } from "./workspaceStore";
import { SmithersMark } from "./SmithersMark";

function statusLabel(status: WorkspaceReadinessStatus): string {
  switch (status) {
    case "idle":
      return "No workspace selected";
    case "checking":
      return "Checking local workspace";
    case "ready":
      return "Local workspace ready";
    case "invalid-path":
      return "Invalid local path";
    case "missing-setup":
      return "Missing local setup";
    case "gateway-unavailable":
      return "Local Gateway unavailable";
    case "gateway-mismatch":
      return "Gateway root mismatch";
    case "error":
      return "Workspace check failed";
  }
}

export function WorkspacePicker() {
  const selectedWorkspaceRoot = useWorkspaceStore((state) => state.selectedWorkspaceRoot);
  const recentWorkspaces = useWorkspaceStore((state) => state.recentWorkspaces);
  const serverWorkspaceRoot = useWorkspaceStore((state) => state.serverWorkspaceRoot);
  const readiness = useWorkspaceStore((state) => state.readiness);
  const status = useWorkspaceStore((state) => state.status);
  const error = useWorkspaceStore((state) => state.error);
  const initialized = useWorkspaceStore((state) => state.initialized);
  const initialize = useWorkspaceStore((state) => state.initialize);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const [path, setPath] = useState("");

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (!path && selectedWorkspaceRoot) setPath(selectedWorkspaceRoot);
  }, [path, selectedWorkspaceRoot]);

  const candidateRoots = useMemo<string[]>(() => {
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const root of serverWorkspaceRoot ? [serverWorkspaceRoot, ...recentWorkspaces] : recentWorkspaces) {
      if (!root || seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
    }
    return roots;
  }, [recentWorkspaces, serverWorkspaceRoot]);

  async function choose(workspaceRoot: string) {
    const next = await selectWorkspace(workspaceRoot);
    if (next.status === "ready") {
      setWorkspaceRootSearchParam(next.workspaceRoot);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void choose(path);
  }

  const busy = status === "checking";
  const message = readiness?.message ?? error;

  return (
    <main className="workspace-picker-page">
      <section className="workspace-picker">
        <header className="workspace-picker-head">
          <SmithersMark part="workspace-mark" aria-hidden="true" />
          <div>
            <h1>Smithers</h1>
            <p>Choose a local workspace root.</p>
          </div>
        </header>

        <form className="workspace-form" onSubmit={submit}>
          <label htmlFor="workspace-root">Workspace root</label>
          <div className="workspace-input-row">
            <input
              id="workspace-root"
              value={path}
              onChange={(event) => setPath(event.currentTarget.value)}
              placeholder="/Users/me/project"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" disabled={busy || !path.trim()}>
              {busy ? "Checking" : "Open"}
            </button>
          </div>
        </form>

        <div className="workspace-status" data-status={status}>
          <span>{initialized ? statusLabel(status) : "Loading local workspace state"}</span>
          {message ? <p>{message}</p> : null}
          {readiness?.gatewayBase ? <code>{readiness.gatewayBase}</code> : null}
        </div>

        {candidateRoots.length > 0 ? (
          <section className="recent-workspaces" aria-label="Recent local workspaces">
            <h2>Recent local workspaces</h2>
            <div className="recent-workspace-list">
              {candidateRoots.map((root) => (
                <button key={root} type="button" onClick={() => void choose(root)} disabled={busy}>
                  <span>{root}</span>
                  {root === serverWorkspaceRoot ? <small>current server root</small> : null}
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}
