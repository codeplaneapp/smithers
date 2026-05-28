import { useState, useEffect, useCallback } from "react";
import {
  listJjhubLandings,
  getJjhubLanding,
  createJjhubLanding,
  getJjhubLandingDiff,
  getJjhubLandingChecks,
  getJjhubLandingConflicts,
  reviewJjhubLanding,
  landJjhubLanding,
  loadJjhubAuthStatus,
  type WorkspaceLanding,
  type WorkspaceLandingConflicts,
  type WorkspaceJjhubAuthStatus,
} from "./workspaceApi";

type LandingStateFilter = "all" | "open" | "closed" | "draft" | "merged";
type LandingDetailTab = "info" | "diff" | "checks" | "conflicts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function visibleLandingsForFilter(landings: WorkspaceLanding[], filter: LandingStateFilter): WorkspaceLanding[] {
  switch (filter) {
    case "all":
      return landings;
    case "open":
      return landings.filter(l => l.state === "open" || l.state === "draft");
    case "closed":
      return landings.filter(l => l.state === "closed");
    case "draft":
      return landings.filter(l => l.state === "draft");
    case "merged":
      return landings.filter(l => l.state === "merged");
    default:
      return landings;
  }
}

function landingRequestState(filter: LandingStateFilter): string | null {
  if (filter === "all") return null;
  return filter;
}

