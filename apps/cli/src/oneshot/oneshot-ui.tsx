/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeEvents,
  useGatewayRpc,
  useGatewayRun,
  useGatewayRunDiff,
  useGatewayRunEvents,
} from "smithers-orchestrator/gateway-react";
import { NodeChatStream, RunEventLog, WorkflowUiShell, theme } from "smithers-orchestrator/gateway-ui";
import {
  Button,
  Card,
  CardContent,
  ChatComposer,
  ChatMessage,
  ChatTranscript,
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
type OneshotStatus = { text: string; engine?: string; timestampMs?: number; seq?: number };
type SteerDelivery = "idle" | "sending" | "queued" | "delivered" | "agent-acked" | "failed";

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
        const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/hijack-candidates`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as {
          candidates?: HijackCandidate[];
          data?: { candidates?: HijackCandidate[] };
        };
        if (!controller.signal.aborted) setCandidates(body.data?.candidates ?? body.candidates ?? []);
      } catch {}
    };
    void load();
    const timer = window.setInterval(() => void load(), 1500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [runId]);
  return candidates;
}

function useOneshotStatus(runId: string | undefined): { statuses: OneshotStatus[]; loading: boolean } {
  const { events, loading } = useGatewayNodeEvents(runId, STATUS_NODE_ID, { maxEvents: 50, pollIntervalMs: 4000 });
  return useMemo(() => {
    const statuses: OneshotStatus[] = [];
    for (const frame of events) {
      if (frame.event !== "NodeOutput") continue;
      const payload = parsePayload(frame.payload);
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!text) continue;
      statuses.push({
        text,
        engine: typeof payload?.engine === "string" ? payload.engine : undefined,
        timestampMs: typeof payload?.timestampMs === "number" ? payload.timestampMs : undefined,
        seq: typeof frame.seq === "number" ? frame.seq : undefined,
      });
    }
    return { statuses: statuses.slice(-6), loading };
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

function NarratorLane({
  runId,
  running,
  now,
  available,
}: {
  runId: string | undefined;
  running: boolean;
  now: number;
  available: boolean | undefined;
}) {
  const { statuses, loading } = useOneshotStatus(runId);
  if (statuses.length === 0 && !running && !loading) return null;
  const latest = statuses.at(-1);
  const label =
    available === false
      ? "Cheap narrator unavailable"
      : latest?.engine
        ? `Cheap narrator · ${latest.engine}`
        : "Cheap narrator";
  return (
    <Card>
      <CardContent style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="oneshot-status-dot" data-live={running} aria-hidden="true" />
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: theme.textDim,
            }}
          >
            {label}
          </div>
        </div>
        <ChatTranscript
          style={{ maxHeight: 190 }}
          empty={
            <EmptyState
              title={
                available === false
                  ? "No Luna or Haiku narrator is available"
                  : running
                    ? "Listening for agent activity…"
                    : "No narration recorded"
              }
              description={
                available === false
                  ? "The transcript and controls remain available without narration."
                  : "Narration runs only while this monitor is attached."
              }
            />
          }
        >
          {statuses.map((status) => (
            <ChatMessage
              key={status.seq ?? `${status.timestampMs}-${status.text}`}
              role="system"
              meta={agoLabel(status.timestampMs, now)}
            >
              {status.text}
            </ChatMessage>
          ))}
        </ChatTranscript>
      </CardContent>
    </Card>
  );
}

async function postOneshotControl(runId: string, action: "attach" | "steer" | "restart", body = {}) {
  const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/oneshot-monitor/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    data?: Record<string, unknown>;
    error?: { message?: string };
  } | null;
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error?.message ?? `Monitor ${action} failed (HTTP ${response.status})`);
  }
  return payload?.data ?? {};
}

function GoalCard({ goal, chain }: { goal?: string; chain?: OneshotChainEntry[] }) {
  if (!goal && (!chain || chain.length === 0)) return null;
  return (
    <Card>
      <CardContent style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 16 }}>
        {goal ? (
          <div
            style={{
              fontSize: 13,
              color: theme.text,
              lineHeight: 1.5,
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
              overflow: "hidden",
            }}
          >
            {goal}
          </div>
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
                >
                  {[entry.engine, entry.model].filter(Boolean).join(" · ")}
                </span>
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
  const controlEvents = useGatewayRunEvents(runId, { maxEvents: 200 });
  const actions = useGatewayActions();
  const candidates = useHijackCandidates(runId);
  const [now, setNow] = useState(Date.now());
  const [pauseRequested, setPauseRequested] = useState(false);
  const [steerText, setSteerText] = useState("");
  const [steerMessageId, setSteerMessageId] = useState<string>();
  const [steerDelivery, setSteerDelivery] = useState<SteerDelivery>("idle");
  const [controlError, setControlError] = useState<string>();
  const [restartBusy, setRestartBusy] = useState(false);
  const [narratorAvailable, setNarratorAvailable] = useState<boolean>();
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
  const patch = useMemo(
    () => (diff && "patches" in diff ? diff.patches.map((item) => item.diff).join("\n") : ""),
    [diff],
  );
  const filesChanged = diff && "patches" in diff ? diff.patches.length : 0;
  const config = useMemo(() => {
    try {
      return typeof run?.configJson === "string" ? (JSON.parse(run.configJson) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }, [run?.configJson]);
  const oneshot =
    config.oneshot && typeof config.oneshot === "object"
      ? (config.oneshot as { chain?: OneshotChainEntry[]; goal?: string; review?: unknown })
      : undefined;
  const chain = Array.isArray(oneshot?.chain) ? oneshot.chain : undefined;
  const goal = typeof oneshot?.goal === "string" && oneshot.goal.trim() ? oneshot.goal : undefined;
  const primary = chain?.[0];
  const model = [primary?.engine, primary?.model].filter(Boolean).join(" · ") || "Auto chain";
  const hasReview = Boolean(oneshot?.review);
  const running = status === "running";

  useEffect(() => {
    if (!runId || !running) return;
    let stopped = false;
    const attach = async () => {
      try {
        const result = await postOneshotControl(runId, "attach");
        if (!stopped) setNarratorAvailable(result.narrator !== false);
      } catch {
        if (!stopped) setNarratorAvailable(false);
      }
    };
    void attach();
    const timer = window.setInterval(() => void attach(), 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [runId, running]);

  useEffect(() => {
    if (!steerMessageId) return;
    for (const frame of controlEvents.events) {
      const payload = parsePayload(frame.payload);
      if (payload?.messageId !== steerMessageId) continue;
      if (frame.event === "OneshotSteerDelivered") setSteerDelivery("delivered");
      if (frame.event === "OneshotSteerAcknowledged") setSteerDelivery("agent-acked");
      if (frame.event === "OneshotSteerFailed") {
        setSteerDelivery("failed");
        setControlError(typeof payload.error === "string" ? payload.error : "Steering delivery failed");
      }
    }
  }, [controlEvents.events, steerMessageId]);

  const sendSteer = async (message: string) => {
    if (!runId) return;
    setSteerDelivery("sending");
    setControlError(undefined);
    try {
      const result = await postOneshotControl(runId, "steer", { message });
      setSteerMessageId(typeof result.messageId === "string" ? result.messageId : undefined);
      setSteerDelivery(result.status === "queued" ? "queued" : "failed");
      if (result.status === "failed") {
        setControlError(typeof result.error === "string" ? result.error : "Steering is unavailable for this agent.");
      }
      setSteerText("");
    } catch (error) {
      setSteerDelivery("failed");
      setControlError(error instanceof Error ? error.message : String(error));
    }
  };

  const restart = async () => {
    if (!runId || !window.confirm("Cancel this attempt if it is active and launch a fresh oneshot run?")) return;
    setRestartBusy(true);
    setControlError(undefined);
    try {
      const result = await postOneshotControl(runId, "restart");
      const nextRunId = typeof result.restartedAsRunId === "string" ? result.restartedAsRunId : undefined;
      if (!nextRunId) throw new Error("Restart launched without a new run ID");
      const params = new URLSearchParams(location.search);
      params.set("runId", nextRunId);
      location.search = params.toString();
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
      setRestartBusy(false);
    }
  };

  const controls = (
    <>
      <Button variant="outline" onClick={() => void restart()} disabled={!runId || restartBusy}>
        {restartBusy ? "Restarting…" : "Restart"}
      </Button>
      <Button variant="outline" onClick={() => runId && actions.resumeRun({ runId })} disabled={!runId}>
        Resume
      </Button>
      <Button variant="outline" onClick={() => setPauseRequested(true)} disabled={!runId || pauseRequested}>
        Pause
      </Button>
      <Button variant="destructive" onClick={() => runId && actions.cancelRun({ runId })} disabled={!runId}>
        Cancel
      </Button>
    </>
  );

  if (!runId) {
    return (
      <>
        <SmithersUiStyles withTheme />
        <WorkflowUiShell title="Oneshot" actions={controls}>
          <EmptyState title="No run selected" description="Open this UI with a oneshot run ID." />
        </WorkflowUiShell>
      </>
    );
  }

  return (
    <>
      <SmithersUiStyles withTheme />
      <style>{STATUS_STYLES}</style>
      <WorkflowUiShell title="Oneshot" meta={<StatusPill status={status} />} actions={controls}>
        <GoalCard goal={goal} chain={chain} />
        <Card>
          <CardContent
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 12,
              paddingTop: 16,
            }}
          >
            <KpiStat label="Status" value={status} />
            <KpiStat label="Engine / model" value={model} />
            <KpiStat
              label="Elapsed"
              value={elapsedLabel(
                typeof run?.startedAtMs === "number" ? run.startedAtMs : undefined,
                typeof run?.finishedAtMs === "number" ? run.finishedAtMs : undefined,
                now,
              )}
            />
            <KpiStat label="Files changed" value={filesChanged} />
          </CardContent>
        </Card>
        <NarratorLane runId={runId} running={running} now={now} available={narratorAvailable} />
        <Tabs defaultValue="chat">
          <TabsList>
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="diff" count={filesChanged}>
              Diff
            </TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
          </TabsList>
          <TabsContent value="chat">
            <NodeChatStream runId={runId} nodeId="implement" title="Implement" height={420} />
            {hasReview ? <NodeChatStream runId={runId} nodeId="review" title="Review" height={320} /> : null}
            <Card>
              <CardContent style={{ paddingTop: 16 }}>
                <ChatComposer
                  value={steerText}
                  onValueChange={setSteerText}
                  onSubmit={sendSteer}
                  disabled={
                    !running ||
                    steerDelivery === "sending" ||
                    steerDelivery === "queued" ||
                    steerDelivery === "delivered"
                  }
                  placeholder={
                    running
                      ? "Steer the Claude Code agent at its next safe turn boundary…"
                      : "Steering is available only while the run is active."
                  }
                  inputAriaLabel="Steering message"
                  submitLabel="Send steering message"
                  status={
                    controlError
                      ? controlError
                      : steerDelivery === "idle"
                        ? "Claude Code: interrupt at an event boundary, append the message, then resume."
                        : `Delivery: ${steerDelivery}`
                  }
                />
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="diff">
            {oversized ? (
              <EmptyState
                title="Diff is too large for the browser"
                description={`Run smithers diff ${runId} to inspect it in the terminal.`}
              />
            ) : diffState.error ? (
              <EmptyState title="Diff unavailable" description={diffState.error.message} />
            ) : (
              <PierreDiffView patch={patch} emptyLabel="No finished diff is available yet." />
            )}
          </TabsContent>
          <TabsContent value="events">
            <RunEventLog runId={runId} style={{ height: 420 }} />
          </TabsContent>
        </Tabs>
        <Card>
          <CardContent style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 16 }}>
            {candidates.length > 0 ? (
              <Button onClick={() => navigator.clipboard.writeText(`smithers hijack ${runId}`)}>
                Copy hijack command
              </Button>
            ) : (
              <EmptyState
                title="Hijack not ready"
                description="The command appears when an agent session is recorded."
              />
            )}
          </CardContent>
        </Card>
      </WorkflowUiShell>
    </>
  );
}

createGatewayReactRoot(<App />);
