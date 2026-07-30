/** @jsxImportSource react */
import {
  createGatewayReactRoot,
  useGatewayApprovals,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import { sharedDarkThemeCss } from "./shared-theme";

const WORKFLOW_KEY = "microsandbox-finish";

type NodeStatus = "pending" | "running" | "done" | "failed" | "waiting" | "skipped";
type NodeState = { status: NodeStatus; startedMs?: number; finishedMs?: number; iteration: number };
type EventLine = { ts: number; type: string; nodeId: string };

const PHASES = ["provider-purge", "local-harness", "conformance-local", "ci-canary", "suite-green"];

const NODE_EXPLAINS: Record<string, string> = {
  prep: "verify workspaces + mission brief exist",
  "docs-improve":
    "Fable reviews/improves docs, revises specs to Microsandbox-only, writes the work plan, freezes the suite gates",
  "docs-check": "deterministic check: workplan on disk, gates parse, zero retired-provider vocabulary in spec+runbook",
  "phase-provider-purge": "Sol removes every retired-provider remnant (code, config, Helm, dashboards, docs)",
  "phase-provider-purge-review": "Sol adversarially reviews its own purge",
  "phase-local-harness":
    "Sol builds the REAL local harness: compose deps + HVF Microsandbox + connected controller/API",
  "phase-local-harness-review": "Sol re-runs the harness entrypoint to verify",
  "phase-conformance-local": "Sol makes the full provider-conformance lifecycle + E2E green locally",
  "phase-conformance-local-review": "Sol re-runs the suites to verify the tallies",
  "phase-ci-canary": "Sol adds the Linux KVM CI gate + prod canary wiring",
  "phase-ci-canary-review": "Sol validates pipeline/helm/terraform configs",
  "phase-suite-green": "Sol reruns every affected suite in Plue/Multi/Smithers drafts",
  "phase-suite-green-review": "Sol re-runs the suite commands to verify",
  "fable-review": "Fable reviews EVERYTHING and polishes; loop until LGTM",
  "lgtm-fix": "Sol fixes Fable's findings",
  "approve-integration": "HUMAN GATE: integrate drafts into the original repos?",
  integrate: "Fable integrates into ~/plue ~/multi ~/smithers (pathspec-scoped jj, no pushes)",
  "integrate-review": "Sol verifies integration parity, no swept-in WIP, nothing pushed",
  "approve-deploy": "HUMAN GATE: deploy Microsandbox to production?",
  deploy: "Fable deploys per the runbook (GKE sandbox cluster, secrets, Helm, migration 000102)",
  "prod-proof": "Fable proves the full sandbox lifecycle in production",
  "issue-draft": "Sol drafts the upstream Iron/Microsandbox issue (no filing)",
  "approve-file-upstream": "HUMAN GATE: file the upstream issue?",
  "issue-file": "Luna files the approved issue via gh",
  summary: "final roll-up of the whole run",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function isTrue(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function unwrapRow(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  return isRecord(data.row) ? data.row : isRecord(data) ? data : null;
}
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function fmtAgo(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return s + "s";
  if (s < 5400) return Math.round(s / 60) + "m";
  return (s / 3600).toFixed(1) + "h";
}
function fmtClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return "";
  }
}

type GateDef = { gateKey: string; command: string };
function extractGates(row: Record<string, unknown> | null): GateDef[] {
  if (!row) return [];
  const raw = parseMaybeJson(row.gatesJson);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): GateDef | null => {
      if (!isRecord(entry)) return null;
      const gateKey = asString(entry.gateKey);
      if (!gateKey) return null;
      return { gateKey, command: asString(entry.command) ?? "" };
    })
    .filter((entry): entry is GateDef => entry !== null);
}

/**
 * Event frames vary by transport: the lifecycle name can sit at frame.type,
 * frame.payload.type, or frame.payload.event, and the wrapper frame may carry
 * its own non-lifecycle type. Pick the first candidate that LOOKS like a
 * lifecycle name instead of trusting field position.
 */
