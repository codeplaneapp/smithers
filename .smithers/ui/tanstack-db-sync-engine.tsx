/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRunTree,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "tanstack-db-sync-engine";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : value == null ? undefined : String(value);
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
  if ("row" in value) return isRecord(value.row) ? value.row : null;
  return value;
}
/** Read a field by camelCase or snake_case (gateway rows are snake_case). */
function pick(row: Record<string, unknown>, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake];
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function shortId(id: string | undefined) {
  return id ? id.slice(0, 18) : "--";
}
function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "ok" || status === "finished") return "ok";
  if (status === "failed" || status === "cancelled") return "err";
  if (status === "waiting") return "warn";
  return "queued";
}
function statusDot(status: string | undefined) {
  if (status === "running") return "●";
  if (status === "ok") return "✓";
  if (status === "failed") return "✗";
  if (status === "waiting") return "⏸";
  if (status === "cancelled") return "⊘";
  return "○";
}

const STAGE_STEPS = ["impl", "review-codex", "review-sonnet", "verify", "matrix", "commit"] as const;

const MILESTONES = [
  { key: "m1", title: "M1 · REST /v1/api + SSE + txid (server)" },
  { key: "m2", title: "M2 · createSmithersCollections + local provider (breaking)" },
  { key: "m3", title: "M3 · Electric provider + txid matching" },
] as const;

const FINAL_STEPS = [
  { id: "integrate", label: "integrate" },
  { id: "final-review", label: "final review (Fable)" },
  { id: "final-fix", label: "final fix" },
  { id: "integrate-matrix", label: "matrix" },
  { id: "integrate-commit", label: "commit" },
  { id: "approve-land", label: "human approval" },
  { id: "land", label: "draft PR" },
] as const;

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); flex-wrap:wrap; }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); font-family:ui-monospace,monospace; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.ok { color:var(--ok); border-color:var(--ok); }",
  ".badge.err { color:var(--err); border-color:var(--err); }",
  ".badge.warn { color:var(--warn); border-color:var(--warn); }",
  ".badge.queued { color:var(--muted); }",
  ".main { display:grid; grid-template-columns:1fr 320px; flex:1; overflow:hidden; }",
  ".content { padding:20px; overflow:auto; }",
  ".panel { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:14px 16px; margin-bottom:14px; }",
  ".panel h2 { margin:0 0 10px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".steps { display:flex; gap:8px; flex-wrap:wrap; }",
  ".step { display:flex; align-items:center; gap:6px; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:6px 10px; font-size:12px; font-family:ui-monospace,monospace; }",
  ".step.running { border-color:var(--warn); box-shadow:0 0 8px rgba(251,191,36,0.25); }",
  ".step.ok { border-color:var(--ok); }",
  ".step.err { border-color:var(--err); }",
  ".step.warn { border-color:var(--warn); }",
  ".dot.running { color:var(--warn); animation:pulse 1.2s infinite; }",
  ".dot.ok { color:var(--ok); }",
  ".dot.err { color:var(--err); }",
  ".dot.warn { color:var(--warn); }",
  ".dot.queued { color:var(--muted); }",
  "@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }",
  ".summary { font-size:13px; margin:6px 0; }",
  ".meta { color:var(--muted); font-size:12px; font-family:ui-monospace,monospace; }",
  "table { width:100%; border-collapse:collapse; font-size:12px; }",
  "th,td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:top; }",
  "th { color:var(--muted); font-weight:600; text-transform:uppercase; font-size:10px; letter-spacing:0.04em; }",
  ".mono { font-family:ui-monospace,monospace; }",
  ".tag { font-size:10px; font-weight:600; text-transform:uppercase; padding:2px 6px; border-radius:4px; border:1px solid var(--border); }",
  ".tag.pass, .tag.yes { color:var(--ok); border-color:var(--ok); }",
  ".tag.fail, .tag.no { color:var(--err); border-color:var(--err); }",
  ".tag.skipped, .tag.pending { color:var(--warn); border-color:var(--warn); }",
  ".button { height:28px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { border-color:var(--err); color:var(--err); }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; display:flex; flex-direction:column; }",
  ".side-head { padding:10px 14px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--panel); }",
  ".event { padding:6px 14px; border-bottom:1px solid var(--border); font-size:11px; font-family:ui-monospace,monospace; color:var(--muted); word-break:break-word; }",
  ".event b { color:var(--text); font-weight:600; }",
  ".event .ev-ok { color:var(--ok); } .event .ev-err { color:var(--err); } .event .ev-run { color:var(--warn); }",
  ".chat { font-family:ui-monospace,monospace; font-size:11px; white-space:pre-wrap; word-break:break-word; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:10px; max-height:420px; overflow:auto; display:flex; flex-direction:column-reverse; }",
  ".chat .line { margin:0; } .chat .who { color:var(--primary); font-weight:600; } .chat .stderr { color:var(--err); }",
  ".empty { color:var(--muted); text-align:center; padding:32px 12px; }",
] .join("\n");

