/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smthrs/gateway-react";
import { WorkflowUiStyles } from "smthrs/gateway-ui";
import { sharedDarkThemeCss } from "./shared-theme";

const WORKFLOW_KEY = "audit";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

// Mirror of ForEachFeature's slugify so we can reconstruct dynamic group node ids
// purely from the run input (features record) without depending on event internals.
function slugifyFeatureToken(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "item";
}

type FeatureGroup = { index: number; groupName: string; features: string[]; nodeId: string };

function deriveGroups(runData: unknown): FeatureGroup[] {
  const run = isRecord(runData) ? runData : {};
  const input = isRecord(run.input) ? run.input : isRecord(run.inputs) ? run.inputs : {};
  const features = isRecord(input.features) ? input.features : {};
  const entries = Object.entries(features).filter(
    ([, groupFeatures]) => Array.isArray(groupFeatures) && groupFeatures.length > 0,
  );
  return entries.map(([groupName, groupFeatures], index) => ({
    index,
    groupName,
    features: asStringArray(groupFeatures),
    nodeId: "audit:group:" + slugifyFeatureToken(groupName) + ":" + index,
  }));
}

function deriveFocus(runData: unknown): string | undefined {
  const run = isRecord(runData) ? runData : {};
  const input = isRecord(run.input) ? run.input : isRecord(run.inputs) ? run.inputs : {};
  return asString(input.focus);
}

type GroupResult = {
  groupName?: string;
  result?: string;
  featuresCovered: string[];
  score?: number;
};
function extractGroupResult(value: unknown): GroupResult | null {
  const response = isRecord(value) ? value : {};
  const row = isRecord(response.row) ? response.row : isRecord(response) ? response : {};
  if (Object.keys(row).length === 0) return null;
  const groupName = asString(row.groupName);
  const result = asString(row.result);
  if (groupName === undefined && result === undefined) return null;
  return {
    groupName,
    result,
    featuresCovered: asStringArray(row.featuresCovered),
    score: asNumber(row.score),
  };
}

type MergeResult = {
  totalGroups?: number;
  summary?: string;
  mergedResult?: string;
  markdownBody?: string;
};
function extractMerge(value: unknown): MergeResult | null {
  const response = isRecord(value) ? value : {};
  const row = isRecord(response.row) ? response.row : isRecord(response) ? response : {};
  const summary = asString(row.summary);
  const markdownBody = asString(row.markdownBody);
  if (summary === undefined && markdownBody === undefined) return null;
  return {
    totalGroups: asNumber(row.totalGroups),
    summary,
    mergedResult: asString(row.mergedResult),
    markdownBody,
  };
}

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

function scoreClass(score: number | undefined) {
  if (score === undefined) return "";
  if (score >= 80) return "ok";
  if (score >= 50) return "warn";
  return "err";
}