const LIFECYCLE_RE = /^(Node|Run|Task)[A-Za-z]+$/;
function eventParts(ev: unknown): EventLine | null {
  if (!isRecord(ev)) return null;
  const payload = isRecord(ev.payload) ? ev.payload : undefined;
  const inner = payload && isRecord(payload.payload) ? payload.payload : undefined;
  const type =
    [asString(payload?.event), asString(payload?.type), asString(ev.type), asString(ev.event)].find(
      (candidate) => candidate && LIFECYCLE_RE.test(candidate),
    ) ?? "";
  const nodeId = asString(inner?.nodeId) ?? asString(payload?.nodeId) ?? asString(ev.nodeId) ?? "";
  const ts =
    [inner?.timestampMs, payload?.timestampMs, ev.timestampMs]
      .map(Number)
      .find((candidate) => Number.isFinite(candidate) && candidate > 0) ?? 0;
  if (!type || !nodeId) return null;
  const iterRaw = Number(inner?.iteration ?? payload?.iteration ?? 0);
  return { ts, type, nodeId: nodeId + (Number.isFinite(iterRaw) && iterRaw > 0 ? "#" + iterRaw : "") };
}

function buildNodeState(events: unknown[]): { byNode: Map<string, NodeState>; lines: EventLine[] } {
  const byNode = new Map<string, NodeState>();
  const lines: EventLine[] = [];
  for (const ev of events) {
    const parts = eventParts(ev);
    if (!parts) continue;
    lines.push(parts);
    const [bareNode, iterStr] = parts.nodeId.split("#");
    const iteration = Number(iterStr ?? 0) || 0;
    const prior = byNode.get(bareNode) ?? { status: "pending" as NodeStatus, iteration: 0 };
    const next: NodeState = { ...prior, iteration: Math.max(prior.iteration, iteration) };
    if (parts.type === "NodeFinished") {
      next.status = "done";
      next.finishedMs = parts.ts;
    } else if (parts.type === "NodeFailed" || parts.type === "NodeCancelled") {
      next.status = "failed";
      next.finishedMs = parts.ts;
    } else if (parts.type === "NodeSkipped") {
      next.status = "skipped";
    } else if (parts.type === "NodeWaitingApproval") {
      next.status = "waiting";
    } else if (parts.type === "NodeStarted" || parts.type === "NodeRetrying") {
      next.status = "running";
      next.startedMs = parts.ts || prior.startedMs;
    } else if (parts.type === "TaskHeartbeat" && prior.status !== "done" && prior.status !== "failed") {
      next.status = "running";
      next.startedMs = prior.startedMs ?? parts.ts;
    }
    byNode.set(bareNode, next);
  }
  return { byNode, lines };
}

function dotClass(status: NodeStatus | undefined): string {
  return "dot " + (status ?? "pending");
}

function Stage({ label, state }: { label: string; state: NodeState | undefined }) {
  const iter = state && state.iteration > 0 ? " ×" + (state.iteration + 1) : "";
  return (
    <span
      className="stage"
      title={
        state
          ? state.status + (state.startedMs ? " · started " + fmtAgo(state.startedMs) + " ago" : "")
          : "not reached yet"
      }
    >
      <span className={dotClass(state?.status)} /> {label}
      {iter}
    </span>
  );
}

function NowRunning({ byNode }: { byNode: Map<string, NodeState> }) {
  const running = [...byNode.entries()].filter(([, s]) => s.status === "running");
  const waiting = [...byNode.entries()].filter(([, s]) => s.status === "waiting");
  if (!running.length && !waiting.length) {
    return (
      <section className="panel now">
        <h2>Now</h2>
        <p className="muted">Nothing running right now (between nodes, or the run has ended).</p>
      </section>
    );
  }
  return (
    <section className="panel now">
      <h2>Now</h2>
      {waiting.map(([nodeId]) => (
        <p key={nodeId}>
          <span className="dot waiting" /> <strong>{nodeId}</strong> is waiting for YOUR decision — use the approval
          buttons below.
        </p>
      ))}
      {running.map(([nodeId, state]) => (
        <p key={nodeId}>
          <span className="dot running" /> <strong>{nodeId}</strong>
          {state.startedMs ? <span className="muted"> · running {fmtAgo(state.startedMs)}</span> : null}
          {state.iteration > 0 ? <span className="muted"> · loop iteration {state.iteration + 1}</span> : null}
          <br />
          <span className="muted">{NODE_EXPLAINS[nodeId] ?? ""}</span>
        </p>
      ))}
    </section>
  );
}