function StepChips({ prefix, statusOf }: { prefix: string; statusOf: (id: string) => string | undefined }) {
  return (
    <div className="steps">
      {STAGE_STEPS.map((s) => {
        const id = `${prefix}-${s}`;
        const st = statusOf(id);
        return (
          <span key={id} className={"step " + statusClass(st)} title={id}>
            <span className={"dot " + statusClass(st)}>{statusDot(st)}</span> {s}
          </span>
        );
      })}
    </div>
  );
}

function MatrixRow({ label, data }: { label: string; data: unknown }) {
  const row = rowOf(data);
  if (!row) return null;
  const legs = ["sqlite", "pglite", "postgres", "electric"] as const;
  return (
    <tr>
      <td className="mono">{label}</td>
      {legs.map((l) => {
        const v = asString(row[l]) ?? "—";
        return (
          <td key={l}>
            <span className={"tag " + v}>{v}</span>
          </td>
        );
      })}
    </tr>
  );
}

function VerifyPanel({ label, data }: { label: string; data: unknown }) {
  const row = rowOf(data);
  if (!row) return null;
  const criteria = asArray(pick(row, "acceptanceCriteria", "acceptance_criteria")).filter(isRecord);
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="meta">
        <b>{label}</b> · status {asString(row.status) ?? "?"} · typecheck {asString(row.typecheck) ?? "?"} · tests{" "}
        {asString(pick(row, "unitTests", "unit_tests")) ?? "?"} · both backends{" "}
        {String(pick(row, "bothBackendsRun", "both_backends_run") ?? "?")}
      </div>
      {criteria.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Status</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {criteria.map((c, i) => (
              <tr key={i}>
                <td>{asString(c.criterion)}</td>
                <td>
                  <span className={"tag " + (asString(c.status) ?? "")}>{asString(c.status) ?? "?"}</span>
                </td>
                <td className="mono" style={{ fontSize: 11 }}>{asString(c.evidence)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const wfRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const runId = selectedRunId ?? runIdFromUrl() ?? wfRuns[0]?.runId;

  const runDetail = useGatewayRun(runId);
  const tree = useGatewayRunTree(runId);
  const events = useGatewayRunEvents(runId, { afterSeq: 0, maxEvents: 2000 });
  const approvals = useGatewayApprovals({ runId });
  const actions = useGatewayActions();

  // Per-node lifecycle: the devtools snapshot carries none while a run is live,
  // so fold NodeStarted/NodeFinished/NodeFailed frames over the tree statuses.
  const nodeStatus = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of tree.nodes) {
      const rec = n as unknown as Record<string, unknown>;
      const id = asString(rec.id) ?? "";
      const st = asString(rec.status);
      const bare = id.split("#")[0].split("::")[0];
      if (bare && st && st !== "queued") map.set(bare, st);
    }
    for (const f of (events.events ?? []) as Array<Record<string, unknown>>) {
      const name = asString(f.event) ?? "";
      const payload = isRecord(f.payload) ? f.payload : {};
      const nid = asString(pick(payload, "nodeId", "node_id"));
      if (!nid) continue;
      if (name === "NodeStarted") map.set(nid, "running");
      else if (name === "NodeFinished") map.set(nid, "ok");
      else if (name === "NodeFailed") map.set(nid, "failed");
    }
    return map;
  }, [tree.nodes, events.events]);
  const statusOf = (id: string) => nodeStatus.get(id);

  // Live agent chat: NodeOutput frames carry {nodeId, stream, text}.
  const chatLines = useMemo(() => {
    const lines: Array<{ who: string; stream: string; text: string; seq: number }> = [];
    for (const f of (events.events ?? []) as Array<Record<string, unknown>>) {
      if (asString(f.event) !== "NodeOutput") continue;
      let payload: Record<string, unknown> = isRecord(f.payload) ? f.payload : {};
      if (typeof f.payload === "string") {
        try {
          const parsed = JSON.parse(f.payload);
          if (isRecord(parsed)) payload = parsed;
        } catch {}
      }
      const text = asString(payload.text) ?? "";
      if (!text.trim()) continue;
      lines.push({
        who: asString(pick(payload, "nodeId", "node_id")) ?? "?",
        stream: asString(payload.stream) ?? "stdout",
        text,
        seq: Number(f.seq ?? 0),
      });
    }
    return lines.slice(-300);
  }, [events.events]);

  const designOut = useGatewayNodeOutput({ runId, nodeId: "design", iteration: 0 });
  const m1Verify = useGatewayNodeOutput({ runId, nodeId: "m1-verify", iteration: 0 });
  const m2Verify = useGatewayNodeOutput({ runId, nodeId: "m2-verify", iteration: 0 });
  const m3Verify = useGatewayNodeOutput({ runId, nodeId: "m3-verify", iteration: 0 });
  const m1Matrix = useGatewayNodeOutput({ runId, nodeId: "m1-matrix", iteration: 0 });
  const m2Matrix = useGatewayNodeOutput({ runId, nodeId: "m2-matrix", iteration: 0 });
  const m3Matrix = useGatewayNodeOutput({ runId, nodeId: "m3-matrix", iteration: 0 });
  const integrateMatrix = useGatewayNodeOutput({ runId, nodeId: "integrate-matrix", iteration: 0 });
  const integrateOut = useGatewayNodeOutput({ runId, nodeId: "integrate", iteration: 0 });
  const finalReviewOut = useGatewayNodeOutput({ runId, nodeId: "final-review", iteration: 0 });
  const landOut = useGatewayNodeOutput({ runId, nodeId: "land", iteration: 0 });

  const design = rowOf(designOut.data);
  const integrateRow = rowOf(integrateOut.data);
  const finalReview = rowOf(finalReviewOut.data);
  const land = rowOf(landOut.data);

  const runRow = rowOf(runDetail.data as unknown) ?? undefined;
  const runStatus = asString(runRow?.status) ?? asString((wfRuns.find((r) => r.runId === runId) ?? {}).status);

  const pendingApprovals = useMemo(
    () => asArray(approvals.data).filter(isRecord).filter((a) => a.decision == null && pick(a, "decidedAtMs", "decided_at_ms") == null),
    [approvals.data],
  );

  async function decide(nodeId: string, approved: boolean) {
    if (!runId) return;
    setBusy(true);
    try {
      await actions.submitApproval({ runId, nodeId, approved, decidedBy: "ui" });
      await approvals.refetch?.();
    } finally {
      setBusy(false);
    }
  }

  const recentEvents = useMemo(() => {
    const list = (events.events ?? []) as Array<Record<string, unknown>>;
    // NodeOutput lines live in the chat panel; keep the ticker for lifecycle events.
    return list.filter((f) => asString(f.event) !== "NodeOutput").slice(-80).reverse();
  }, [events.events]);

  return (
    <main className="shell" data-testid="tsync-ui">
      <style>{styles}</style>
      <header className="topbar">
        <div className="title-group">
          <h1>TanStack DB Sync Engine</h1>
          <span className="pill" data-testid="tsync-runid">{shortId(runId)}</span>
          <span className={"badge " + statusClass(runStatus)} data-testid="tsync-status">{runStatus ?? tree.status ?? "?"}</span>
          <span className="pill">{(events.events ?? []).length} events</span>
        </div>
        <div>
          {wfRuns.length > 1 ? (
            <select
              className="button"
              value={runId ?? ""}
              onChange={(e) => setSelectedRunId(e.currentTarget.value || undefined)}
            >
              {wfRuns.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId} ({r.status ?? "?"})
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </header>

      <div className="main">
        <div className="content">
          {pendingApprovals.length > 0 ? (
            <section className="panel" style={{ borderColor: "var(--warn)" }} data-testid="tsync-approvals">
              <h2>⏸ Waiting on you</h2>
              {pendingApprovals.map((a, i) => {
                const nodeId = asString(pick(a, "nodeId", "node_id")) ?? "";
                return (
                  <div key={nodeId + ":" + i} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 240 }}>
                      <div className="summary">{asString(a.title) ?? nodeId}</div>
                      <div className="meta" style={{ whiteSpace: "pre-wrap" }}>{asString(a.summary) ?? ""}</div>
                    </div>
                    <button className="button primary" disabled={busy} onClick={() => void decide(nodeId, true)}>Approve</button>
                    <button className="button danger" disabled={busy} onClick={() => void decide(nodeId, false)}>Deny</button>
                  </div>
                );
              })}
            </section>
          ) : null}

          <section className="panel" data-testid="tsync-design">
            <h2>
              <span className={"dot " + statusClass(statusOf("design"))}>{statusDot(statusOf("design"))}</span> Design freeze (Fable)
            </h2>
            {design ? (
              <>
                <div className="summary">{asString(design.summary)}</div>
                <div className="meta">
                  routes: {asArray(pick(design, "restRouteCatalog", "rest_route_catalog")).length} · collections:{" "}
                  {asArray(pick(design, "collectionCatalog", "collection_catalog")).length} · retirements:{" "}
                  {asArray(pick(design, "retirementList", "retirement_list")).length}
                </div>
                {asString(design.risks) ? <div className="meta">risks: {asString(design.risks)}</div> : null}
              </>
            ) : (
              <div className="meta">Reading the spec and freezing contracts…</div>
            )}
          </section>

          {MILESTONES.map((m) => (
            <section className="panel" key={m.key} data-testid={"tsync-" + m.key}>
              <h2>{m.title}</h2>
              <StepChips prefix={m.key} statusOf={statusOf} />
              <VerifyPanel label="verify" data={m.key === "m1" ? m1Verify.data : m.key === "m2" ? m2Verify.data : m3Verify.data} />
            </section>
          ))}

          <section className="panel" data-testid="tsync-final">
            <h2>Integrate &amp; land</h2>
            <div className="steps">
              {FINAL_STEPS.map((s) => {
                const st = statusOf(s.id);
                return (
                  <span key={s.id} className={"step " + statusClass(st)} title={s.id}>
                    <span className={"dot " + statusClass(st)}>{statusDot(st)}</span> {s.label}
                  </span>
                );
              })}
            </div>
            {integrateRow ? (
              <div className="meta" style={{ marginTop: 8 }}>
                integrate: green={String(integrateRow.green)} · typecheck={asString(integrateRow.typecheck)} · docs gates=
                {String(pick(integrateRow, "docsGatesGreen", "docs_gates_green"))}
              </div>
            ) : null}
            {finalReview ? (
              <div className="meta">
                Fable final review: {finalReview.approved === true || finalReview.approved === 1 ? "APPROVED" : "changes requested"} —{" "}
                {asString(finalReview.feedback)?.slice(0, 300)}
              </div>
            ) : null}
            {land ? (
              <div className="summary">
                {asString(pick(land, "prUrl", "pr_url")) ? (
                  <a href={asString(pick(land, "prUrl", "pr_url"))} target="_blank" rel="noreferrer" style={{ color: "var(--primary)" }}>
                    Draft PR #{asString(pick(land, "prNumber", "pr_number"))}
                  </a>
                ) : (
                  asString(land.summary)
                )}
              </div>
            ) : null}
          </section>

          <section className="panel" data-testid="tsync-chat">
            <h2>Live agent chat</h2>
            {chatLines.length === 0 ? (
              <div className="meta">No agent output yet…</div>
            ) : (
              <div className="chat">
                {[...chatLines].reverse().map((l, i) => (
                  <p className="line" key={l.seq + ":" + i}>
                    <span className="who">[{l.who}]</span>{" "}
                    <span className={l.stream === "stderr" ? "stderr" : undefined}>{l.text}</span>
                  </p>
                ))}
              </div>
            )}
          </section>

          <section className="panel" data-testid="tsync-matrix">
            <h2>Backend test matrix</h2>
            <table>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>sqlite</th>
                  <th>pglite</th>
                  <th>postgres</th>
                  <th>electric</th>
                </tr>
              </thead>
              <tbody>
                <MatrixRow label="m1" data={m1Matrix.data} />
                <MatrixRow label="m2" data={m2Matrix.data} />
                <MatrixRow label="m3" data={m3Matrix.data} />
                <MatrixRow label="integrate" data={integrateMatrix.data} />
              </tbody>
            </table>
          </section>
        </div>

        <aside className="sidebar">
          <div className="side-head">Live events</div>
          {recentEvents.length === 0 ? <div className="empty">Waiting for events…</div> : null}
          {recentEvents.map((e, i) => {
            const name = asString(e.event) ?? "?";
            const payload = isRecord(e.payload) ? e.payload : {};
            const nid = asString(pick(payload, "nodeId", "node_id")) ?? "";
            const cls = name.endsWith("Failed") ? "ev-err" : name.endsWith("Finished") ? "ev-ok" : name.endsWith("Started") ? "ev-run" : "";
            const detail =
              asString(payload.message) ?? asString(payload.summary) ?? asString(payload.state) ?? asString(payload.status) ?? "";
            return (
              <div className="event" key={String(e.seq ?? i)}>
                <b className={cls}>{name}</b> {nid ? <span className="mono">{nid}</span> : null} {detail.slice(0, 140)}
              </div>
            );
          })}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
