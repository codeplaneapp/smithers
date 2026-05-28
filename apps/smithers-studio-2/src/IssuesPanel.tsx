import { useState, useEffect, useCallback } from "react";
import {
  listJjhubIssues,
  getJjhubIssue,
  createJjhubIssue,
  closeJjhubIssue,
  reopenJjhubIssue,
  loadJjhubAuthStatus,
  type WorkspaceIssue,
  type WorkspaceJjhubAuthStatus,
} from "./workspaceApi";

type IssuesStateFilter = "all" | "open" | "closed";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function IssuesPanel() {
  const [issues, setIssues] = useState<WorkspaceIssue[]>([]);
  const [stateFilter, setStateFilter] = useState<IssuesStateFilter>("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<WorkspaceIssue | null>(null);
  const [message, setMessage] = useState("Loading issues...");
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [closeComment, setCloseComment] = useState("");
  const [pendingCloseIssue, setPendingCloseIssue] = useState<WorkspaceIssue | null>(null);
  const [busy, setBusy] = useState(false);
  const [authStatus, setAuthStatus] = useState<WorkspaceJjhubAuthStatus | null>(null);
  const [authMessage, setAuthMessage] = useState("Checking JJHub auth...");

  const effectiveSelectedIssue = selectedIssue ??
    (selectedId ? issues.find((issue) => issue.id === selectedId) ?? null : null);

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

  const refreshIssues = useCallback(async () => {
    setLoading(true);
    setMessage("Loading JJHub issues...");
    try {
      const loaded = await listJjhubIssues(stateFilter === "all" ? null : stateFilter);
      setIssues(loaded);
      setSelectedId((current) => current && loaded.some((issue) => issue.id === current) ? current : null);
      setSelectedIssue((current) => current && loaded.some((issue) => issue.id === current.id) ? current : null);
      setMessage(`Loaded ${loaded.length} issue${loaded.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setIssues([]);
      setSelectedIssue(null);
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [stateFilter]);

  useEffect(() => {
    void refreshAuthStatus();
    void refreshIssues();
  }, [refreshAuthStatus, refreshIssues]);

  const selectIssue = async (issue: WorkspaceIssue) => {
    setSelectedId(issue.id);
    setSelectedIssue(issue);
    if (issue.number == null) {
      return;
    }
    try {
      const detail = await getJjhubIssue(issue.number);
      setSelectedIssue(detail);
      setIssues((current) => current.map((entry) => entry.id === detail.id ? detail : entry));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const upsertIssue = (issue: WorkspaceIssue) => {
    setIssues((current) => [issue, ...current.filter((entry) => entry.id !== issue.id)]);
    setSelectedId(issue.id);
    setSelectedIssue(issue);
  };

  const createIssue = async () => {
    const title = newTitle.trim();
    if (!title) {
      setMessage("Issue title is required.");
      return;
    }
    setBusy(true);
    setMessage(`Creating issue ${title}...`);
    try {
      const created = await createJjhubIssue(title, newBody.trim() || null);
      upsertIssue(created);
      setNewTitle("");
      setNewBody("");
      setShowCreate(false);
      setMessage(`Created issue #${created.number || created.id}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const closeIssue = async (issue: WorkspaceIssue) => {
    if (issue.number == null) {
      setMessage("Cannot close issue without number.");
      return;
    }
    setBusy(true);
    setMessage(`Closing issue #${issue.number}...`);
    try {
      const closed = await closeJjhubIssue(issue.number, closeComment.trim() || null);
      upsertIssue(closed);
      setCloseComment("");
      setPendingCloseIssue(null);
      setMessage(`Closed issue #${closed.number || closed.id}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const reopenIssue = async (issue: WorkspaceIssue) => {
    if (issue.number == null) {
      setMessage("Cannot reopen issue without number.");
      return;
    }
    setBusy(true);
    setMessage(`Reopening issue #${issue.number}...`);
    try {
      const reopened = await reopenJjhubIssue(issue.number);
      upsertIssue(reopened);
      setMessage(`Reopened issue #${reopened.number || reopened.id}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (!authStatus?.loggedIn) {
    return (
      <div className="view-container">
        <div className="view-header">
          <h2>Issues</h2>
        </div>
        <div className="view-content">
          <div className="auth-required">
            <h3>JJHub Authentication Required</h3>
            <p>{authMessage}</p>
            <p>Please authenticate with JJHub to access issues.</p>
            <button onClick={refreshAuthStatus} type="button">Retry</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <h2>Issues</h2>
        <div className="view-controls">
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as IssuesStateFilter)}>
            <option value="all">All Issues</option>
            <option value="open">Open Issues</option>
            <option value="closed">Closed Issues</option>
          </select>
          <button onClick={() => setShowCreate(true)} type="button">New Issue</button>
          <button onClick={refreshIssues} disabled={loading} type="button">
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="view-content">
        <div className="split-view">
          <div className="split-sidebar">
            <div className="status-message">{message}</div>
            <div className="issues-list">
              {issues.map((issue) => (
                <div
                  key={issue.id}
                  className={`issue-row ${issue.id === selectedId ? "selected" : ""}`}
                  onClick={() => selectIssue(issue)}
                >
                  <div className="issue-title">
                    {issue.number ? `#${issue.number}` : issue.id} {issue.title}
                  </div>
                  <div className="issue-meta">
                    <span className={`issue-state issue-state-${issue.state || "unknown"}`}>
                      {issue.state || "unknown"}
                    </span>
                    {issue.labels && issue.labels.length > 0 && (
                      <span className="issue-labels">
                        {issue.labels.map((label) => (
                          <span key={label} className="issue-label">{label}</span>
                        ))}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="split-main">
            {effectiveSelectedIssue ? (
              <div className="issue-detail">
                <div className="issue-detail-header">
                  <h3>
                    {effectiveSelectedIssue.number ? `#${effectiveSelectedIssue.number}` : effectiveSelectedIssue.id}{" "}
                    {effectiveSelectedIssue.title}
                  </h3>
                  <div className="issue-actions">
                    {effectiveSelectedIssue.state === "open" ? (
                      <button onClick={() => setPendingCloseIssue(effectiveSelectedIssue)} type="button">
                        Close Issue
                      </button>
                    ) : (
                      <button onClick={() => reopenIssue(effectiveSelectedIssue)} disabled={busy} type="button">
                        Reopen Issue
                      </button>
                    )}
                  </div>
                </div>
                <div className="issue-body">
                  <pre>{effectiveSelectedIssue.body || "No description provided."}</pre>
                </div>
                {effectiveSelectedIssue.assignees && effectiveSelectedIssue.assignees.length > 0 && (
                  <div className="issue-assignees">
                    <strong>Assignees:</strong> {effectiveSelectedIssue.assignees.join(", ")}
                  </div>
                )}
                {effectiveSelectedIssue.commentCount != null && effectiveSelectedIssue.commentCount > 0 && (
                  <div className="issue-comments">
                    <strong>{effectiveSelectedIssue.commentCount} comment{effectiveSelectedIssue.commentCount === 1 ? "" : "s"}</strong>
                  </div>
                )}
              </div>
            ) : (
              <div className="empty-state">
                <p>Select an issue to view details</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Create New Issue</h3>
            <div className="form-group">
              <label>Title</label>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Issue title"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>Description</label>
              <textarea
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                placeholder="Issue description (optional)"
                rows={4}
              />
            </div>
            <div className="modal-actions">
              <button onClick={createIssue} disabled={busy || !newTitle.trim()} type="button">
                {busy ? "Creating..." : "Create Issue"}
              </button>
              <button onClick={() => setShowCreate(false)} type="button">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {pendingCloseIssue && (
        <div className="modal-overlay" onClick={() => setPendingCloseIssue(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Close Issue #{pendingCloseIssue.number || pendingCloseIssue.id}</h3>
            <div className="form-group">
              <label>Comment (optional)</label>
              <textarea
                value={closeComment}
                onChange={(e) => setCloseComment(e.target.value)}
                placeholder="Add a comment explaining why this issue is being closed"
                rows={3}
              />
            </div>
            <div className="modal-actions">
              <button onClick={() => closeIssue(pendingCloseIssue)} disabled={busy} type="button">
                {busy ? "Closing..." : "Close Issue"}
              </button>
              <button onClick={() => setPendingCloseIssue(null)} type="button">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
