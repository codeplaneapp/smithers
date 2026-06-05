/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "open-code-review";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type PreviewEntry = {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  willReview: boolean;
  excludeReason?: string;
};
type PreviewOutput = {
  entries: PreviewEntry[];
  totalInsertions: number;
  totalDeletions: number;
  totalFiles: number;
  reviewableCount: number;
  excludedCount: number;
};
type ReviewComment = {
  path: string;
  content: string;
  suggestionCode?: string;
  existingCode?: string;
  startLine?: number;
  endLine?: number;
};
type ReviewOutput = {
  status: string;
  ok: boolean;
  message?: string;
  comments: ReviewComment[];
  warnings: { file?: string; message?: string; type?: string }[];
  command?: string;
  stderr?: string;
  error?: string;
  summary?: { filesReviewed?: number; comments?: number; totalTokens?: number; elapsed?: string } | null;
};
type WorkflowSummary = {
  status: string;
  repoDir: string;
  mode: string;
  reviewableFiles: number;
  excludedFiles: number;
  comments: number;
  warnings: number;
  totalTokens: number;
  message: string;
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
function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function unwrapRow(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  if (isRecord(data.row)) return data.row;
  if (isRecord(data)) return data;
  return null;
}
function extractPreview(value: unknown): PreviewOutput | null {
  const row = unwrapRow(value);
  if (!row) return null;
  if (!Array.isArray(row.entries)) return null;
  return {
    entries: row.entries.filter(isRecord).map((entry) => ({
      path: asString(entry.path) ?? "",
      status: asString(entry.status) ?? "modified",
      insertions: asNumber(entry.insertions) ?? 0,
      deletions: asNumber(entry.deletions) ?? 0,
      willReview: asBool(entry.willReview) ?? false,
      excludeReason: asString(entry.excludeReason),
    })),
    totalInsertions: asNumber(row.totalInsertions) ?? 0,
    totalDeletions: asNumber(row.totalDeletions) ?? 0,
    totalFiles: asNumber(row.totalFiles) ?? 0,
    reviewableCount: asNumber(row.reviewableCount) ?? 0,
    excludedCount: asNumber(row.excludedCount) ?? 0,
  };
}
function extractReview(value: unknown): ReviewOutput | null {
  const row = unwrapRow(value);
  if (!row || row.status === undefined) return null;
  return {
    status: asString(row.status) ?? "failed",
    ok: asBool(row.ok) ?? false,
    message: asString(row.message),
    comments: Array.isArray(row.comments)
      ? row.comments.filter(isRecord).map((comment) => ({
          path: asString(comment.path) ?? "",
          content: asString(comment.content) ?? "",
          suggestionCode: asString(comment.suggestionCode),
          existingCode: asString(comment.existingCode),
          startLine: asNumber(comment.startLine),
          endLine: asNumber(comment.endLine),
        }))
      : [],
    warnings: Array.isArray(row.warnings)
      ? row.warnings.filter(isRecord).map((warning) => ({
          file: asString(warning.file),
          message: asString(warning.message),
          type: asString(warning.type),
        }))
      : [],
    command: asString(row.command),
    stderr: asString(row.stderr),
    error: asString(row.error),
    summary: isRecord(row.summary)
      ? {
          filesReviewed: asNumber(row.summary.filesReviewed),
          comments: asNumber(row.summary.comments),
          totalTokens: asNumber(row.summary.totalTokens),
          elapsed: asString(row.summary.elapsed),
        }
      : null,
  };
}
function extractSummary(value: unknown): WorkflowSummary | null {
  const row = unwrapRow(value);
  if (!row || row.status === undefined) return null;
  return {
    status: asString(row.status) ?? "failed",
    repoDir: asString(row.repoDir) ?? "",
    mode: asString(row.mode) ?? "",
    reviewableFiles: asNumber(row.reviewableFiles) ?? 0,
    excludedFiles: asNumber(row.excludedFiles) ?? 0,
    comments: asNumber(row.comments) ?? 0,
    warnings: asNumber(row.warnings) ?? 0,
    totalTokens: asNumber(row.totalTokens) ?? 0,
    message: asString(row.message) ?? "",
  };
}
function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished" || status === "success" || status === "skipped") return "finished";
  if (status === "failed" || status === "cancelled" || status === "completed_with_errors") return "failed";
  if (status === "completed_with_warnings") return "warn";
  return "";
}
function lineRange(comment: ReviewComment) {
  const start = comment.startLine ?? 0;
  const end = comment.endLine ?? 0;
  if (start <= 0 && end <= 0) return "";
  return start === end ? String(start) : `${start}-${end}`;
}

