/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeEvents,
  useGatewayRpc,
  useGatewayRun,
  useGatewayRunDiff,
} from "smithers-orchestrator/gateway-react";
import {
  NodeChatStream,
  RunEventLog,
  WorkflowUiShell,
  theme,
} from "smithers-orchestrator/gateway-ui";
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  KpiStat,
  SmithersUiStyles,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  normalizeStatus,
} from "smithers-orchestrator/ui";
import { PierreDiffView } from "smithers-orchestrator/ui/adapters/pierre-diff-view";

type HijackCandidate = { nodeId?: string; engine?: string };
type OneshotChainEntry = { engine?: string; model?: string };
type OneshotStatus = { text: string; engine?: string; timestampMs?: number };

const STATUS_NODE_ID = "status";

function runIdFromUrl() {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function parsePayload(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function useHijackCandidates(runId: string | undefined) {
  const [candidates, setCandidates] = useState<HijackCandidate[]>([]);
  useEffect(() => {
    if (!runId) return setCandidates([]);
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/hijack-candidates`, { signal: controller.signal });
        if (!response.ok) return;
        const body = await response.json() as { candidates?: HijackCandidate[]; data?: { candidates?: HijackCandidate[] } };
        if (!controller.signal.aborted) setCandidates(body.data?.candidates ?? body.candidates ?? []);
      } catch { }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1500);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [runId]);
  return candidates;
}

function useOneshotStatus(runId: string | undefined): { status?: OneshotStatus; loading: boolean } {
  const { events, loading } = useGatewayNodeEvents(runId, STATUS_NODE_ID, { maxEvents: 50, pollIntervalMs: 4000 });
  return useMemo(() => {
    let status: OneshotStatus | undefined;
    for (const frame of events) {
      if (frame.event !== "NodeOutput") continue;
      const payload = parsePayload(frame.payload);
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!text) continue;
      status = {
        text,
        engine: typeof payload?.engine === "string" ? payload.engine : undefined,
        timestampMs: typeof payload?.timestampMs === "number" ? payload.timestampMs : undefined,
      };
    }
    return { status, loading };
  }, [events, loading]);
}

function elapsedLabel(startedAtMs: number | undefined, finishedAtMs: number | undefined, now: number) {
  if (!startedAtMs) return "Not started";
  const seconds = Math.max(0, Math.floor(((finishedAtMs ?? now) - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function agoLabel(timestampMs: number | undefined, now: number) {
  if (!timestampMs) return undefined;
  const seconds = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

const STATUS_STYLES = `
@keyframes oneshot-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.75); } }
.oneshot-status-dot { width: 8px; height: 8px; border-radius: 9999px; flex: none; background: ${theme.success}; }
.oneshot-status-dot[data-live="true"] { animation: oneshot-pulse 1.6s ease-in-out infinite; }
.oneshot-status-text { transition: opacity 200ms ease; }
`;

function LunaStatusCard({ runId, running, now }: { runId: string | undefined; running: boolean; now: number }) {
  const { status, loading } = useOneshotStatus(runId);
  if (!status && !running && !loading) return null;
  const label = status?.engine ? `Luna live status · ${status.engine}` : "Luna live status";
  const ago = agoLabel(status?.timestampMs, now);
  return (
    <Card>
      <CardContent style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 16 }}>
        <span className="oneshot-status-dot" data-live={running} aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: theme.textDim }}>{label}</div>
          <div className="oneshot-status-text" key={status?.text ?? "empty"} style={{ fontSize: 14, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {status?.text ?? (running ? "Listening for agent activity…" : "No status recorded")}
          </div>
        </div>
        {ago ? <span style={{ fontSize: 12, color: theme.textDim, flex: "none" }}>{ago}</span> : null}
      </CardContent>
    </Card>
  );
}

function GoalCard({ goal, chain }: { goal?: string; chain?: OneshotChainEntry[] }) {
  if (!goal && (!chain || chain.length === 0)) return null;
  return (
    <Card>
      <CardContent style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 16 }}>
        {goal ? (
          <div style={{
            fontSize: 13,
            color: theme.text,
            lineHeight: 1.5,
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 2,
            overflow: "hidden",
          }}>{goal}</div>
        ) : null}
        {chain && chain.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {chain.map((entry, index) => {
              const primary = index === 0;
              return (
                <span
                  key={`${entry.engine}-${entry.model}-${index}`}
                  style={{
                    fontSize: 11,
                    fontFamily: theme.fontMono,
                    padding: "3px 8px",
                    borderRadius: 9999,
                    border: `1px solid ${primary ? theme.accentBorder : theme.neutralBorder}`,
                    background: primary ? theme.accentSoft : theme.neutralSoft,
                    color: primary ? theme.accent : theme.textDim,
                  }}
                >{[entry.engine, entry.model].filter(Boolean).join(" · ")}</span>
              );
            })}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function App() {
  const runId = runIdFromUrl();
  const runState = useGatewayRun(runId);
  const diffState = useGatewayRunDiff({ runId });
  const actions = useGatewayActions();
  const candidates = useHijackCandidates(runId);
  const [now, setNow] = useState(Date.now());
  const [pauseRequested, setPauseRequested] = useState(false);
  const pause = useGatewayRpc("pauseRun", { runId: runId ?? "" }, { enabled: Boolean(runId && pauseRequested) });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (pause.data || pause.error) setPauseRequested(false);
  }, [pause.data, pause.error]);

  const run = runState.data;
  const status = normalizeStatus(typeof run?.status === "string" ? run.status : "pending");
  const diff = diffState.data;
  const oversized = diff && "status" in diff && diff.status === "oversized";
  const patch = useMemo(() => diff && "patches" in diff ? diff.patches.map((item) => item.diff).join("\n") : "", [diff]);
  const filesChanged = diff && "patches" in diff ? diff.patches.length : 0;
  const config = useMemo(() => {
    try { return typeof run?.configJson === "string" ? JSON.parse(run.configJson) as Record<string, unknown> : {}; }
    catch { return {}; }
  }, [run?.configJson]);
  const oneshot = config.oneshot && typeof config.oneshot === "object" ? config.oneshot as { chain?: OneshotChainEntry[]; goal?: string; review?: unknown } : undefined;
  const chain = Array.isArray(oneshot?.chain) ? oneshot.chain : undefined;
  const goal = typeof oneshot?.goal === "string" && oneshot.goal.trim() ? oneshot.goal : undefined;
  const primary = chain?.[0];
  const model = [primary?.engine, primary?.model].filter(Boolean).join(" · ") || "Auto chain";
  const hasReview = Boolean(oneshot?.review);
  const running = status === "running";

  const controls = <>
    <Button variant="outline" onClick={() => runId && actions.resumeRun({ runId })} disabled={!runId}>Resume</Button>
    <Button variant="outline" onClick={() => setPauseRequested(true)} disabled={!runId || pauseRequested}>Pause</Button>
    <Button variant="destructive" onClick={() => runId && actions.cancelRun({ runId })} disabled={!runId}>Cancel</Button>
  </>;

  if (!runId) {
    return <><SmithersUiStyles withTheme /><WorkflowUiShell title="Oneshot" actions={controls}><EmptyState title="No run selected" description="Open this UI with a oneshot run ID." /></WorkflowUiShell></>;
  }

  return <>
    <SmithersUiStyles withTheme />
    <style>{STATUS_STYLES}</style>
    <WorkflowUiShell title="Oneshot" meta={<StatusPill status={status} />} actions={controls}>
      <GoalCard goal={goal} chain={chain} />
      <Card>
        <CardContent style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, paddingTop: 16 }}>
          <KpiStat label="Status" value={status} />
          <KpiStat label="Engine / model" value={model} />
          <KpiStat label="Elapsed" value={elapsedLabel(
            typeof run?.startedAtMs === "number" ? run.startedAtMs : undefined,
            typeof run?.finishedAtMs === "number" ? run.finishedAtMs : undefined,
            now,
          )} />
          <KpiStat label="Files changed" value={filesChanged} />
        </CardContent>
      </Card>
      <LunaStatusCard runId={runId} running={running} now={now} />
      <Tabs defaultValue="chat">
        <TabsList>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="diff" count={filesChanged}>Diff</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="chat">
          <NodeChatStream runId={runId} nodeId="implement" title="Implement" height={420} />
          {hasReview ? <NodeChatStream runId={runId} nodeId="review" title="Review" height={320} /> : null}
        </TabsContent>
        <TabsContent value="diff">
          {oversized
            ? <EmptyState title="Diff is too large for the browser" description={`Run smithers diff ${runId} to inspect it in the terminal.`} />
            : diffState.error
              ? <EmptyState title="Diff unavailable" description={diffState.error.message} />
              : <PierreDiffView patch={patch} emptyLabel="No finished diff is available yet." />}
        </TabsContent>
        <TabsContent value="events"><RunEventLog runId={runId} style={{ height: 420 }} /></TabsContent>
      </Tabs>
      <Card>
        <CardContent style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 16 }}>
          {candidates.length > 0
            ? <Button onClick={() => navigator.clipboard.writeText(`smithers hijack ${runId}`)}>Copy hijack command</Button>
            : <EmptyState title="Hijack not ready" description="The command appears when an agent session is recorded." />}
        </CardContent>
      </Card>
    </WorkflowUiShell>
  </>;
}

createGatewayReactRoot(<App />);