export function LandingsPanel() {
  const [landings, setLandings] = useState<WorkspaceLanding[]>([]);
  const [stateFilter, setStateFilter] = useState<LandingStateFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLanding, setSelectedLanding] = useState<WorkspaceLanding | null>(null);
  const [detailTab, setDetailTab] = useState<LandingDetailTab>("info");
  const [diffText, setDiffText] = useState<string | null>(null);
  const [checksText, setChecksText] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<WorkspaceLandingConflicts | null>(null);
  const [message, setMessage] = useState("Loading landings...");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [pendingLandLanding, setPendingLandLanding] = useState<WorkspaceLanding | null>(null);
  const [authStatus, setAuthStatus] = useState<WorkspaceJjhubAuthStatus | null>(null);
  const [authMessage, setAuthMessage] = useState("Checking JJHub auth...");

  const effectiveSelectedLanding = selectedLanding ??
    (selectedId ? landings.find((landing) => landing.id === selectedId) ?? null : landings[0] ?? null);

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

  const refreshLandings = useCallback(async () => {
    setLoading(true);
    setMessage("Loading JJHub landings...");
    try {
      const loaded = visibleLandingsForFilter(
        await listJjhubLandings(landingRequestState(stateFilter)),
        stateFilter
      );
      setLandings(loaded);
      setSelectedId((current) => current && loaded.some((landing) => landing.id === current)
        ? current
        : loaded[0]?.id ?? null);
      setSelectedLanding((current) => current && loaded.some((landing) => landing.id === current.id)
        ? current
        : loaded[0] ?? null);
      setMessage(`Loaded ${loaded.length} landing${loaded.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setLandings([]);
      setSelectedLanding(null);
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [stateFilter]);

  useEffect(() => {
    void refreshAuthStatus();
    void refreshLandings();
  }, [refreshAuthStatus, refreshLandings]);

  const selectLanding = async (landing: WorkspaceLanding) => {
    setSelectedId(landing.id);
    setSelectedLanding(landing);
    setDiffText(null);
    setChecksText(null);
    setConflicts(null);

    if (landing.number == null) {
      return;
    }
    try {
      const detail = await getJjhubLanding(landing.number);
      setSelectedLanding(detail);
      setLandings((current) => current.map((entry) => entry.id === detail.id ? detail : entry));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const loadLandingDiff = async (landing: WorkspaceLanding) => {
    if (landing.number == null) return;
    try {
      const diff = await getJjhubLandingDiff(landing.number);
      setDiffText(diff);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const loadLandingChecks = async (landing: WorkspaceLanding) => {
    if (landing.number == null) return;
    try {
      const checks = await getJjhubLandingChecks(landing.number);
      setChecksText(checks);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const loadLandingConflicts = async (landing: WorkspaceLanding) => {
    if (landing.number == null) return;
    try {
      const landingConflicts = await getJjhubLandingConflicts(landing.number);
      setConflicts(landingConflicts);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  useEffect(() => {
    if (!effectiveSelectedLanding) return;

    switch (detailTab) {
      case "diff":
        if (!diffText) loadLandingDiff(effectiveSelectedLanding);
        break;
      case "checks":
        if (!checksText) loadLandingChecks(effectiveSelectedLanding);
        break;
      case "conflicts":
        if (!conflicts) loadLandingConflicts(effectiveSelectedLanding);
        break;
    }
  }, [detailTab, effectiveSelectedLanding, diffText, checksText, conflicts]);

  const upsertLanding = (landing: WorkspaceLanding) => {
    setLandings((current) => [landing, ...current.filter((entry) => entry.id !== landing.id)]);
    setSelectedId(landing.id);
    setSelectedLanding(landing);
  };

  const createLanding = async () => {
    const title = newTitle.trim();
    if (!title) {
      setMessage("Landing title is required.");
      return;
    }
    setBusy(true);
    setMessage(`Creating landing ${title}...`);
    try {
      const created = await createJjhubLanding(
        title,
        newBody.trim() || null,
        newTarget.trim() || null
      );
      upsertLanding(created);
      setNewTitle("");
      setNewBody("");
      setNewTarget("");
      setShowCreate(false);
      setMessage(`Created landing #${created.number || created.id}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const reviewLanding = async (action: "approve" | "request_changes" | "comment") => {
    if (!effectiveSelectedLanding?.number) {
      setMessage("Cannot review landing without number.");
      return;
    }
    setBusy(true);
    setMessage(`Submitting ${action} review...`);
    try {
      const reviewed = await reviewJjhubLanding(
        effectiveSelectedLanding.number,
        action,
        reviewBody.trim() || null
      );
      upsertLanding(reviewed);
      setReviewBody("");
      setMessage(`Review submitted: ${action}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const landLanding = async (landing: WorkspaceLanding) => {
    if (landing.number == null) {
      setMessage("Cannot land landing without number.");
      return;
    }
    setBusy(true);
    setMessage(`Landing #${landing.number}...`);
    try {
      const landed = await landJjhubLanding(landing.number);
      upsertLanding(landed);
      setPendingLandLanding(null);
      setMessage(`Landed #${landed.number || landed.id}.`);
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
          <h2>Landings</h2>
        </div>
        <div className="view-content">
          <div className="auth-required">
            <h3>JJHub Authentication Required</h3>
            <p>{authMessage}</p>
            <p>Please authenticate with JJHub to access landings.</p>
            <button onClick={refreshAuthStatus} type="button">Retry</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <h2>Landings</h2>
        <div className="view-controls">
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as LandingStateFilter)}>
            <option value="all">All Landings</option>
            <option value="open">Open</option>
            <option value="draft">Draft</option>
            <option value="closed">Closed</option>
            <option value="merged">Merged</option>
          </select>
          <button onClick={() => setShowCreate(true)} type="button">New Landing</button>
          <button onClick={refreshLandings} disabled={loading} type="button">
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="view-content">
        <div className="split-view">
          <div className="split-sidebar">
            <div className="status-message">{message}</div>
            <div className="landings-list">
              {landings.map((landing) => (
                <div
                  key={landing.id}
                  className={`landing-row ${landing.id === selectedId ? "selected" : ""}`}
                  onClick={() => selectLanding(landing)}
                >
                  <div className="landing-title">
                    {landing.number ? `#${landing.number}` : landing.id} {landing.title}
                  </div>
                  <div className="landing-meta">
                    <span className={`landing-state landing-state-${landing.state || "unknown"}`}>
                      {landing.state || "unknown"}
                    </span>
                    {landing.author && <span className="landing-author">by {landing.author}</span>}
                    {landing.targetBranch && <span className="landing-target">→ {landing.targetBranch}</span>}
                    {landing.reviewStatus && (
                      <span className={`landing-review landing-review-${landing.reviewStatus.toLowerCase()}`}>
                        {landing.reviewStatus}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="split-main">
            {effectiveSelectedLanding ? (
              <div className="landing-detail">
                <div className="landing-detail-header">
                  <h3>
                    {effectiveSelectedLanding.number ? `#${effectiveSelectedLanding.number}` : effectiveSelectedLanding.id}{" "}
                    {effectiveSelectedLanding.title}
                  </h3>
                  <div className="landing-actions">
                    {effectiveSelectedLanding.state === "open" && (
                      <button onClick={() => setPendingLandLanding(effectiveSelectedLanding)} type="button">
                        Land
                      </button>
                    )}
                  </div>
                </div>

                <div className="landing-detail-tabs">
                  <button
                    className={detailTab === "info" ? "active" : ""}
                    onClick={() => setDetailTab("info")}
                    type="button"
                  >
                    Info
                  </button>
                  <button
                    className={detailTab === "diff" ? "active" : ""}
                    onClick={() => setDetailTab("diff")}
                    type="button"
                  >
                    Diff
                  </button>
                  <button
                    className={detailTab === "checks" ? "active" : ""}
                    onClick={() => setDetailTab("checks")}
                    type="button"
                  >
                    Checks
                  </button>
                  <button
                    className={detailTab === "conflicts" ? "active" : ""}
                    onClick={() => setDetailTab("conflicts")}
                    type="button"
                  >
                    Conflicts
                  </button>
                </div>

                <div className="landing-detail-content">
                  {detailTab === "info" && (
                    <div className="landing-info">
                      <div className="landing-description">
                        <pre>{effectiveSelectedLanding.description || "No description provided."}</pre>
                      </div>
                      <div className="landing-metadata">
                        {effectiveSelectedLanding.author && (
                          <div><strong>Author:</strong> {effectiveSelectedLanding.author}</div>
                        )}
                        {effectiveSelectedLanding.targetBranch && (
                          <div><strong>Target:</strong> {effectiveSelectedLanding.targetBranch}</div>
                        )}
                        {effectiveSelectedLanding.reviewStatus && (
                          <div><strong>Review Status:</strong> {effectiveSelectedLanding.reviewStatus}</div>
                        )}
                        {effectiveSelectedLanding.createdAt && (
                          <div><strong>Created:</strong> {effectiveSelectedLanding.createdAt}</div>
                        )}
                      </div>

                      <div className="landing-review-section">
                        <h4>Submit Review</h4>
                        <textarea
                          value={reviewBody}
                          onChange={(e) => setReviewBody(e.target.value)}
                          placeholder="Review comment (optional)"
                          rows={3}
                        />
                        <div className="review-actions">
                          <button onClick={() => reviewLanding("approve")} disabled={busy} type="button">
                            Approve
                          </button>
                          <button onClick={() => reviewLanding("request_changes")} disabled={busy} type="button">
                            Request Changes
                          </button>
                          <button onClick={() => reviewLanding("comment")} disabled={busy} type="button">
                            Comment
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {detailTab === "diff" && (
                    <div className="landing-diff">
                      {diffText ? (
                        <pre className="diff-content">{diffText}</pre>
                      ) : (
                        <div className="loading-state">Loading diff...</div>
                      )}
                    </div>
                  )}

                  {detailTab === "checks" && (
                    <div className="landing-checks">
                      {checksText ? (
                        <pre className="checks-content">{checksText}</pre>
                      ) : (
                        <div className="loading-state">Loading checks...</div>
                      )}
                    </div>
                  )}

                  {detailTab === "conflicts" && (
                    <div className="landing-conflicts">
                      {conflicts ? (
                        <div>
                          <div className={`conflict-status ${conflicts.hasConflicts ? "has-conflicts" : "no-conflicts"}`}>
                            {conflicts.hasConflicts ? "⚠️ Has conflicts" : "✅ No conflicts"}
                          </div>
                          {conflicts.conflicts.map((conflict, index) => (
                            <div key={index} className="conflict-item">
                              <div className="conflict-file">{conflict.filePath}</div>
                              <div className="conflict-type">{conflict.conflictType || "unknown"}</div>
                              <div className={`conflict-resolved ${conflict.resolved ? "resolved" : "unresolved"}`}>
                                {conflict.resolved ? "Resolved" : "Unresolved"}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="loading-state">Loading conflicts...</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <p>Select a landing to view details</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Create New Landing</h3>
            <div className="form-group">
              <label>Title</label>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Landing title"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>Description</label>
              <textarea
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                placeholder="Landing description (optional)"
                rows={4}
              />
            </div>
            <div className="form-group">
              <label>Target Branch</label>
              <input
                type="text"
                value={newTarget}
                onChange={(e) => setNewTarget(e.target.value)}
                placeholder="Target branch (optional)"
              />
            </div>
            <div className="modal-actions">
              <button onClick={createLanding} disabled={busy || !newTitle.trim()} type="button">
                {busy ? "Creating..." : "Create Landing"}
              </button>
              <button onClick={() => setShowCreate(false)} type="button">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {pendingLandLanding && (
        <div className="modal-overlay" onClick={() => setPendingLandLanding(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Land #{pendingLandLanding.number || pendingLandLanding.id}</h3>
            <p>Are you sure you want to land this landing?</p>
            <div className="modal-actions">
              <button onClick={() => landLanding(pendingLandLanding)} disabled={busy} type="button">
                {busy ? "Landing..." : "Land"}
              </button>
              <button onClick={() => setPendingLandLanding(null)} type="button">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