function ApprovalsPanel({ runId }: { runId: string }) {
  const approvals = useGatewayApprovals();
  const actions = useGatewayActions();
  const list = Array.isArray(approvals.data) ? approvals.data.filter((entry: any) => entry?.runId === runId) : [];
  if (!list.length) return null;
  return (
    <section className="panel warn">
      <h2>Pending approvals — the run is paused on you</h2>
      {list.map((entry: any) => (
        <div className="approval" key={entry.nodeId + ":" + entry.iteration}>
          <div className="approvaltext">
            <div>
              <strong>{String(entry.requestTitle ?? entry.nodeId)}</strong>
            </div>
            {entry.requestSummary ? <pre className="summarypre">{String(entry.requestSummary)}</pre> : null}
          </div>
          <button
            className="button ok"
            onClick={() =>
              actions.submitApproval({
                runId,
                nodeId: entry.nodeId,
                iteration: entry.iteration,
                decision: { approved: true },
              })
            }
          >
            Approve
          </button>
          <button
            className="button danger"
            onClick={() =>
              actions.submitApproval({
                runId,
                nodeId: entry.nodeId,
                iteration: entry.iteration,
                decision: { approved: false },
              })
            }
          >
            Deny
          </button>
        </div>
      ))}
    </section>
  );
}

/** Loop nodes write one row per iteration; poll a fixed set and take the last non-empty. */
function useLatestRow(runId: string, nodeId: string): Record<string, unknown> | null {
  const i0 = useGatewayNodeOutput({ runId, nodeId, iteration: 0 });
  const i1 = useGatewayNodeOutput({ runId, nodeId, iteration: 1 });
  const i2 = useGatewayNodeOutput({ runId, nodeId, iteration: 2 });
  const i3 = useGatewayNodeOutput({ runId, nodeId, iteration: 3 });
  const i4 = useGatewayNodeOutput({ runId, nodeId, iteration: 4 });
  const rows = [i0, i1, i2, i3, i4]
    .map((out) => unwrapRow(out.data))
    .filter((row): row is Record<string, unknown> => !!row && Object.keys(row).length > 0);
  return rows.length ? rows[rows.length - 1] : null;
}

function DocsPanel({ runId }: { runId: string }) {
  const row = useLatestRow(runId, "docs-improve");
  const check = useLatestRow(runId, "docs-check");
  if (!row && !check) return null;
  const hasVerdict = check !== null && check.passed !== undefined && check.passed !== null;
  return (
    <section className="panel">
      <h2>
        Docs phase (Fable)
        {hasVerdict ? (
          <span className={isTrue(check!.passed) ? "tag ok" : "tag bad"}>
            {isTrue(check!.passed) ? "passed" : "failed — retrying"}
          </span>
        ) : (
          <span className="tag">check not run yet</span>
        )}
      </h2>
      {row?.summary !== undefined ? (
        <p>{String(row.summary)}</p>
      ) : (
        <p className="muted">Fable has not returned its docs summary yet.</p>
      )}
      {hasVerdict ? <p className="muted">{String(check!.detail ?? "")}</p> : null}
    </section>
  );
}

function FableReviewPanel({ runId }: { runId: string }) {
  const row = useLatestRow(runId, "fable-review");
  if (!row) return null;
  const lgtm = isTrue(row.lgtm);
  return (
    <section className="panel">
      <h2>
        Fable final review <span className={lgtm ? "tag ok" : "tag bad"}>{lgtm ? "LGTM" : "findings open"}</span>
      </h2>
      <pre className="summarypre">{String(row.findings ?? "")}</pre>
    </section>
  );
}

function SummaryPanel({ runId }: { runId: string }) {
  const row = useLatestRow(runId, "summary");
  if (!row || row.headline === undefined) return null;
  return (
    <section className="panel">
      <h2>Final summary</h2>
      <p>
        <strong>{String(row.headline)}</strong>
      </p>
      <p>{String(row.summary ?? "")}</p>
    </section>
  );
}

