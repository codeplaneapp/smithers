/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { useGatewayNodeOutput, useGatewayRuns, useGatewayRunTree } from "smithers-orchestrator/gateway-react";
import { ConnectionBadge, RunEventLog, RunTree, StatusPill, WorkflowUiShell, theme } from "smithers-orchestrator/gateway-ui";

const WORKFLOW = "break-smithers";

// The loop's per-round node ids (see .smithers/workflows/break-smithers.tsx).
const ROUND_NODES = ["clock", "run-haiku", "break", "author", "wire", "fix", "commit"] as const;

type NodeLite = { id: string; iteration?: number; status: string };

function statusOf(nodes: readonly NodeLite[], id: string, iteration: number): string {
  return nodes.find((n) => n.id === id && (n.iteration ?? 0) === iteration)?.status ?? "queued";
}

function fmtRemaining(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "deadline reached";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
}

// getNodeOutput returns { status, row: {...} }; the task's fields live under .row.
function rowOf(state: { data?: Record<string, unknown> }): Record<string, unknown> | undefined {
  const d = state?.data;
  if (d && typeof d === "object" && "row" in d) return (d as { row?: Record<string, unknown> }).row;
  return d;
}

const SEV_COLOR: Record<string, string> = { high: "#e5484d", medium: "#f5a623", low: "#3aa675" };
const KIND_COLOR: Record<string, string> = { docs: "#5b8def", code: "#a074e8", "eval-only": "#8a8f98" };

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 999,
        color: "#fff",
        background: color,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
      <span style={{ fontSize: 11, color: theme.textDim ?? "#8a8f98", minWidth: 70, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontSize: 13, color: theme.text ?? "#e6e6e6" }}>{children}</span>
    </div>
  );
}

/** One completed/active loop round: the haiku suite result, the friction Opus
 *  found, the eval it authored, and the local commit. Refetches whenever any of
 *  its node statuses change (the `sig` prop), so it fills in live as the round runs. */
function RoundCard({ runId, iteration, sig, active }: { runId: string; iteration: number; sig: string; active: boolean }) {
  const evalRun = useGatewayNodeOutput({ runId, nodeId: "run-haiku", iteration });
  const friction = useGatewayNodeOutput({ runId, nodeId: "break", iteration });
  const authored = useGatewayNodeOutput({ runId, nodeId: "author", iteration });
  const committed = useGatewayNodeOutput({ runId, nodeId: "commit", iteration });

  useEffect(() => {
    void evalRun.refetch?.();
    void friction.refetch?.();
    void authored.refetch?.();
    void committed.refetch?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const e = rowOf(evalRun) as { suite?: string; ok?: boolean; exitCode?: number } | undefined;
  const f = rowOf(friction) as { title?: string; area?: string; severity?: string; kind?: string; whatWasBad?: string } | undefined;
  const a = rowOf(authored) as { id?: string; verify?: string; tier?: string } | undefined;
  const c = rowOf(committed) as { committed?: boolean; message?: string; note?: string } | undefined;

  return (
    <div
      style={{
        border: `1px solid ${active ? theme.accent ?? "#5b8def" : theme.border ?? "#2a2d34"}`,
        borderRadius: 10,
        padding: 14,
        background: theme.panel ?? "#16181d",
        boxShadow: active ? `0 0 0 1px ${theme.accent ?? "#5b8def"}33` : "none",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: theme.text ?? "#e6e6e6" }}>Round {iteration}</span>
        {active ? <Badge text="live" color="#5b8def" /> : null}
        {e?.suite ? <span style={{ fontSize: 12, color: theme.textDim ?? "#8a8f98" }}>suite: {e.suite}</span> : null}
        {e ? <Badge text={e.ok ? "evals ok" : `evals exit ${e.exitCode}`} color={e.ok ? "#3aa675" : "#e5484d"} /> : null}
      </div>

      {f ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: theme.text ?? "#e6e6e6" }}>🔨 {f.title}</span>
            {f.severity ? <Badge text={f.severity} color={SEV_COLOR[f.severity] ?? "#8a8f98"} /> : null}
            {f.kind ? <Badge text={f.kind} color={KIND_COLOR[f.kind] ?? "#8a8f98"} /> : null}
            {f.area ? <span style={{ fontSize: 12, color: theme.textDim ?? "#8a8f98" }}>{f.area}</span> : null}
          </div>
          {f.whatWasBad ? <div style={{ fontSize: 12, color: theme.textDim ?? "#9aa0a6", lineHeight: 1.5 }}>{f.whatWasBad}</div> : null}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: theme.textDim ?? "#8a8f98" }}>· breaking smithers…</div>
      )}

      {a?.id ? (
        <Field label="eval">
          <code style={{ background: "#00000033", padding: "1px 6px", borderRadius: 4 }}>{a.id}</code>
          {a.verify ? <span style={{ marginLeft: 8, fontSize: 12, color: theme.textDim ?? "#8a8f98" }}>verify: {a.verify} · {a.tier}</span> : null}
        </Field>
      ) : null}

      {c ? (
        <Field label="commit">
          {c.committed ? (
            <span style={{ color: "#3aa675" }}>✓ {c.message || c.note}</span>
          ) : (
            <span style={{ color: theme.textDim ?? "#8a8f98" }}>— {c.note}</span>
          )}
        </Field>
      ) : null}
    </div>
  );
}