const styles = [
  ":root { --bg:#101112; --panel:#181a1d; --card:#202329; --text:#f4f1e8; --muted:#9ca3ad; --border:#30343b; --primary:#4f8cff; --ok:#55c97a; --warn:#e3b341; --err:#f06b64; --ink:#0c0d0f; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.45; }",
  "button,input,textarea { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; gap:14px; padding:12px 18px; border-bottom:1px solid var(--border); background:var(--panel); }",
  "h1 { margin:0; font-size:15px; font-weight:650; white-space:nowrap; }",
  ".badge { display:inline-flex; align-items:center; height:24px; padding:0 8px; border-radius:5px; border:1px solid var(--border); color:var(--muted); font-size:11px; font-weight:700; text-transform:uppercase; }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".badge.warn { color:var(--warn); border-color:var(--warn); }",
  ".runid { font-family:ui-monospace,monospace; text-transform:none; font-weight:500; }",
  ".toolbar { display:flex; align-items:center; gap:8px; margin-left:auto; }",
  ".button { height:30px; padding:0 11px; border:1px solid var(--border); border-radius:6px; background:var(--card); color:var(--text); cursor:pointer; font-weight:600; }",
  ".button:hover { border-color:var(--primary); }",
  ".button.primary { background:var(--primary); border-color:var(--primary); color:#fff; }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.45; cursor:not-allowed; }",
  ".layout { display:grid; grid-template-columns:310px minmax(0,1fr) 270px; min-height:0; flex:1; }",
  ".left,.right { background:var(--panel); overflow:auto; }",
  ".left { border-right:1px solid var(--border); }",
  ".right { border-left:1px solid var(--border); }",
  ".content { overflow:auto; padding:18px; }",
  ".form { padding:14px; display:grid; gap:10px; }",
  ".field { display:grid; gap:5px; }",
  ".field span { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }",
  ".input,.textarea { width:100%; border:1px solid var(--border); border-radius:6px; background:#111316; color:var(--text); padding:8px 9px; min-width:0; }",
  ".textarea { min-height:72px; resize:vertical; }",
  ".two { display:grid; grid-template-columns:1fr 1fr; gap:8px; }",
  ".check { display:flex; align-items:center; gap:8px; color:var(--muted); }",
  ".check input { width:16px; height:16px; }",
  ".section-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 14px; border-bottom:1px solid var(--border); color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }",
  ".run-row { width:100%; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); padding:10px 14px; display:grid; grid-template-columns:1fr auto; gap:6px; text-align:left; cursor:pointer; }",
  ".run-row:hover,.run-row.active { background:var(--card); }",
  ".run-row.active { box-shadow:inset 2px 0 0 var(--primary); }",
  ".mono { font-family:ui-monospace,monospace; }",
  ".muted { color:var(--muted); }",
  ".kpis { display:grid; grid-template-columns:repeat(4,minmax(120px,1fr)); gap:10px; margin-bottom:14px; }",
  ".kpi { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px; min-height:76px; }",
  ".kpi .label { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }",
  ".kpi .value { margin-top:6px; font-size:24px; font-weight:720; }",
  ".timeline { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:14px; }",
  ".stage { display:flex; align-items:center; gap:8px; min-height:34px; border:1px solid var(--border); border-radius:8px; padding:7px 10px; color:var(--muted); background:var(--panel); }",
  ".stage.done { color:var(--ok); border-color:rgba(85,201,122,.55); }",
  ".stage.active { color:var(--primary); border-color:var(--primary); }",
  ".dot { width:9px; height:9px; border-radius:50%; background:var(--border); flex:0 0 9px; }",
  ".stage.done .dot { background:var(--ok); }",
  ".stage.active .dot { background:var(--primary); }",
  ".panel { background:var(--card); border:1px solid var(--border); border-radius:8px; margin-bottom:14px; overflow:hidden; }",
  ".panel-title { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 14px; border-bottom:1px solid var(--border); }",
  ".panel-title h2 { margin:0; font-size:13px; }",
  ".panel-body { padding:14px; }",
  ".table { width:100%; border-collapse:collapse; }",
  ".table th,.table td { padding:8px 9px; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; }",
  ".table th { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; font-weight:700; }",
  ".table tr:last-child td { border-bottom:0; }",
  ".path { font-family:ui-monospace,monospace; font-size:12px; word-break:break-word; }",
  ".num { font-family:ui-monospace,monospace; white-space:nowrap; }",
  ".plus { color:var(--ok); }",
  ".minus { color:var(--err); }",
  ".reason { color:var(--muted); font-size:12px; }",
  ".comment { padding:13px 14px; border-bottom:1px solid var(--border); }",
  ".comment:last-child { border-bottom:0; }",
  ".comment-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }",
  ".comment-body { color:var(--text); white-space:pre-wrap; }",
  ".code { margin-top:8px; padding:10px; border:1px solid var(--border); border-radius:6px; background:#101215; color:#cfd6df; white-space:pre-wrap; overflow:auto; font-size:12px; }",
  ".alert { border:1px solid var(--border); border-radius:8px; padding:12px; background:var(--panel); color:var(--muted); }",
  ".alert.err { color:var(--err); border-color:var(--err); }",
  ".alert.warn { color:var(--warn); border-color:var(--warn); }",
  ".empty { color:var(--muted); text-align:center; padding:40px 14px; }",
  "@media (max-width:1100px) { .layout { grid-template-columns:290px minmax(0,1fr); } .right { display:none; } .kpis { grid-template-columns:repeat(2,1fr); } }",
  "@media (max-width:760px) { .topbar { flex-wrap:wrap; } .toolbar { width:100%; margin-left:0; } .layout { grid-template-columns:1fr; } .left { border-right:0; border-bottom:1px solid var(--border); max-height:420px; } .timeline,.kpis { grid-template-columns:1fr 1fr; } }",
].join("\n");

