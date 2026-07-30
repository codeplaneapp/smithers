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

const WORKFLOW_KEY = "vcs";
const ACTIONS = ["status", "log", "commit", "rebase-plan"] as const;
type Action = (typeof ACTIONS)[number];

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type Change = { path: string; code: string; staged: boolean };
type Commit = { id: string; subject: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
/** Node-output hooks return either the row directly or `{ row, schema, status }`. */
function rowOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.row)) return value.row;
  return value;
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

type StatusView = {
  tool: string;
  repo: boolean;
  branch: string;
  head: string;
  clean: boolean;
  summary: string;
  changes: Change[];
};
function extractStatus(value: unknown): StatusView | null {
  const row = rowOf(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const changes: Change[] = asArray(row.changes)
    .filter(isRecord)
    .map((c) => ({
      path: asString(c.path) ?? "",
      code: asString(c.code) ?? "?",
      staged: asBool(c.staged),
    }));
  return {
    tool: asString(row.tool) ?? "git",
    repo: asBool(row.isRepo ?? row.is_repo),
    branch: asString(row.branch) ?? "",
    head: asString(row.head) ?? "",
    clean: asBool(row.clean),
    summary,
    changes,
  };
}

function extractCommits(value: unknown): { summary: string; commits: Commit[] } | null {
  const row = rowOf(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const commits: Commit[] = asArray(row.commits)
    .filter(isRecord)
    .map((c) => ({
      id: asString(c.id) ?? "",
      subject: asString(c.subject) ?? "",
    }));
  return { summary, commits };
}

function extractMessage(value: unknown): { message: string; command: string } | null {
  const row = rowOf(value);
  if (!row) return null;
  const message = asString(row.message);
  if (message === undefined) return null;
  return { message, command: asString(row.command) ?? "" };
}

function extractRebasePlan(value: unknown): { summary: string; steps: string[] } | null {
  const row = rowOf(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const steps = asArray(row.steps)
    .map((s) => asString(s) ?? "")
    .filter((s) => s.length > 0);
  return { summary, steps };
}

const styles = [
  ...sharedDarkThemeCss,
  "button,input,select { font:inherit; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); font-family:ui-monospace,monospace; }",
  ".toolbar { display:flex; align-items:center; gap:8px; }",
  ".select { height:30px; padding:0 8px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".main { display:grid; grid-template-columns:1fr 260px; flex:1; overflow:hidden; }",
  ".panel { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px 18px; margin-bottom:16px; }",
  ".panel h2 { margin:0 0 4px; font-size:13px; font-weight:600; }",
  ".summary { color:var(--text); font-size:14px; margin-bottom:10px; }",
  ".meta { color:var(--muted); font-size:12px; margin-bottom:12px; font-family:ui-monospace,monospace; }",
  ".change { display:flex; align-items:center; gap:10px; padding:5px 0; border-top:1px solid var(--border); }",
  ".change:first-of-type { border-top:0; }",
  ".glyph { flex:none; display:grid; place-items:center; width:18px; height:18px; border-radius:5px; font:700 11px/1 ui-monospace,monospace; color:var(--primary); background:rgba(94,106,210,0.16); }",
  ".glyph.A { color:var(--ok); background:rgba(74,222,128,0.14); }",
  ".glyph.M { color:var(--warn); background:rgba(251,191,36,0.14); }",
  ".glyph.D { color:var(--err); background:rgba(248,113,113,0.14); }",
  ".path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,monospace; font-size:12px; }",
  ".dot { flex:none; width:8px; height:8px; border-radius:50%; background:#3a3a3e; }",
  ".dot.on { background:var(--ok); }",
  ".commit { display:flex; gap:10px; padding:4px 0; font-size:12px; }",
  ".commit .id { color:var(--primary); font-family:ui-monospace,monospace; }",
  ".steps { margin:8px 0 0; padding-left:18px; }",
  ".steps li { margin:4px 0; }",
  ".code { font-family:ui-monospace,monospace; font-size:12px; background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:8px 10px; white-space:pre-wrap; word-break:break-word; }",
  ".patch { max-height:300px; overflow:auto; font-family:ui-monospace,monospace; font-size:11px; white-space:pre; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:10px; }",
  ".empty .desc { max-width:440px; margin:8px auto 0; font-size:12px; line-height:1.6; }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; align-items:center; }",
].join("\n");

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [action, setAction] = useState<Action>("status");
  const [vcs, setVcs] = useState<"git" | "jj">("git");
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const vcsRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? vcsRuns[0]?.runId;
  const activeRun = vcsRuns.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const eventCount = (stream.events ?? []).length;

  const statusOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "vcs:status", iteration: 0 });
  const logOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "vcs:log", iteration: 0 });
  const diffOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "vcs:diff", iteration: 0 });
  const messageOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "vcs:message", iteration: 0 });
  const rebaseOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "vcs:rebasePlan", iteration: 0 });

  const status = extractStatus(statusOut.data);
  const log = extractCommits(logOut.data);
  const message = extractMessage(messageOut.data);
  const rebase = extractRebasePlan(rebaseOut.data);
  const diffRow = rowOf(diffOut.data);
  const patch = diffRow ? (asString(diffRow.patch) ?? "") : "";

  const hasAny = status || log || message || rebase || patch.length > 0;

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      statusOut.refetch(),
      logOut.refetch(),
      diffOut.refetch(),
      messageOut.refetch(),
      rebaseOut.refetch(),
    ]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { action, vcs } });
      setSelectedRunId(run.runId);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell" data-testid="vcs-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>VCS</h1>
          <span className="pill" data-testid="vcs-runid">
            {activeRunId ? shortRunId(activeRunId) : "No run"}
          </span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="vcs-status-badge">
              {activeRun.status ?? "idle"}
            </span>
          ) : null}
        </div>
        <div className="toolbar">
          <select
            className="select"
            data-testid="vcs-vcs"
            value={vcs}
            onChange={(e) => setVcs(e.currentTarget.value as "git" | "jj")}
          >
            <option value="git">git</option>
            <option value="jj">jj</option>
          </select>
          <select
            className="select"
            data-testid="vcs-action"
            value={action}
            onChange={(e) => setAction(e.currentTarget.value as Action)}
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <button className="button" data-testid="vcs-refresh" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          <button className="button primary" data-testid="vcs-launch" onClick={() => void launch()} disabled={busy}>
            Run {action}
          </button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {status ? (
            <section className="panel" data-testid="vcs-status">
              <h2>Working tree</h2>
              <div className="summary" data-testid="vcs-status-summary">
                {status.summary}
              </div>
              {status.repo ? (
                <div className="meta">
                  {status.branch}
                  {status.head ? " @ " + status.head : ""}
                </div>
              ) : null}
              {status.changes.map((c) => (
                <div className="change" key={c.path} data-testid="vcs-change">
                  <span className={"glyph " + c.code.slice(0, 1)}>{c.code.slice(0, 1) || "?"}</span>
                  <span className="path">{c.path}</span>
                  <span className={c.staged ? "dot on" : "dot"} title={c.staged ? "staged" : "unstaged"} />
                </div>
              ))}
            </section>
          ) : null}

          {log ? (
            <section className="panel" data-testid="vcs-log">
              <h2>History</h2>
              <div className="summary">{log.summary}</div>
              {log.commits.map((c, i) => (
                <div className="commit" key={c.id + ":" + i}>
                  <span className="id">{c.id}</span>
                  <span>{c.subject}</span>
                </div>
              ))}
            </section>
          ) : null}

          {message ? (
            <section className="panel" data-testid="vcs-message">
              <h2>Commit message (drafted by agent)</h2>
              <div className="code">{message.message}</div>
              {message.command ? (
                <div className="meta" style={{ marginTop: 8 }}>
                  {message.command}
                </div>
              ) : null}
            </section>
          ) : null}

          {rebase ? (
            <section className="panel" data-testid="vcs-rebase">
              <h2>Rebase plan (drafted by agent)</h2>
              <div className="summary">{rebase.summary}</div>
              <ol className="steps">
                {rebase.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </section>
          ) : null}

          {patch.length > 0 ? (
            <section className="panel" data-testid="vcs-diff">
              <h2>Diff</h2>
              <div className="patch">{patch}</div>
            </section>
          ) : null}

          {!hasAny ? (
            <div className="empty" data-testid="vcs-empty">
              <div>{activeRunId ? "Waiting for the workflow…" : "No VCS runs yet."}</div>
              <div className="desc">
                Pick a backend and an action, then Run. <b>status</b> and <b>log</b> read the working tree directly;
                <b> commit</b> has an agent draft a message from the staged diff, and <b>rebase-plan</b> has an agent
                plan the rebase. Nothing is executed against the repo.
              </div>
            </div>
          ) : null}

          <div className="meta" style={{ marginTop: 4 }}>
            {eventCount} events
          </div>
        </div>

        <aside className="sidebar">
          <div className="side-head">Recent runs</div>
          {vcsRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"vcs-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {vcsRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