function EventsPanel({ lines }: { lines: EventLine[] }) {
  const recent = lines.slice(-14).reverse();
  if (!recent.length) return null;
  return (
    <section className="panel">
      <h2>Recent activity</h2>
      <table className="events">
        <tbody>
          {recent.map((line, index) => (
            <tr key={index}>
              <td className="mono muted">{line.ts ? fmtClock(line.ts) : ""}</td>
              <td className="mono">{line.nodeId}</td>
              <td className={"evtype " + line.type}>{line.type.replace(/^Node|^Task/, "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RunPicker() {
  const runs = useGatewayRuns({ filter: { limit: 25 } });
  const rows = Array.isArray(runs.data) ? runs.data.filter((run: any) => run?.workflowKey === WORKFLOW_KEY) : [];
  return (
    <div className="content">
      <section className="panel">
        <h2>Pick a microsandbox-finish run</h2>
        {rows.length === 0 && <p className="muted">No {WORKFLOW_KEY} runs found yet.</p>}
        <ul>
          {rows.map((run: any) => (
            <li key={run.runId}>
              <a href={"?runId=" + encodeURIComponent(run.runId)}>
                <span className="mono">{String(run.runId).slice(0, 12)}</span> {String(run.status ?? "")}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const PIPELINE: Array<{ label: string; nodeId: string }> = [
  { label: "prep", nodeId: "prep" },
  { label: "docs", nodeId: "docs-improve" },
  { label: "docs-check", nodeId: "docs-check" },
  { label: "fable-review", nodeId: "fable-review" },
  { label: "approve-integration", nodeId: "approve-integration" },
  { label: "integrate", nodeId: "integrate" },
  { label: "approve-deploy", nodeId: "approve-deploy" },
  { label: "deploy", nodeId: "deploy" },
  { label: "prod-proof", nodeId: "prod-proof" },
  { label: "issue-draft", nodeId: "issue-draft" },
  { label: "approve-file", nodeId: "approve-file-upstream" },
  { label: "issue-file", nodeId: "issue-file" },
  { label: "summary", nodeId: "summary" },
];

function Board({ runId, byNode }: { runId: string; byNode: Map<string, NodeState> }) {
  const docsRow = useLatestRow(runId, "docs-improve");
  const gates = extractGates(docsRow);
  return (
    <>
      <section className="panel">
        <h2>
          Pipeline <span className="muted">grey = not reached yet; nodes appear as earlier ones finish</span>
        </h2>
        <div className="stages wraprow">
          {PIPELINE.map((step) => (
            <Stage key={step.nodeId} label={step.label} state={byNode.get(step.nodeId)} />
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>
          Implementation phases <span className="muted">(Sol implements, then Sol reviews itself; loops up to 3×)</span>
        </h2>
        <div className="lanegrid">
          {PHASES.map((key) => {
            const impl = byNode.get("phase-" + key);
            const review = byNode.get("phase-" + key + "-review");
            return (
              <div className="lane" key={key}>
                <div className="lanehead" title={NODE_EXPLAINS["phase-" + key] ?? ""}>
                  {key}
                </div>
                <div className="stages">
                  <Stage label="implement" state={impl} />
                  <Stage label="self-review" state={review} />
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <section className="panel">
        <h2>
          Deterministic gates{" "}
          <span className="muted">(frozen by the docs phase; run mechanically, Sol fixes failures)</span>
        </h2>
        {gates.length === 0 ? (
          <p className="muted">Gates appear once the docs phase publishes them.</p>
        ) : (
          <div className="lanegrid">
            {gates.map((gate) => (
              <div className="lane" key={gate.gateKey}>
                <div className="lanehead mono" title={gate.command}>
                  {gate.gateKey}
                </div>
                <div className="stages">
                  <Stage label="fix" state={byNode.get("gate-" + gate.gateKey + "-fix")} />
                  <Stage label="gate" state={byNode.get("gate-" + gate.gateKey)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function App() {
  const runId = runIdFromUrl();
  const run = useGatewayRun(runId);
  const stream = useGatewayRunEvents(runId, { afterSeq: 0 });

  if (!runId) {
    return (
      <div className="shell">
        <style>{STYLES}</style>
        <header className="topbar">
          <h1>Microsandbox Finish</h1>
        </header>
        <RunPicker />
      </div>
    );
  }

  const status = String((run.data as any)?.status ?? "loading");
  const { byNode, lines } = buildNodeState(stream.events ?? []);
  const doneCount = [...byNode.values()].filter((value) => value.status === "done").length;
  const failedCount = [...byNode.values()].filter((value) => value.status === "failed").length;

  return (
    <div className="shell">
      <style>{STYLES}</style>
      <header className="topbar">
        <h1>Microsandbox Finish</h1>
        <span className={"badge " + status}>{status}</span>
        <span className="pill mono">{runId.slice(0, 16)}</span>
        <span className="spacer" />
        <span className="pill">
          {doneCount} done · {failedCount} failed
        </span>
        <span className="pill">{stream.streaming ? "live" : "idle"}</span>
      </header>
      <main className="content">
        <ApprovalsPanel runId={runId} />
        <NowRunning byNode={byNode} />
        <SummaryPanel runId={runId} />
        <FableReviewPanel runId={runId} />
        <DocsPanel runId={runId} />
        <Board runId={runId} byNode={byNode} />
        <EventsPanel lines={lines} />
      </main>
    </div>
  );
}

const STYLES = [
  ...sharedDarkThemeCss,
  ":root { --run:#60a5fa; }",
  ".shell{min-height:100vh;display:flex;flex-direction:column;}",
  ".topbar{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--border);flex-wrap:wrap;position:sticky;top:0;background:var(--bg);z-index:2;}",
  "h2{margin:0 0 8px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
  "h2 .muted{font-weight:400;font-size:11px;}",
  ".pill{font-size:12px;color:var(--muted);background:var(--panel);padding:3px 9px;border-radius:6px;border:1px solid var(--border);}",
  ".mono{font-family:ui-monospace,monospace;font-size:11px;}",
  ".spacer{flex:1;}",
  ".badge.running{color:var(--run);border-color:var(--run);}",
  ".badge.waiting-approval,.badge.paused{color:var(--warn);border-color:var(--warn);}",
  ".content{padding:20px;max-width:1200px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:14px;}",
  ".panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px;}",
  ".panel.warn{border-color:var(--warn);}",
  ".panel.now{border-color:var(--run);}",
  ".muted{color:var(--muted);}",
  ".tag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:5px;border:1px solid var(--border);color:var(--muted);}",
  ".tag.ok{color:var(--ok);border-color:var(--ok);}",
  ".tag.bad{color:var(--err);border-color:var(--err);}",
  ".lanegrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;}",
  ".lane{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 12px;}",
  ".lanehead{margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".stages{display:flex;gap:12px;flex-wrap:wrap;}",
  ".wraprow{row-gap:8px;}",
  ".stage{display:inline-flex;align-items:center;gap:5px;color:var(--muted);font-size:11px;}",
  ".dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#3a3a3f;flex:none;}",
  ".dot.running{background:var(--run);animation:pulse 1.2s ease-in-out infinite;}",
  ".dot.done{background:var(--ok);}",
  ".dot.failed{background:var(--err);}",
  ".dot.waiting{background:var(--warn);animation:pulse 1.2s ease-in-out infinite;}",
  ".dot.skipped{background:#6b7280;}",
  "@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}",
  ".approval{display:flex;align-items:flex-start;gap:10px;margin:6px 0;}",
  ".approvaltext{flex:1;min-width:0;}",
  ".summarypre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:11px;color:var(--muted);max-height:260px;overflow:auto;}",
  ".button{height:28px;padding:0 12px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer;font-weight:500;font:inherit;}",
  ".button.ok{background:var(--ok);color:#04210f;border-color:var(--ok);}",
  ".events{width:100%;border-collapse:collapse;}",
  ".events td{padding:2px 10px 2px 0;border-bottom:1px solid var(--border);font-size:11px;}",
  ".evtype{color:var(--muted);}",
  ".evtype.NodeFinished{color:var(--ok);}",
  ".evtype.NodeFailed,.evtype.NodeCancelled{color:var(--err);}",
  ".evtype.NodeStarted{color:var(--run);}",
  ".evtype.NodeWaitingApproval{color:var(--warn);}",
  "a{color:var(--run);text-decoration:none;}",
  "ul{margin:6px 0;padding-left:18px;}",
].join("\n");

createGatewayReactRoot(<App />);