function Stage(props: { label: string; done: boolean; active: boolean; testId: string }) {
  return (
    <div className={"stage" + (props.done ? " done" : "") + (props.active ? " active" : "")} data-testid={props.testId}>
      <span className="dot" />
      <span>{props.label}</span>
    </div>
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [repo, setRepo] = useState(".");
  const [fromRef, setFromRef] = useState("");
  const [toRef, setToRef] = useState("");
  const [commit, setCommit] = useState("");
  const [background, setBackground] = useState("");
  const [runReview, setRunReview] = useState(true);
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();
  const runs = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((run) => !run.workflowKey || run.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;
  const activeRun = runs.find((run) => run.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const targetOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "resolve-target", iteration: 0 });
  const previewOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "preview", iteration: 0 });
  const reviewOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review", iteration: 0 });
  const summaryOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "summary", iteration: 0 });

  const target = unwrapRow(targetOut.data);
  const preview = useMemo(() => extractPreview(previewOut.data), [previewOut.data]);
  const review = useMemo(() => extractReview(reviewOut.data), [reviewOut.data]);
  const summary = useMemo(() => extractSummary(summaryOut.data), [summaryOut.data]);
  const eventCount = (stream.events ?? []).length;
  const runStatus = statusClass(activeRun?.status);
  const workflowStatus = statusClass(summary?.status ?? review?.status ?? activeRun?.status);

  const hasTarget = target !== null;
  const hasPreview = preview !== null;
  const hasReview = review !== null;
  const hasSummary = summary !== null;
  const activeStage = !hasTarget ? "target" : !hasPreview ? "preview" : !hasReview ? "review" : !hasSummary ? "summary" : "";
  const reviewableEntries = preview?.entries.filter((entry) => entry.willReview) ?? [];
  const excludedEntries = preview?.entries.filter((entry) => !entry.willReview) ?? [];

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      targetOut.refetch(),
      previewOut.refetch(),
      reviewOut.refetch(),
      summaryOut.refetch(),
    ]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({
        workflow: WORKFLOW_KEY,
        input: {
          repo,
          from: fromRef,
          to: toRef,
          commit,
          background,
          runReview,
        },
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

  return (
    <main className="shell" data-testid="open-code-review-ui">
      <style>{styles}</style>
      <header className="topbar">
        <h1>Open Code Review</h1>
        <span className={"badge " + workflowStatus} data-testid="ocr-workflow-status">
          {summary?.status ?? review?.status ?? activeRun?.status ?? "idle"}
        </span>
        <span className="badge runid" data-testid="ocr-runid">{activeRunId ? shortRunId(activeRunId) : "No run"}</span>
        <span className="badge runid" data-testid="ocr-events">{eventCount} events</span>
        <div className="toolbar">
          <button className="button" data-testid="ocr-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          {runStatus === "running" ? (
            <button className="button danger" data-testid="ocr-cancel" onClick={() => void cancel()} disabled={busy}>Cancel</button>
          ) : null}
          <button className="button primary" data-testid="ocr-launch" onClick={() => void launch()} disabled={busy}>Run Review</button>
        </div>
      </header>

      <div className="layout">
        <aside className="left">
          <div className="section-head"><span>Run input</span></div>
          <div className="form">
            <label className="field">
              <span>Repo</span>
              <input className="input" data-testid="ocr-input-repo" value={repo} onChange={(e) => setRepo(e.currentTarget.value)} />
            </label>
            <div className="two">
              <label className="field">
                <span>From</span>
                <input className="input" data-testid="ocr-input-from" value={fromRef} onChange={(e) => setFromRef(e.currentTarget.value)} />
              </label>
              <label className="field">
                <span>To</span>
                <input className="input" data-testid="ocr-input-to" value={toRef} onChange={(e) => setToRef(e.currentTarget.value)} />
              </label>
            </div>
            <label className="field">
              <span>Commit</span>
              <input className="input" data-testid="ocr-input-commit" value={commit} onChange={(e) => setCommit(e.currentTarget.value)} />
            </label>
            <label className="field">
              <span>Background</span>
              <textarea className="textarea" data-testid="ocr-input-background" value={background} onChange={(e) => setBackground(e.currentTarget.value)} />
            </label>
            <label className="check">
              <input data-testid="ocr-input-run-review" type="checkbox" checked={runReview} onChange={(e) => setRunReview(e.currentTarget.checked)} />
              <span>Execute OCR</span>
            </label>
          </div>

          <div className="section-head"><span>Recent runs</span><span>{runs.length}</span></div>
          {runs.map((run) => (
            <button
              key={run.runId}
              className={"run-row" + (run.runId === activeRunId ? " active" : "")}
              data-testid={"ocr-run-" + run.runId}
              onClick={() => setSelectedRunId(run.runId)}
            >
              <span className="mono">{shortRunId(run.runId)}</span>
              <span className={"badge " + statusClass(run.status)}>{run.status ?? "idle"}</span>
            </button>
          ))}
        </aside>

        <section className="content">
          <div className="timeline">
            <Stage label="Target" done={hasTarget} active={activeStage === "target"} testId="ocr-stage-target" />
            <Stage label="Preview" done={hasPreview} active={activeStage === "preview"} testId="ocr-stage-preview" />
            <Stage label="Review" done={hasReview} active={activeStage === "review"} testId="ocr-stage-review" />
            <Stage label="Summary" done={hasSummary} active={activeStage === "summary"} testId="ocr-stage-summary" />
          </div>

          <div className="kpis">
            <div className="kpi" data-testid="ocr-kpi-reviewable">
              <div className="label">Reviewable</div>
              <div className="value">{preview?.reviewableCount ?? 0}</div>
            </div>
            <div className="kpi" data-testid="ocr-kpi-excluded">
              <div className="label">Excluded</div>
              <div className="value">{preview?.excludedCount ?? 0}</div>
            </div>
            <div className="kpi" data-testid="ocr-kpi-comments">
              <div className="label">Comments</div>
              <div className="value">{review?.comments.length ?? 0}</div>
            </div>
            <div className="kpi" data-testid="ocr-kpi-tokens">
              <div className="label">Tokens</div>
              <div className="value">{review?.summary?.totalTokens ?? 0}</div>
            </div>
          </div>

          {summary ? (
            <div className={"alert " + statusClass(summary.status)} data-testid="ocr-summary-message">{summary.message}</div>
          ) : activeRunId ? null : (
            <div className="empty" data-testid="ocr-empty">No run selected.</div>
          )}

          {review?.error ? <div className="alert err" data-testid="ocr-error">{review.error}</div> : null}
          {review?.stderr ? <div className="alert warn" data-testid="ocr-stderr">{review.stderr}</div> : null}

          <div className="panel" data-testid="ocr-comments-panel">
            <div className="panel-title">
              <h2>Comments</h2>
              <span className="badge">{review?.comments.length ?? 0}</span>
            </div>
            {review && review.comments.length > 0 ? (
              review.comments.map((comment, index) => (
                <article className="comment" data-testid={"ocr-comment-" + index} key={index}>
                  <div className="comment-head">
                    <span className="path">{comment.path}{lineRange(comment) ? ":" + lineRange(comment) : ""}</span>
                    <span className="badge">{comment.startLine && comment.startLine > 0 ? "positioned" : "unpositioned"}</span>
                  </div>
                  <div className="comment-body">{comment.content}</div>
                  {comment.suggestionCode ? <pre className="code">{comment.suggestionCode}</pre> : null}
                </article>
              ))
            ) : (
              <div className="empty" data-testid="ocr-comments-empty">No comments.</div>
            )}
          </div>

          <div className="panel" data-testid="ocr-preview-panel">
            <div className="panel-title">
              <h2>Preview</h2>
              <span className="badge">{preview?.totalFiles ?? 0} files</span>
            </div>
            {preview ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Status</th>
                    <th>Change</th>
                    <th>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.entries.map((entry, index) => (
                    <tr data-testid={"ocr-preview-file-" + index} key={entry.path + index}>
                      <td className="path">{entry.path}</td>
                      <td>{entry.status}</td>
                      <td className="num">
                        <span className="plus">+{entry.insertions}</span>{" "}
                        <span className="minus">-{entry.deletions}</span>
                      </td>
                      <td>{entry.willReview ? "review" : <span className="reason">{entry.excludeReason || "exclude"}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty" data-testid="ocr-preview-empty">No preview.</div>
            )}
          </div>
        </section>

        <aside className="right">
          <div className="section-head"><span>Target</span></div>
          <div className="form">
            <div className="field"><span>Mode</span><div className="mono">{asString(target?.mode) ?? "-"}</div></div>
            <div className="field"><span>Ref</span><div className="mono">{asString(target?.ref) ?? "-"}</div></div>
            <div className="field"><span>Command</span><div className="mono muted">{review?.command ?? "-"}</div></div>
          </div>
          <div className="section-head"><span>Review queue</span><span>{reviewableEntries.length}</span></div>
          {reviewableEntries.map((entry, index) => (
            <div className="comment" data-testid={"ocr-queue-" + index} key={entry.path}>
              <div className="path">{entry.path}</div>
              <div className="num"><span className="plus">+{entry.insertions}</span> <span className="minus">-{entry.deletions}</span></div>
            </div>
          ))}
          <div className="section-head"><span>Excluded</span><span>{excludedEntries.length}</span></div>
          {excludedEntries.map((entry, index) => (
            <div className="comment" data-testid={"ocr-excluded-" + index} key={entry.path}>
              <div className="path">{entry.path}</div>
              <div className="reason">{entry.excludeReason}</div>
            </div>
          ))}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
