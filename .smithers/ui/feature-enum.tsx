/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";
import { sharedDarkThemeCss } from "./shared-theme";

const WORKFLOW_KEY = "feature-enum";

type RunSummary = {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
  input?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function shortHash(hash: string | undefined | null) {
  if (!hash) return "--";
  return hash.length > 10 ? hash.slice(0, 10) : hash;
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

type FeatureGroup = { name: string; features: string[] };
type FeatureInventory = {
  groups: FeatureGroup[];
  totalFeatures: number;
  lastCommitHash: string | null;
  markdownBody: string;
};

function extractInventory(value: unknown): FeatureInventory | null {
  const response = isRecord(value) ? value : {};
  const row = isRecord(response.row) ? response.row : isRecord(response) ? response : {};
  const rawGroups = isRecord(row.featureGroups) ? row.featureGroups : {};
  const groups: FeatureGroup[] = Object.keys(rawGroups).map((name) => {
    const list = rawGroups[name];
    const features = Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
    return { name, features };
  });
  const markdownBody = asString(row.markdownBody) ?? "";
  const hasContent = groups.length > 0 || markdownBody.length > 0 || asNumber(row.totalFeatures) !== undefined;
  if (!hasContent) return null;
  const counted = groups.reduce((sum, g) => sum + g.features.length, 0);
  const totalFeatures = asNumber(row.totalFeatures) ?? counted;
  const lastCommitHash = asString(row.lastCommitHash) ?? null;
  return { groups, totalFeatures, lastCommitHash, markdownBody };
}

function refineInputCount(input: unknown): number | undefined {
  if (!isRecord(input)) return undefined;
  return asNumber(input.refineIterations);
}
function isRefiningExisting(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return input.existingFeatures != null && !Array.isArray(input.existingFeatures);
}

const styles = [
  ...sharedDarkThemeCss,
  ".pill .mono { font-family:ui-monospace,monospace; }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; }",
  ".prompt { width:64px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".search { flex:1; max-width:280px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".field { display:flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; }",
  ".main { display:grid; grid-template-columns:260px 1fr 300px; flex:1; overflow:hidden; }",
  ".rail { border-right:1px solid var(--border); background:var(--panel); overflow:auto; padding:16px; }",
  ".section-head { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); margin:0 0 10px; }",
  ".count-badge { font-size:11px; font-weight:700; padding:3px 9px; border-radius:999px; background:var(--primary); color:#fff; }",
  ".meta { display:flex; flex-direction:column; gap:8px; margin-bottom:20px; }",
  ".meta-row { display:flex; justify-content:space-between; gap:10px; font-size:12px; }",
  ".meta-row .k { color:var(--muted); }",
  ".meta-row .mono { font-family:ui-monospace,monospace; }",
  ".timeline { list-style:none; margin:0; padding:0; }",
  ".timeline li { display:flex; gap:10px; align-items:flex-start; padding:8px 0; position:relative; }",
  ".stage-dot { flex:0 0 12px; width:12px; height:12px; border-radius:50%; margin-top:4px; border:2px solid var(--border); background:var(--bg); }",
  ".stage-dot.done { background:var(--ok); border-color:var(--ok); }",
  ".stage-dot.running { background:var(--warn); border-color:var(--warn); }",
  ".stage-dot.pending { background:var(--bg); border-color:var(--border); }",
  ".stage-name { font-size:12px; }",
  ".stage-sub { font-size:11px; color:var(--muted); }",
  ".inv-head { display:flex; align-items:center; gap:12px; margin-bottom:16px; }",
  ".inv-head h2 { margin:0; font-size:13px; font-weight:600; }",
  ".group { border:1px solid var(--border); border-radius:10px; margin-bottom:12px; overflow:hidden; background:var(--card); }",
  ".group-head { width:100%; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 14px; background:transparent; border:0; color:var(--text); cursor:pointer; text-align:left; }",
  ".group-head:hover { background:var(--panel); }",
  ".group-name { font-family:ui-monospace,monospace; font-size:12px; font-weight:600; letter-spacing:0.02em; }",
  ".group-meta { display:flex; align-items:center; gap:8px; }",
  ".chevron { color:var(--muted); font-size:11px; width:12px; display:inline-block; }",
  ".group-count { font-size:11px; color:var(--muted); }",
  ".feature-list { list-style:none; margin:0; padding:0 0 6px; border-top:1px solid var(--border); }",
  ".feature-list li { padding:8px 14px 8px 28px; border-bottom:1px solid var(--border); font-size:12px; }",
  ".feature-list li:last-child { border-bottom:0; }",
  ".notes { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }",
  ".notes pre { margin:0; white-space:pre-wrap; word-break:break-word; font-family:ui-monospace,monospace; font-size:12px; color:var(--text); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; flex-direction:column; gap:4px; }",
  ".run-row .top { display:flex; justify-content:space-between; gap:8px; align-items:center; }",
  ".run-row .sub { font-size:11px; color:var(--muted); }",
  ".empty { color:var(--muted); text-align:center; padding:40px 16px; }",
  ".empty .button { margin-top:14px; }",
  ".empty .hint { font-size:12px; margin-top:8px; max-width:360px; margin-left:auto; margin-right:auto; }",
  ".progress-track { height:6px; border-radius:999px; background:var(--border); overflow:hidden; margin-top:14px; }",
  ".progress-fill { height:100%; background:var(--primary); transition:width 0.3s ease; }",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

type StageState = "done" | "running" | "pending";

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [refineIterations, setRefineIterations] = useState("3");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const featureRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? featureRuns[0]?.runId;
  const activeRun = featureRuns.find((r) => r.runId === activeRunId);

  const stream = useGatewayRunEvents(activeRunId, { afterSeq: undefined });
  const events = stream.events ?? [];
  const eventNames = useMemo(() => events.map((e) => e.event), [events]);

  const resultOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "feature-enum:result", iteration: 0 });
  const scanOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "feature-enum:scan", iteration: 0 });

  const inventory = useMemo(
    () => extractInventory(resultOutput.data) ?? extractInventory(scanOutput.data),
    [resultOutput.data, scanOutput.data],
  );

  const requestedRefines = refineInputCount(activeRun?.input) ?? 3;
  const refiningExisting = isRefiningExisting(activeRun?.input);

  // Build the Scan -> Refine N -> Result timeline. Stage completion is inferred from
  // run status plus how many task-completion events have streamed in.
  const stages = useMemo(() => {
    const labels: { id: string; name: string; sub: string }[] = [];
    if (!refiningExisting) labels.push({ id: "feature-enum:scan", name: "Scan", sub: "Initial codebase sweep" });
    const refineN = Math.max(1, requestedRefines);
    for (let i = 1; i <= refineN; i += 1) {
      labels.push({ id: "feature-enum:refine:" + i, name: "Refine " + i, sub: "Add, decompose, prune" });
    }
    labels.push({ id: "feature-enum:result", name: "Result", sub: "Final inventory" });

    const completedTasks = eventNames.filter((name) => name === "NodeFinished").length;
    const runStatus = activeRun?.status;
    const runDone = runStatus === "finished";
    const runActive = runStatus === "running" || runStatus === "continued";

    return labels.map((label, index): { id: string; name: string; sub: string; state: StageState } => {
      let state: StageState = "pending";
      if (runDone) {
        state = "done";
      } else if (index < completedTasks) {
        state = "done";
      } else if (index === completedTasks && runActive) {
        state = "running";
      }
      return { ...label, state };
    });
  }, [refiningExisting, requestedRefines, eventNames, activeRun?.status]);

  const doneStages = stages.filter((s) => s.state === "done").length;
  const progressPct = stages.length > 0 ? Math.round((doneStages / stages.length) * 100) : 0;

  const visibleGroups = useMemo(() => {
    if (!inventory) return [];
    const q = query.trim().toLowerCase();
    if (!q) return inventory.groups;
    return inventory.groups
      .map((g) => {
        const groupMatch = g.name.toLowerCase().includes(q);
        const features = groupMatch ? g.features : g.features.filter((f) => f.toLowerCase().includes(q));
        return groupMatch ? g : { name: g.name, features };
      })
      .filter((g) => g.features.length > 0 || g.name.toLowerCase().includes(q));
  }, [inventory, query]);

  async function refresh() {
    await Promise.all([runsQuery.refetch(), resultOutput.refetch(), scanOutput.refetch()]);
  }
  async function launch() {
    setBusy(true);
    try {
      const parsed = Number.parseInt(refineIterations, 10);
      const refines = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
      const run = await actions.launchRun({
        workflow: WORKFLOW_KEY,
        input: { refineIterations: refines },
      });
      setSelectedRunId(run.runId);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!activeRunId) return;
    setBusy(true);
    try {
      await actions.cancelRun({ runId: activeRunId });
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  function toggleGroup(name: string) {
    setCollapsed((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  const running = statusClass(activeRun?.status) === "running";

  return (
    <main className="shell" data-testid="feature-enum-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Feature Enum</h1>
          <span className="pill" data-testid="feature-enum-runid">
            <span className="mono">{activeRunId ? shortRunId(activeRunId) : "No run"}</span>
          </span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="feature-enum-status">
              {activeRun.status ?? "idle"}
            </span>
          ) : null}
        </div>
        <div className="toolbar">
          <input
            className="search"
            data-testid="feature-enum-search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Filter groups or features"
          />
          <span className="field">
            refine
            <input
              className="prompt"
              data-testid="feature-enum-refine-input"
              value={refineIterations}
              onChange={(e) => setRefineIterations(e.currentTarget.value)}
              inputMode="numeric"
            />
          </span>
          <button className="button" data-testid="feature-enum-refresh" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          {running ? (
            <button
              className="button danger"
              data-testid="feature-enum-cancel"
              onClick={() => void cancel()}
              disabled={busy}
            >
              Cancel
            </button>
          ) : null}
          <button
            className="button primary"
            data-testid="feature-enum-launch"
            onClick={() => void launch()}
            disabled={busy}
          >
            Launch Scan
          </button>
        </div>
      </header>

      <div className="main">
        <aside className="rail" data-testid="feature-enum-runsummary">
          <h3 className="section-head">Run Summary</h3>
          <div className="meta">
            <div className="meta-row">
              <span className="k">Status</span>
              <span>{activeRun?.status ?? "no run"}</span>
            </div>
            <div className="meta-row">
              <span className="k">Mode</span>
              <span>{refiningExisting ? "refine existing" : "fresh scan"}</span>
            </div>
            <div className="meta-row">
              <span className="k">Refine iters</span>
              <span>{Math.max(1, requestedRefines)}</span>
            </div>
            <div className="meta-row">
              <span className="k">Commit</span>
              <span className="mono">{shortHash(inventory?.lastCommitHash)}</span>
            </div>
            <div className="meta-row">
              <span className="k">Events</span>
              <span>{events.length}</span>
            </div>
          </div>

          <h3 className="section-head">Progress Timeline</h3>
          <ul className="timeline" data-testid="feature-enum-timeline">
            {stages.map((stage) => (
              <li key={stage.id}>
                <span className={"stage-dot " + stage.state} />
                <span>
                  <div className="stage-name">{stage.name}</div>
                  <div className="stage-sub">
                    {stage.state === "running" ? "running…" : stage.state === "done" ? "done" : stage.sub}
                  </div>
                </span>
              </li>
            ))}
          </ul>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: progressPct + "%" }} />
          </div>
        </aside>

        <div className="content">
          {inventory && inventory.groups.length > 0 ? (
            <>
              <div className="inv-head">
                <h2>Feature Inventory</h2>
                <span className="count-badge" data-testid="feature-enum-total">
                  {inventory.totalFeatures} features
                </span>
                <span className="group-count">
                  {inventory.groups.length} groups · {shortHash(inventory.lastCommitHash)}
                </span>
              </div>
              <div data-testid="feature-enum-inventory">
                {visibleGroups.map((group) => {
                  const isCollapsed = Boolean(collapsed[group.name]);
                  return (
                    <div className="group" key={group.name}>
                      <button className="group-head" onClick={() => toggleGroup(group.name)}>
                        <span>
                          <span className="chevron">{isCollapsed ? "▶" : "▼"}</span>
                          <span className="group-name">{group.name}</span>
                        </span>
                        <span className="group-meta">
                          <span className="group-count">{group.features.length}</span>
                        </span>
                      </button>
                      {!isCollapsed ? (
                        <ul className="feature-list">
                          {group.features.map((feature, i) => (
                            <li key={group.name + ":" + i}>{feature}</li>
                          ))}
                          {group.features.length === 0 ? <li>No features in this group.</li> : null}
                        </ul>
                      ) : null}
                    </div>
                  );
                })}
                {visibleGroups.length === 0 ? <div className="empty">No groups match "{query}".</div> : null}
              </div>
            </>
          ) : (
            <div className="empty" data-testid="feature-enum-inventory-empty">
              <div>
                {activeRunId
                  ? running
                    ? "Scanning codebase…"
                    : "No feature inventory in this run yet."
                  : "No feature inventory yet."}
              </div>
              <div className="hint">
                Create or refine a feature inventory. Set a refine iteration count and click Launch Scan to enumerate
                features grouped by domain.
              </div>
              <button
                className="button primary"
                data-testid="feature-enum-launch-empty"
                onClick={() => void launch()}
                disabled={busy}
              >
                Launch Scan
              </button>
            </div>
          )}
        </div>

        <aside className="sidebar">
          <div style={{ padding: "16px 16px 0" }}>
            <h3 className="section-head">Scan Notes</h3>
          </div>
          <div style={{ padding: "0 16px 16px" }} data-testid="feature-enum-notes">
            {inventory && inventory.markdownBody ? (
              <div className="notes">
                <pre>{inventory.markdownBody}</pre>
              </div>
            ) : (
              <div className="empty" style={{ padding: "20px 0" }}>
                No scan notes yet.
              </div>
            )}
          </div>

          <div className="section-head" style={{ padding: "0 16px", marginBottom: 0 }}>
            Refine History
          </div>
          <div data-testid="feature-enum-history">
            {featureRuns.map((r) => {
              const count = refineInputCount(r.input);
              return (
                <button
                  key={r.runId}
                  className={"run-row" + (r.runId === activeRunId ? " active" : "")}
                  data-testid={"feature-enum-run-" + r.runId}
                  onClick={() => setSelectedRunId(r.runId)}
                >
                  <span className="top">
                    <span className="mono">{shortRunId(r.runId)}</span>
                    <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
                  </span>
                  <span className="sub">
                    {isRefiningExisting(r.input) ? "refine existing" : "fresh"}
                    {count !== undefined ? " · " + count + " iters" : ""}
                  </span>
                </button>
              );
            })}
            {featureRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
          </div>
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
