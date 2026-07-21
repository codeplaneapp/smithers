/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayRpc,
  useGatewayRun,
  useGatewayRunDiff,
} from "smithers-orchestrator/gateway-react";
import {
  NodeChatStream,
  RunEventLog,
  WorkflowUiShell,
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

function runIdFromUrl() {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
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

function elapsedLabel(startedAtMs: number | undefined, finishedAtMs: number | undefined, now: number) {
  if (!startedAtMs) return "Not started";
  const seconds = Math.max(0, Math.floor(((finishedAtMs ?? now) - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
  const chain = config.oneshot && typeof config.oneshot === "object" && "chain" in config.oneshot
    ? (config.oneshot as { chain?: OneshotChainEntry[] }).chain
    : undefined;
  const primary = Array.isArray(chain) ? chain[0] : undefined;
  const model = [primary?.engine, primary?.model].filter(Boolean).join(" · ") || "Auto chain";
  const hasReview = Boolean(config.oneshot && typeof config.oneshot === "object" && "review" in config.oneshot && (config.oneshot as { review?: unknown }).review);

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
    <WorkflowUiShell title="Oneshot" meta={<StatusPill status={status} />} actions={controls}>
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