function App() {
  const runsRaw = useGatewayRuns({ filter: { workflow: WORKFLOW, limit: 10 } });
  const runs = (runsRaw.data ?? []) as Array<{ runId: string; status?: string; createdAtMs?: number }>;
  // Pin to the run the URL names (smithers ui appends ?runId=…); fall back to newest.
  const urlRunId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("runId") ?? undefined : undefined;
  const runId = urlRunId ?? runs[0]?.runId;

  const { nodes, status } = useGatewayRunTree(runId);
  const nodesLite = nodes as unknown as NodeLite[];

  const maxRound = useMemo(
    () => nodesLite.reduce((m, n) => Math.max(m, n.iteration ?? 0), 0),
    [nodesLite],
  );

  const running = nodesLite.find((n) => n.status === "running");

  // Live deadline from the most recent clock output.
  const clock = useGatewayNodeOutput({ runId, nodeId: "clock", iteration: maxRound });
  const clockData = rowOf(clock) as { deadlineIso?: string; round?: number } | undefined;
  const deadlineMs = clockData?.deadlineIso ? Date.parse(clockData.deadlineIso) : Number.NaN;

  // 1s tick for the countdown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // Refresh the clock output whenever the round advances.
  useEffect(() => {
    void clock.refetch?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxRound]);

  const rounds = useMemo(() => {
    const arr: number[] = [];
    for (let i = maxRound; i >= 0; i -= 1) arr.push(i);
    return arr;
  }, [maxRound]);

  const sigFor = (iteration: number) => ROUND_NODES.map((id) => statusOf(nodesLite, id, iteration)).join(",");

  return (
    <WorkflowUiShell
      title="Break Smithers · EDD loop"
      meta={
        <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span className="pill">round {maxRound}</span>
          <span className="pill" style={{ fontVariantNumeric: "tabular-nums" }}>
            ⏳ {fmtRemaining(deadlineMs - now)}
          </span>
          {running ? <span className="pill">▶ {running.id}</span> : null}
        </span>
      }
      actions={
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusPill status={status} />
          <ConnectionBadge className="chip" />
        </span>
      }
    >
      {!runId ? (
        <section className="card">
          <div style={{ padding: 24, textAlign: "center", color: theme.textDim ?? "#8a8f98" }}>
            No <code>break-smithers</code> run yet. Launch one:
            <pre style={{ marginTop: 8, fontSize: 12 }}>
              {`smithers up .smithers/workflows/break-smithers.tsx -d --input '{"deadlineIso":"2026-07-06T22:00:00-04:00"}'`}
            </pre>
          </div>
        </section>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
          {/* Left: the round-by-round EDD feed. */}
          <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: theme.textDim ?? "#8a8f98", fontFamily: "monospace" }}>{runId}</div>
            {rounds.map((i) => (
              <RoundCard key={i} runId={runId} iteration={i} sig={sigFor(i)} active={i === maxRound && status === "running"} />
            ))}
          </section>

          {/* Right: live low-level views. */}
          <section style={{ display: "flex", flexDirection: "column", gap: 12, position: "sticky", top: 12 }}>
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textDim ?? "#8a8f98", marginBottom: 6 }}>Run tree</div>
              <RunTree runId={runId} style={{ maxHeight: 320 }} />
            </div>
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textDim ?? "#8a8f98", marginBottom: 6 }}>Live events</div>
              <RunEventLog runId={runId} style={{ maxHeight: 360 }} />
            </div>
          </section>
        </div>
      )}
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
