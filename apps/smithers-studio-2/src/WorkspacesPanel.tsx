import { useState, useEffect, useCallback } from "react";
import {
  listCloudWorkspaces,
  createCloudWorkspace,
  deleteCloudWorkspace,
  suspendCloudWorkspace,
  resumeCloudWorkspace,
  forkCloudWorkspace,
  listCloudWorkspaceSnapshots,
  createCloudWorkspaceSnapshot,
  deleteCloudWorkspaceSnapshot,
  listLocalWorkspaces,
  openLocalWorkspace,
  removeLocalWorkspace,
  loadJjhubAuthStatus,
  type WorkspaceCloudWorkspace,
  type WorkspaceCloudSnapshot,
  type WorkspaceLocalRecent,
  type WorkspaceJjhubAuthStatus,
} from "./workspaceApi";

type WorkspacesMode = "workspaces" | "snapshots" | "local";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorkspacesPanel() {
  const [mode, setMode] = useState<WorkspacesMode>("workspaces");
  const [workspaces, setWorkspaces] = useState<WorkspaceCloudWorkspace[]>([]);
  const [snapshots, setSnapshots] = useState<WorkspaceCloudSnapshot[]>([]);
  const [localWorkspaces, setLocalWorkspaces] = useState<WorkspaceLocalRecent[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newSnapshotName, setNewSnapshotName] = useState("");
  const [forkWorkspaceName, setForkWorkspaceName] = useState("");
  const [restoreName, setRestoreName] = useState("");
  const [restoreSourceSnapshotId, setRestoreSourceSnapshotId] = useState<string | null>(null);
  const [message, setMessage] = useState("Loading workspaces...");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showCreateSnapshot, setShowCreateSnapshot] = useState(false);
  const [showForkWorkspace, setShowForkWorkspace] = useState<WorkspaceCloudWorkspace | null>(null);
  const [showRestoreWorkspace, setShowRestoreWorkspace] = useState(false);
  const [pendingWorkspaceDelete, setPendingWorkspaceDelete] = useState<WorkspaceCloudWorkspace | null>(null);
  const [pendingSnapshotDelete, setPendingSnapshotDelete] = useState<WorkspaceCloudSnapshot | null>(null);
  const [authStatus, setAuthStatus] = useState<WorkspaceJjhubAuthStatus | null>(null);
  const [authMessage, setAuthMessage] = useState("Checking JJHub auth...");
  const [localWorkspacesMessage, setLocalWorkspacesMessage] = useState("Loading local workspaces...");

  const selectedWorkspace = selectedWorkspaceId
    ? workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null
    : workspaces[0] ?? null;

  const selectedSnapshot = selectedSnapshotId
    ? snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null
    : snapshots[0] ?? null;

  const refreshAuthStatus = useCallback(async () => {
    try {
      const loaded = await loadJjhubAuthStatus();
      setAuthStatus(loaded);
      setAuthMessage(loaded.loggedIn ? "Authenticated with JJHub." : "JJHub is signed out.");
    } catch (error) {
      setAuthStatus(null);
      setAuthMessage(`JJHub auth unavailable: ${errorMessage(error)}`);
    }
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    setLoading(true);
    setMessage(mode === "snapshots" ? "Loading workspace snapshots..." : "Loading cloud workspaces...");
    try {
      if (mode === "snapshots") {
        const [loadedWorkspaces, loaded] = await Promise.all([
          listCloudWorkspaces(),
          listCloudWorkspaceSnapshots(),
        ]);
        setWorkspaces(loadedWorkspaces);
        setSelectedWorkspaceId((current) => current && loadedWorkspaces.some((w) => w.id === current)
          ? current
          : loadedWorkspaces[0]?.id ?? null);
        setSnapshots(loaded);
        setSelectedSnapshotId((current) => current && loaded.some((s) => s.id === current)
          ? current
          : loaded[0]?.id ?? null);
        setMessage(`Loaded ${loaded.length} workspace snapshot${loaded.length === 1 ? "" : "s"}.`);
      } else {
        const loaded = await listCloudWorkspaces();
        setWorkspaces(loaded);
        setSelectedWorkspaceId((current) => current && loaded.some((w) => w.id === current)
          ? current
          : loaded[0]?.id ?? null);
        setMessage(`Loaded ${loaded.length} cloud workspace${loaded.length === 1 ? "" : "s"}.`);
      }
    } catch (error) {
      if (mode === "snapshots") {
        setSnapshots([]);
        setSelectedSnapshotId(null);
      } else {
        setWorkspaces([]);
        setSelectedWorkspaceId(null);
      }
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [mode]);

  const refreshLocalWorkspaces = useCallback(async () => {
    setLocalWorkspacesMessage("Loading local workspaces...");
    try {
      const loaded = await listLocalWorkspaces();
      setLocalWorkspaces(loaded);
      setLocalWorkspacesMessage(`Loaded ${loaded.length} local workspace${loaded.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setLocalWorkspaces([]);
      setLocalWorkspacesMessage(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void refreshAuthStatus();
    if (mode === "local") {
      void refreshLocalWorkspaces();
    } else {
      void refreshWorkspaces();
    }
  }, [mode, refreshAuthStatus, refreshWorkspaces, refreshLocalWorkspaces]);

  const createWorkspace = async () => {
    const name = newWorkspaceName.trim();
    if (!name) {
      setMessage("Workspace name is required.");
      return;
    }
    setBusyId("create");
    setMessage(`Creating workspace ${name}...`);
    try {
      const created = await createCloudWorkspace(name, restoreSourceSnapshotId);
      setWorkspaces((current) => [created, ...current]);
      setSelectedWorkspaceId(created.id);
      setNewWorkspaceName("");
      setRestoreSourceSnapshotId(null);
      setShowCreateWorkspace(false);
      setShowRestoreWorkspace(false);
      setMessage(`Created workspace ${name}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  const openRestoreWorkspace = async () => {
    setShowRestoreWorkspace(true);
    if (snapshots.length > 0) {
      return;
    }
    try {
      const loaded = await listCloudWorkspaceSnapshots();
      setSnapshots(loaded);
      setRestoreSourceSnapshotId((current) => current ?? loaded[0]?.id ?? null);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const createSnapshot = async () => {
    const name = newSnapshotName.trim();
    if (!name || !selectedWorkspace) {
      setMessage("Snapshot name and workspace selection required.");
      return;
    }
    setBusyId("snapshot");
    setMessage(`Creating snapshot ${name}...`);
    try {
      const created = await createCloudWorkspaceSnapshot(selectedWorkspace.id, name);
      setSnapshots((current) => [created, ...current]);
      setNewSnapshotName("");
      setShowCreateSnapshot(false);
      setMessage(`Created snapshot ${name}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  const forkWorkspace = async (workspace: WorkspaceCloudWorkspace) => {
    const name = forkWorkspaceName.trim();
    if (!name) {
      setMessage("Fork name is required.");
      return;
    }
    setBusyId(workspace.id);
    setMessage(`Forking workspace to ${name}...`);
    try {
      const forked = await forkCloudWorkspace(workspace.id, name);
      setWorkspaces((current) => [forked, ...current]);
      setSelectedWorkspaceId(forked.id);
      setForkWorkspaceName("");
      setShowForkWorkspace(null);
      setMessage(`Forked workspace to ${name}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  const suspendWorkspace = async (workspace: WorkspaceCloudWorkspace) => {
    setBusyId(workspace.id);
    setMessage(`Suspending workspace ${workspace.name}...`);
    try {
      await suspendCloudWorkspace(workspace.id);
      setWorkspaces((current) => current.map((w) => w.id === workspace.id
        ? { ...w, status: "suspended" }
        : w));
      setMessage(`Suspended workspace ${workspace.name}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  const resumeWorkspace = async (workspace: WorkspaceCloudWorkspace) => {
    setBusyId(workspace.id);
    setMessage(`Resuming workspace ${workspace.name}...`);
    try {
      await resumeCloudWorkspace(workspace.id);
      setWorkspaces((current) => current.map((w) => w.id === workspace.id
        ? { ...w, status: "running" }
        : w));
      setMessage(`Resumed workspace ${workspace.name}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  const deleteWorkspace = async (workspace: WorkspaceCloudWorkspace) => {
    setBusyId(workspace.id);
    setMessage(`Deleting workspace ${workspace.name}...`);
    try {
      await deleteCloudWorkspace(workspace.id);
      setWorkspaces((current) => current.filter((w) => w.id !== workspace.id));
      if (selectedWorkspaceId === workspace.id) {
        const remaining = workspaces.filter((w) => w.id !== workspace.id);
        setSelectedWorkspaceId(remaining[0]?.id ?? null);
      }
      setPendingWorkspaceDelete(null);
      setMessage(`Deleted workspace ${workspace.name}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  const deleteSnapshot = async (snapshot: WorkspaceCloudSnapshot) => {
    setBusyId(snapshot.id);
    setMessage(`Deleting snapshot ${snapshot.name}...`);
    try {
      await deleteCloudWorkspaceSnapshot(snapshot.id);
      setSnapshots((current) => current.filter((s) => s.id !== snapshot.id));
      if (selectedSnapshotId === snapshot.id) {
        const remaining = snapshots.filter((s) => s.id !== snapshot.id);
        setSelectedSnapshotId(remaining[0]?.id ?? null);
      }
      setPendingSnapshotDelete(null);
      setMessage(`Deleted snapshot ${snapshot.name}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  const openLocalWorkspacePath = async (path: string) => {
    setBusyId(path);
    setMessage(`Opening workspace at ${path}...`);
    try {
      await openLocalWorkspace(path);
      setMessage(`Opened workspace at ${path}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  const removeLocalWorkspacePath = async (path: string) => {
    try {
      const updated = await removeLocalWorkspace(path);
      setLocalWorkspaces(updated);
      setLocalWorkspacesMessage(`Removed ${path} from recent workspaces.`);
    } catch (error) {
      setLocalWorkspacesMessage(errorMessage(error));
    }
  };

  if (mode !== "local" && !authStatus?.loggedIn) {
    return (
      <div className="view-container">
        <div className="view-header">
          <h2>Workspaces</h2>
          <div className="view-controls">
            <select value={mode} onChange={(e) => setMode(e.target.value as WorkspacesMode)}>
              <option value="workspaces">Cloud Workspaces</option>
              <option value="snapshots">Snapshots</option>
              <option value="local">Local Workspaces</option>
            </select>
          </div>
        </div>
        <div className="view-content">
          <div className="auth-required">
            <h3>JJHub Authentication Required</h3>
            <p>{authMessage}</p>
            <p>Please authenticate with JJHub to access cloud workspaces.</p>
            <button onClick={refreshAuthStatus} type="button">Retry</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <h2>Workspaces</h2>
        <div className="view-controls">
          <select value={mode} onChange={(e) => setMode(e.target.value as WorkspacesMode)}>
            <option value="workspaces">Cloud Workspaces</option>
            <option value="snapshots">Snapshots</option>
            <option value="local">Local Workspaces</option>
          </select>
          {mode === "workspaces" && (
            <>
              <button onClick={() => setShowCreateWorkspace(true)} type="button">New Workspace</button>
              <button onClick={openRestoreWorkspace} type="button">Restore from Snapshot</button>
            </>
          )}
          {mode === "snapshots" && (
            <button onClick={() => setShowCreateSnapshot(true)} disabled={workspaces.length === 0} type="button">
              New Snapshot
            </button>
          )}
          {mode === "local" && (
            <button onClick={refreshLocalWorkspaces} type="button">Refresh</button>
          )}
          {mode !== "local" && (
            <button onClick={refreshWorkspaces} disabled={loading} type="button">
              {loading ? "Loading..." : "Refresh"}
            </button>
          )}
        </div>
      </div>

      <div className="view-content">
        <div className="status-message">{mode === "local" ? localWorkspacesMessage : message}</div>

        {mode === "local" ? (
          <div className="local-workspaces-list">
            {localWorkspaces.map((workspace) => (
              <div key={workspace.path} className="workspace-item">
                <div className="workspace-info">
                  <div className="workspace-name">{workspace.displayName}</div>
                  <div className="workspace-path">{workspace.path}</div>
                  <div className="workspace-meta">
                    {workspace.exists ? "✅ Exists" : "❌ Missing"}
                    {workspace.hasSmithers ? " • Has Smithers" : " • No Smithers"}
                    • Last opened: {workspace.lastOpenedAt}
                  </div>
                </div>
                <div className="workspace-actions">
                  <button
                    onClick={() => openLocalWorkspacePath(workspace.path)}
                    disabled={busyId === workspace.path || !workspace.exists}
                    type="button"
                  >
                    {busyId === workspace.path ? "Opening..." : "Open"}
                  </button>
                  <button
                    onClick={() => removeLocalWorkspacePath(workspace.path)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="cloud-workspaces">
            {mode === "workspaces" ? (
              <div className="workspaces-list">
                {workspaces.map((workspace) => (
                  <div
                    key={workspace.id}
                    className={`workspace-item ${workspace.id === selectedWorkspaceId ? "selected" : ""}`}
                    onClick={() => setSelectedWorkspaceId(workspace.id)}
                  >
                    <div className="workspace-info">
                      <div className="workspace-name">{workspace.name}</div>
                      <div className="workspace-meta">
                        <span className={`workspace-status workspace-status-${workspace.status?.toLowerCase() || "unknown"}`}>
                          {workspace.status || "unknown"}
                        </span>
                        {workspace.createdAt && <span className="workspace-created">Created: {workspace.createdAt}</span>}
                      </div>
                    </div>
                    <div className="workspace-actions">
                      {workspace.status === "running" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); suspendWorkspace(workspace); }}
                          disabled={busyId === workspace.id}
                          type="button"
                        >
                          {busyId === workspace.id ? "Suspending..." : "Suspend"}
                        </button>
                      )}
                      {workspace.status === "suspended" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); resumeWorkspace(workspace); }}
                          disabled={busyId === workspace.id}
                          type="button"
                        >
                          {busyId === workspace.id ? "Resuming..." : "Resume"}
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); setForkWorkspaceName(workspace.name + "-fork"); setShowForkWorkspace(workspace); }}
                        type="button"
                      >
                        Fork
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setPendingWorkspaceDelete(workspace); }}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="snapshots-list">
                {snapshots.map((snapshot) => (
                  <div
                    key={snapshot.id}
                    className={`snapshot-item ${snapshot.id === selectedSnapshotId ? "selected" : ""}`}
                    onClick={() => setSelectedSnapshotId(snapshot.id)}
                  >
                    <div className="snapshot-info">
                      <div className="snapshot-name">{snapshot.name || "Unnamed"}</div>
                      <div className="snapshot-meta">
                        Workspace: {snapshot.workspaceId}
                        {snapshot.createdAt && <span> • Created: {snapshot.createdAt}</span>}
                      </div>
                    </div>
                    <div className="snapshot-actions">
                      <button
                        onClick={(e) => { e.stopPropagation(); setRestoreName(`${snapshot.name}-restore`); setRestoreSourceSnapshotId(snapshot.id); setShowRestoreWorkspace(true); }}
                        type="button"
                      >
                        Restore
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setPendingSnapshotDelete(snapshot); }}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {showCreateWorkspace && (
        <div className="modal-overlay" onClick={() => setShowCreateWorkspace(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Create New Workspace</h3>
            <div className="form-group">
              <label>Workspace Name</label>
              <input
                type="text"
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                placeholder="Workspace name"
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button onClick={createWorkspace} disabled={busyId === "create" || !newWorkspaceName.trim()} type="button">
                {busyId === "create" ? "Creating..." : "Create Workspace"}
              </button>
              <button onClick={() => setShowCreateWorkspace(false)} type="button">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showCreateSnapshot && (
        <div className="modal-overlay" onClick={() => setShowCreateSnapshot(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Create Snapshot</h3>
            <div className="form-group">
              <label>Snapshot Name</label>
              <input
                type="text"
                value={newSnapshotName}
                onChange={(e) => setNewSnapshotName(e.target.value)}
                placeholder="Snapshot name"
                autoFocus
              />
            </div>
            {selectedWorkspace && (
              <div className="form-group">
                <label>Source Workspace</label>
                <div>{selectedWorkspace.name}</div>
              </div>
            )}
            <div className="modal-actions">
              <button onClick={createSnapshot} disabled={busyId === "snapshot" || !newSnapshotName.trim()} type="button">
                {busyId === "snapshot" ? "Creating..." : "Create Snapshot"}
              </button>
              <button onClick={() => setShowCreateSnapshot(false)} type="button">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showRestoreWorkspace && (
        <div className="modal-overlay" onClick={() => setShowRestoreWorkspace(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Restore Workspace from Snapshot</h3>
            <div className="form-group">
              <label>New Workspace Name</label>
              <input
                type="text"
                value={restoreName}
                onChange={(e) => setRestoreName(e.target.value)}
                placeholder="Restored workspace name"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>Source Snapshot</label>
              <select
                value={restoreSourceSnapshotId || ""}
                onChange={(e) => setRestoreSourceSnapshotId(e.target.value || null)}
              >
                <option value="">Select a snapshot</option>
                {snapshots.map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    {snapshot.name || "Unnamed"} ({snapshot.workspaceId})
                  </option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button
                onClick={() => {
                  setNewWorkspaceName(restoreName);
                  setShowCreateWorkspace(true);
                  setShowRestoreWorkspace(false);
                }}
                disabled={!restoreName.trim() || !restoreSourceSnapshotId}
                type="button"
              >
                Restore
              </button>
              <button onClick={() => setShowRestoreWorkspace(false)} type="button">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showForkWorkspace && (
        <div className="modal-overlay" onClick={() => setShowForkWorkspace(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Fork Workspace {showForkWorkspace.name}</h3>
            <div className="form-group">
              <label>Fork Name</label>
              <input
                type="text"
                value={forkWorkspaceName}
                onChange={(e) => setForkWorkspaceName(e.target.value)}
                placeholder="Fork name"
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button
                onClick={() => forkWorkspace(showForkWorkspace)}
                disabled={busyId === showForkWorkspace.id || !forkWorkspaceName.trim()}
                type="button"
              >
                {busyId === showForkWorkspace.id ? "Forking..." : "Fork"}
              </button>
              <button onClick={() => setShowForkWorkspace(null)} type="button">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {pendingWorkspaceDelete && (
        <div className="modal-overlay" onClick={() => setPendingWorkspaceDelete(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Workspace {pendingWorkspaceDelete.name}</h3>
            <p>Are you sure you want to delete this workspace? This action cannot be undone.</p>
            <div className="modal-actions">
              <button
                onClick={() => deleteWorkspace(pendingWorkspaceDelete)}
                disabled={busyId === pendingWorkspaceDelete.id}
                type="button"
              >
                {busyId === pendingWorkspaceDelete.id ? "Deleting..." : "Delete"}
              </button>
              <button onClick={() => setPendingWorkspaceDelete(null)} type="button">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {pendingSnapshotDelete && (
        <div className="modal-overlay" onClick={() => setPendingSnapshotDelete(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Snapshot {pendingSnapshotDelete.name}</h3>
            <p>Are you sure you want to delete this snapshot? This action cannot be undone.</p>
            <div className="modal-actions">
              <button
                onClick={() => deleteSnapshot(pendingSnapshotDelete)}
                disabled={busyId === pendingSnapshotDelete.id}
                type="button"
              >
                {busyId === pendingSnapshotDelete.id ? "Deleting..." : "Delete"}
              </button>
              <button onClick={() => setPendingSnapshotDelete(null)} type="button">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