const styles = [
  ...sharedDarkThemeCss,
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; flex-wrap:wrap; }",
  ".pill.focus { color:var(--primary); }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; }",
  ".prompt { flex:1; max-width:360px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".phases { display:flex; align-items:center; gap:8px; padding:10px 20px; border-bottom:1px solid var(--border); background:var(--panel); font-size:11px; }",
  ".phase { display:flex; align-items:center; gap:6px; color:var(--muted); }",
  ".phase .dot { width:8px; height:8px; border-radius:50%; background:var(--border); }",
  ".phase.active { color:var(--text); }",
  ".phase.active .dot { background:var(--primary); }",
  ".phase.done .dot { background:var(--ok); }",
  ".phase-sep { flex:0 0 28px; height:1px; background:var(--border); }",
  ".progress { flex:1; max-width:200px; height:6px; border-radius:3px; background:var(--card); overflow:hidden; }",
  ".progress > span { display:block; height:100%; background:var(--primary); }",
  ".main { display:grid; grid-template-columns:260px 1fr; flex:1; overflow:hidden; }",
  ".sidebar { border-right:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); display:flex; justify-content:space-between; }",
  ".group-row { width:100%; text-align:left; padding:11px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; flex-direction:column; gap:5px; }",
  ".group-row:hover { background:var(--card); }",
  ".group-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".group-row .name { font-weight:600; display:flex; align-items:center; gap:7px; }",
  ".group-row .meta { font-size:11px; color:var(--muted); display:flex; justify-content:space-between; gap:8px; }",
  ".sdot { width:8px; height:8px; border-radius:50%; flex:0 0 8px; background:var(--border); }",
  ".sdot.running { background:var(--warn); }",
  ".sdot.done { background:var(--ok); }",
  ".score { font-family:ui-monospace,monospace; font-weight:600; }",
  ".score.ok { color:var(--ok); }",
  ".score.warn { color:var(--warn); }",
  ".score.err { color:var(--err); }",
  ".tabs { display:flex; gap:6px; margin-bottom:18px; }",
  ".tab { height:28px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--muted); cursor:pointer; }",
  ".tab.active { background:var(--card); color:var(--text); border-color:var(--primary); }",
  ".card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:18px 20px; margin-bottom:18px; }",
  ".card h2 { margin:0 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".detail-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }",
  ".detail-head h2 { margin:0; font-size:16px; text-transform:none; letter-spacing:0; color:var(--text); }",
  ".chips { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 0; }",
  ".chip { font-size:11px; color:var(--muted); background:var(--panel); border:1px solid var(--border); border-radius:5px; padding:3px 8px; }",
  ".findings { white-space:pre-wrap; font-size:13px; line-height:1.6; margin:0; }",
  ".report-body { white-space:pre-wrap; font-family:ui-monospace,monospace; font-size:12px; line-height:1.6; margin:0; }",
  ".empty .button { margin-top:14px; }",
  ".meta-row { display:flex; gap:16px; color:var(--muted); font-size:12px; margin-top:6px; }",
].join("\n");

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [selectedGroupIdx, setSelectedGroupIdx] = useState<number | undefined>(undefined);
  const [tab, setTab] = useState<"group" | "report">("group");
  const [prompt, setPrompt] = useState("code review");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const auditRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? auditRuns[0]?.runId;
  const activeRun = auditRuns.find((r) => r.runId === activeRunId);

  const runQuery = useGatewayRun(activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: undefined });
  const mergeOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "audit:merge", iteration: 0 });

  const groups = useMemo(() => deriveGroups(runQuery.data), [runQuery.data]);
  const focus = deriveFocus(runQuery.data);
  const merge = useMemo(() => extractMerge(mergeOutput.data), [mergeOutput.data]);
  const events = stream.events ?? [];
  const eventCount = events.length;
  const mergeStarted =
    events.some(
      (e) =>
        e.event === "NodeStarted" &&
        isRecord(e.payload) &&
        typeof e.payload.nodeId === "string" &&
        e.payload.nodeId.includes("merge"),
    ) || merge !== null;

  const activeGroupId = selectedGroupIdx !== undefined ? selectedGroupIdx : groups[0]?.index;
  const activeGroup = groups.find((g) => g.index === activeGroupId);

  // When the merge finishes, surface the consolidated report automatically.
  useEffect(() => {
    if (merge) setTab("report");
  }, [merge !== null]);

  async function refresh() {
    await Promise.all([runsQuery.refetch(), runQuery.refetch?.(), mergeOutput.refetch()]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { focus: prompt } });
      setSelectedRunId(run.runId);
      setSelectedGroupIdx(undefined);
      setTab("group");
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
  async function copyReport() {
    const text = merge?.markdownBody ?? merge?.mergedResult ?? merge?.summary ?? "";
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      /* clipboard unavailable */
    }
  }

  const groupCount = groups.length;
  const parallelDone = merge !== null;
  const parallelActive = !parallelDone && groupCount > 0 && statusClass(activeRun?.status) === "running";

  return (
    <main className="shell" data-testid="audit-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Audit</h1>
          <span className="pill" data-testid="audit-runid">
            {activeRunId ? shortRunId(activeRunId) : "No run"}
          </span>
          {focus ? (
            <span className="pill focus" data-testid="audit-focus">
              focus: {focus}
            </span>
          ) : null}
          <span className="pill" data-testid="audit-groupcount">
            {groupCount} groups
          </span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="audit-status">
              {activeRun.status ?? "idle"}
            </span>
          ) : null}
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="audit-focus-input"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="Audit focus (e.g. code review)"
          />
          <button className="button" data-testid="audit-refresh" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          {activeRun && statusClass(activeRun.status) === "running" ? (
            <button className="button danger" data-testid="audit-cancel" onClick={() => void cancel()} disabled={busy}>
              Cancel
            </button>
          ) : null}
          <button className="button primary" data-testid="audit-launch" onClick={() => void launch()} disabled={busy}>
            Start Audit
          </button>
        </div>
      </header>

      <div className="phases" data-testid="audit-timeline">
        <div className={"phase " + (parallelDone ? "done" : parallelActive ? "active" : "")}>
          <span className="dot" />
          <span>Parallel audit ({groupCount} groups)</span>
        </div>
        <div className="progress">
          <span style={{ width: parallelDone ? "100%" : parallelActive ? "55%" : "0%" }} />
        </div>
        <div className="phase-sep" />
        <div
          className={
            "phase " + (parallelDone ? (statusClass(activeRun?.status) === "finished" ? "done" : "active") : "")
          }
        >
          <span className="dot" />
          <span>Merge &amp; synthesize</span>
        </div>
        <div className="phase" style={{ marginLeft: "auto" }}>
          <span>{eventCount} events</span>
          {stream.streaming ? <span>· live</span> : null}
        </div>
      </div>

      <div className="main">
        <aside className="sidebar">
          <div className="side-head">
            <span>Feature groups</span>
            <span>{groupCount}</span>
          </div>
          {groups.map((g) => (
            <GroupRow
              key={g.nodeId}
              group={g}
              runId={activeRunId}
              active={g.index === activeGroupId && tab === "group"}
              onSelect={() => {
                setSelectedGroupIdx(g.index);
                setTab("group");
              }}
            />
          ))}
          {groupCount === 0 ? (
            <div className="empty" style={{ padding: "28px 16px" }}>
              No feature groups yet.
            </div>
          ) : null}
        </aside>

        <div className="content">
          <div className="tabs">
            <button
              className={"tab" + (tab === "group" ? " active" : "")}
              data-testid="audit-tab-group"
              onClick={() => setTab("group")}
            >
              Group findings
            </button>
            <button
              className={"tab" + (tab === "report" ? " active" : "")}
              data-testid="audit-tab-report"
              onClick={() => setTab("report")}
            >
              Consolidated report
            </button>
          </div>

          {tab === "group" ? (
            <section data-testid="audit-group-detail">
              {activeGroup ? (
                <GroupDetail group={activeGroup} runId={activeRunId} />
              ) : (
                <div className="empty" data-testid="audit-group-empty">
                  <div>{activeRunId ? "No feature groups in this run." : "No audit run selected."}</div>
                  {!activeRunId ? (
                    <button className="button primary" onClick={() => void launch()} disabled={busy}>
                      Start Audit
                    </button>
                  ) : null}
                </div>
              )}
            </section>
          ) : (
            <section data-testid="audit-report">
              {merge ? (
                <>
                  <div className="card">
                    <div className="detail-head">
                      <h2>Consolidated audit report</h2>
                      <button className="button" data-testid="audit-copy" onClick={() => void copyReport()}>
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <div data-testid="audit-report-summary">{merge.summary ?? "(no summary)"}</div>
                    <div className="meta-row">
                      <span>{merge.totalGroups ?? groupCount} groups audited</span>
                    </div>
                  </div>
                  <div className="card">
                    <h2>Report body</h2>
                    <pre className="report-body" data-testid="audit-report-body">
                      {merge.markdownBody ?? merge.mergedResult ?? ""}
                    </pre>
                  </div>
                </>
              ) : (
                <div className="empty" data-testid="audit-report-empty">
                  <div>
                    {mergeStarted
                      ? "Synthesizing consolidated report…"
                      : "The consolidated report appears once all groups are audited and merged."}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function GroupRow(props: { group: FeatureGroup; runId: string | undefined; active: boolean; onSelect: () => void }) {
  const out = useGatewayNodeOutput({ runId: props.runId, nodeId: props.group.nodeId, iteration: 0 });
  const result = extractGroupResult(out.data);
  const done = result !== null;
  return (
    <button
      className={"group-row" + (props.active ? " active" : "")}
      data-testid={"audit-group-" + props.group.nodeId}
      onClick={props.onSelect}
    >
      <span className="name">
        <span className={"sdot " + (done ? "done" : "")} />
        {props.group.groupName}
      </span>
      <span className="meta">
        <span>{result?.featuresCovered.length ?? props.group.features.length} features</span>
        {result?.score !== undefined ? (
          <span className={"score " + scoreClass(result.score)}>{result.score}</span>
        ) : (
          <span>{done ? "done" : "pending"}</span>
        )}
      </span>
    </button>
  );
}

function GroupDetail(props: { group: FeatureGroup; runId: string | undefined }) {
  const out = useGatewayNodeOutput({ runId: props.runId, nodeId: props.group.nodeId, iteration: 0 });
  const result = extractGroupResult(out.data);
  const features = result?.featuresCovered.length ? result.featuresCovered : props.group.features;
  return (
    <div className="card" data-testid="audit-group-card">
      <div className="detail-head">
        <h2 data-testid="audit-group-name">{result?.groupName ?? props.group.groupName}</h2>
        {result?.score !== undefined ? (
          <span
            className={"score " + scoreClass(result.score)}
            style={{ fontSize: 18 }}
            data-testid="audit-group-score"
          >
            {result.score}
          </span>
        ) : (
          <span className="badge">{result ? "done" : "pending"}</span>
        )}
      </div>
      <div className="chips" data-testid="audit-group-features">
        {features.length > 0 ? (
          features.map((f, i) => (
            <span className="chip" key={i}>
              {f}
            </span>
          ))
        ) : (
          <span className="chip">no features listed</span>
        )}
      </div>
      {result?.result ? (
        <pre className="findings" style={{ marginTop: 14 }} data-testid="audit-group-findings">
          {result.result}
        </pre>
      ) : (
        <div className="empty" style={{ padding: "32px 8px" }}>
          {props.runId ? "Waiting for this group's audit findings…" : "No run selected."}
        </div>
      )}
    </div>
  );
}

createGatewayReactRoot(<App />);
