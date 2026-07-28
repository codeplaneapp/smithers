/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayRun,
  useGatewayRunEvents,
  useSmithersGateway,
} from "smithers-orchestrator/gateway-react";
import {
  Badge,
  Button,
  ChatComposer,
  ChatMessage,
  ChatTranscript,
  SmithersUiStyles,
  StatusPill,
} from "smithers-orchestrator/ui";
import { PtyScreen } from "./ptyScreen";

const WORKFLOW_KEY = "hijacked-chat-pipeline";
const TERMINAL_COLS = 100;
const TERMINAL_ROWS = 32;

const PIPELINE_STAGES = [
  { id: "scope", label: "Scope", description: "Agree on the brief" },
  { id: "plan", label: "Plan", description: "Choose the route" },
  { id: "deliver", label: "Deliver", description: "Implement and verify" },
] as const;

type StageId = (typeof PIPELINE_STAGES)[number]["id"];
type StageState = "queued" | "starting" | "live" | "finishing" | "complete" | "failed";
type SessionStatus = "connecting" | "connected" | "exiting" | "exited" | "closed" | "error";

type HijackCandidate = {
  nodeId: string;
  engine: string;
  mode: string;
  iteration: number;
  attempt: number;
  startedAtMs: number;
};

type SentMessage = {
  id: number;
  text: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function shortRunId(runId: string): string {
  return runId.length > 15 ? `${runId.slice(0, 8)}…${runId.slice(-4)}` : runId;
}

function parseCandidates(body: unknown): HijackCandidate[] {
  if (!isRecord(body)) return [];
  const data = isRecord(body.data) ? body.data : body;
  const rows = Array.isArray(data.candidates) ? data.candidates : [];
  return rows
    .flatMap((row): HijackCandidate[] => {
      if (!isRecord(row)) return [];
      const nodeId = asString(row.nodeId);
      const engine = asString(row.engine);
      if (!nodeId || !engine) return [];
      return [{
        nodeId,
        engine,
        mode: asString(row.mode) ?? "native-cli",
        iteration: asNumber(row.iteration) ?? 0,
        attempt: asNumber(row.attempt) ?? 1,
        startedAtMs: asNumber(row.startedAtMs) ?? 0,
      }];
    })
    .sort((left, right) => left.startedAtMs - right.startedAtMs);
}

function ptyHijackUrl(runId: string, nodeId: string, token: string | undefined): string {
  const url = new URL("/v1/pty/hijack", location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("runId", runId);
  url.searchParams.set("nodeId", nodeId);
  url.searchParams.set("cols", String(TERMINAL_COLS));
  url.searchParams.set("rows", String(TERMINAL_ROWS));
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function useHijackCandidates(runId: string | undefined, token: string | undefined): HijackCandidate[] {
  const [candidates, setCandidates] = useState<HijackCandidate[]>([]);

  useEffect(() => {
    setCandidates([]);
    if (!runId) return;
    const controller = new AbortController();

    const load = async () => {
      try {
        const response = await fetch(
          `/v1/api/runs/${encodeURIComponent(runId)}/hijack-candidates`,
          {
            signal: controller.signal,
            headers: token ? { authorization: `Bearer ${token}` } : undefined,
          },
        );
        if (!response.ok) return;
        const next = parseCandidates(await response.json());
        if (!controller.signal.aborted) setCandidates(next);
      } catch (error) {
        if (!controller.signal.aborted) console.warn("Could not load hijack candidates", error);
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 1_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [runId, token]);

  return candidates;
}

function stageStates(
  events: ReturnType<typeof useGatewayRunEvents>["events"],
  candidates: readonly HijackCandidate[],
  dismissed: ReadonlySet<string>,
): Record<StageId, StageState> {
  const states: Record<StageId, StageState> = {
    scope: "queued",
    plan: "queued",
    deliver: "queued",
  };
  for (const frame of events) {
    const payload = isRecord(frame.payload) ? frame.payload : {};
    const nodeId = asString(payload.nodeId) as StageId | undefined;
    if (!nodeId || !(nodeId in states)) continue;
    if (frame.event === "NodeStarted") states[nodeId] = "starting";
    else if (frame.event === "RunHijacked") states[nodeId] = "live";
    else if (frame.event === "NodeFinished") states[nodeId] = "complete";
    else if (frame.event === "NodeFailed") states[nodeId] = "failed";
  }
  for (const candidate of candidates) {
    const nodeId = candidate.nodeId as StageId;
    if (!(nodeId in states) || states[nodeId] === "complete" || states[nodeId] === "failed") continue;
    states[nodeId] = dismissed.has(nodeId) ? "finishing" : "live";
  }
  return states;
}

function badgeVariant(state: StageState): "muted" | "warning" | "success" | "destructive" {
  if (state === "complete") return "success";
  if (state === "failed") return "destructive";
  if (state === "live" || state === "starting" || state === "finishing") return "warning";
  return "muted";
}

function sessionStatusLabel(status: SessionStatus): string {
  if (status === "connecting") return "Connecting";
  if (status === "connected") return "Live session";
  if (status === "exiting") return "Returning control";
  if (status === "exited") return "Session ended";
  if (status === "closed") return "Connection closed";
  return "Connection error";
}

function SessionChat({
  runId,
  candidate,
  stageLabel,
  token,
  onExit,
}: {
  runId: string;
  candidate: HijackCandidate;
  stageLabel: string;
  token: string | undefined;
  onExit: (nodeId: string) => void;
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const messageIdRef = useRef(0);
  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [draft, setDraft] = useState("");
  const [screenText, setScreenText] = useState("");
  const [sentMessages, setSentMessages] = useState<SentMessage[]>([]);

  useEffect(() => {
    const socket = new WebSocket(ptyHijackUrl(runId, candidate.nodeId, token));
    const decoder = new TextDecoder();
    const screen = new PtyScreen(TERMINAL_COLS, TERMINAL_ROWS);
    let disposed = false;
    let exitReported = false;
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    setStatus("connecting");
    setScreenText("");
    setSentMessages([]);

    const reportExit = () => {
      if (exitReported || disposed) return;
      exitReported = true;
      onExit(candidate.nodeId);
    };

    socket.onopen = () => {
      if (disposed) return;
      setStatus("connected");
      socket.send(JSON.stringify({ type: "resize", cols: TERMINAL_COLS, rows: TERMINAL_ROWS }));
    };
    socket.onmessage = (event) => {
      if (disposed) return;
      if (typeof event.data === "string") {
        try {
          const control = JSON.parse(event.data) as { type?: unknown; message?: unknown };
          if (control.type === "exit") {
            setStatus("exited");
            reportExit();
          } else if (control.type === "error") {
            setStatus("error");
            setScreenText((current) => `${current}\n\n${String(control.message ?? "PTY error")}`.trim());
          }
        } catch {
          // PTY output is binary. Unknown text control frames are forward-compatible no-ops.
        }
        return;
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      screen.feed(decoder.decode(bytes, { stream: true }));
      setScreenText(screen.snapshot());
    };
    socket.onerror = () => {
      if (!disposed) setStatus("error");
    };
    socket.onclose = (event) => {
      if (disposed || exitReported) return;
      setStatus(event.code === 1000 ? "exited" : "closed");
      if (event.code === 1000) reportExit();
    };

    return () => {
      disposed = true;
      socketRef.current = null;
      try {
        socket.close(1000, "chat surface closed");
      } catch {
        // Closing a CONNECTING browser socket can throw.
      }
    };
  }, [candidate.nodeId, candidate.attempt, onExit, runId, token]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [screenText, sentMessages.length]);

  const sendMessage = useCallback((text: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const bytes = new TextEncoder().encode(`${text}\r`);
    socket.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    messageIdRef.current += 1;
    setSentMessages((current) => [...current, { id: messageIdRef.current, text }]);
    setDraft("");
  }, []);

  const returnControl = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    setStatus("exiting");
    const bytes = new Uint8Array([4]);
    socket.send(bytes.buffer);
  }, []);

  const connected = status === "connected" || status === "exiting";
  return (
    <section className="hcp-session" data-testid="hijacked-session-chat">
      <ChatTranscript ref={transcriptRef} pending={!screenText && status === "connecting"}>
        <ChatMessage role="system">
          <strong>{stageLabel}</strong> is a real hijacked {candidate.engine} session. Chat normally here.
          When the stage is done, ask the agent to return <code>{"{}"}</code>, then use Return control.
        </ChatMessage>
        {sentMessages.map((message) => (
          <ChatMessage role="user" key={message.id}>{message.text}</ChatMessage>
        ))}
        {screenText ? (
          <ChatMessage
            role="assistant"
            variant="terminal"
            label={`${stageLabel} · ${candidate.engine}`}
            meta={sessionStatusLabel(status)}
          >
            {screenText}
          </ChatMessage>
        ) : null}
        {status === "error" || status === "closed" ? (
          <ChatMessage role="system">
            The PTY connection closed. Keep this page open; the next candidate will attach automatically if the run resumes.
          </ChatMessage>
        ) : null}
      </ChatTranscript>
      <ChatComposer
        value={draft}
        onValueChange={setDraft}
        onSubmit={sendMessage}
        disabled={!connected}
        docked
        placeholder={`Message the ${stageLabel.toLowerCase()} agent…`}
        statusText={`${sessionStatusLabel(status)} · ${candidate.mode}`}
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={returnControl}
            disabled={!connected}
            title="Send Ctrl+D to end the native agent session"
          >
            Return control
          </Button>
        }
      />
    </section>
  );
}

function PipelineHeader({
  runId,
  runStatus,
  states,
  onNewRun,
}: {
  runId: string;
  runStatus: string;
  states: Record<StageId, StageState>;
  onNewRun: () => void;
}) {
  return (
    <>
      <header className="hcp-header">
        <div className="hcp-brand">
          <span className="hcp-mark" aria-hidden="true">S</span>
          <div>
            <h1>Hijacked chat pipeline</h1>
            <span className="hcp-run-id">{shortRunId(runId)}</span>
          </div>
        </div>
        <div className="hcp-header-actions">
          <StatusPill status={runStatus} />
          <Button size="sm" variant="ghost" onClick={onNewRun}>New run</Button>
        </div>
      </header>
      <nav className="hcp-stages" aria-label="Pipeline stages">
        {PIPELINE_STAGES.map((stage, index) => (
          <div className="hcp-stage" data-state={states[stage.id]} key={stage.id}>
            <Badge variant={badgeVariant(states[stage.id])}>{index + 1}</Badge>
            <div>
              <strong>{stage.label}</strong>
              <span>{stage.description}</span>
            </div>
          </div>
        ))}
      </nav>
    </>
  );
}

function LaunchChat({ onLaunched }: { onLaunched: (runId: string) => void }) {
  const actions = useGatewayActions();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const launch = async (value: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { goal: value } });
      onLaunched(result.runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="hcp-launch">
      <ChatTranscript>
        <ChatMessage role="assistant">
          Tell me what you want to build. I will open three real, sequential Codex sessions for scoping, planning, and delivery.
        </ChatMessage>
        {error ? <ChatMessage role="system">{error}</ChatMessage> : null}
      </ChatTranscript>
      <ChatComposer
        value={goal}
        onValueChange={setGoal}
        onSubmit={launch}
        disabled={busy}
        docked
        placeholder="What should the pipeline work on?"
        statusText={busy ? "Launching pipeline…" : "Three interactive stages"}
        submitLabel="Launch pipeline"
      />
    </main>
  );
}

function WaitingChat({ states }: { states: Record<StageId, StageState> }) {
  const failed = PIPELINE_STAGES.find((stage) => states[stage.id] === "failed");
  const complete = PIPELINE_STAGES.every((stage) => states[stage.id] === "complete");
  const next = PIPELINE_STAGES.find((stage) => states[stage.id] !== "complete");
  let message: ReactNode = `Preparing the ${next?.label.toLowerCase() ?? "next"} session…`;
  if (failed) message = `${failed.label} failed. Inspect the run events for the underlying agent error.`;
  if (complete) message = "Pipeline complete. The brief, plan, implementation, and verification are all preserved in this run.";
  return (
    <ChatTranscript pending={!failed && !complete}>
      <ChatMessage role={failed ? "system" : "assistant"}>{message}</ChatMessage>
    </ChatTranscript>
  );
}

function App() {
  const gateway = useSmithersGateway();
  const [runId, setRunId] = useState<string | undefined>(runIdFromUrl);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const run = useGatewayRun(runId);
  const stream = useGatewayRunEvents(runId, { afterSeq: 0, maxEvents: 1_000 });
  const candidates = useHijackCandidates(runId, gateway.token);

  const states = useMemo(
    () => stageStates(stream.events, candidates, dismissed),
    [candidates, dismissed, stream.events],
  );
  const activeCandidate = useMemo(() => {
    const settled = new Set(
      PIPELINE_STAGES
        .filter((stage) => states[stage.id] === "complete" || states[stage.id] === "failed")
        .map((stage) => stage.id),
    );
    return [...candidates]
      .reverse()
      .find((candidate) => !settled.has(candidate.nodeId as StageId) && !dismissed.has(candidate.nodeId));
  }, [candidates, dismissed, states]);

  const runRecord = isRecord(run.data) ? run.data : {};
  const runState = isRecord(runRecord.runState) ? asString(runRecord.runState.state) : undefined;
  const storedStatus = runState ?? asString(runRecord.status) ?? "running";
  const allComplete = PIPELINE_STAGES.every((stage) => states[stage.id] === "complete");
  const displayStatus = activeCandidate ? "running" : allComplete ? "succeeded" : storedStatus;

  const chooseRun = useCallback((nextRunId: string | undefined) => {
    setRunId(nextRunId);
    setDismissed(new Set());
    if (typeof history !== "undefined" && typeof location !== "undefined") {
      const url = new URL(location.href);
      if (nextRunId) url.searchParams.set("runId", nextRunId);
      else url.searchParams.delete("runId");
      history.replaceState(null, "", url);
    }
  }, []);

  const onSessionExit = useCallback((nodeId: string) => {
    setDismissed((current) => new Set([...current, nodeId]));
  }, []);

  const activeStage = PIPELINE_STAGES.find((stage) => stage.id === activeCandidate?.nodeId);
  return (
    <div className="hcp-shell">
      <SmithersUiStyles withTheme extra={exampleCss} />
      {runId ? (
        <>
          <PipelineHeader
            runId={runId}
            runStatus={displayStatus}
            states={states}
            onNewRun={() => chooseRun(undefined)}
          />
          <main className="hcp-main">
            {activeCandidate && activeStage ? (
              <SessionChat
                runId={runId}
                candidate={activeCandidate}
                stageLabel={activeStage.label}
                token={gateway.token}
                onExit={onSessionExit}
              />
            ) : (
              <WaitingChat states={states} />
            )}
          </main>
        </>
      ) : (
        <LaunchChat onLaunched={chooseRun} />
      )}
    </div>
  );
}

const exampleCss = `
body { overflow:hidden; }
.hcp-shell { width:100%; height:100vh; display:grid; grid-template-rows:auto auto minmax(0, 1fr); overflow:hidden; background:var(--bg); color:var(--text); }
.hcp-header { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 18px; border-bottom:1px solid var(--border); background:var(--surface-glass-strong); -webkit-backdrop-filter:blur(18px) saturate(180%); backdrop-filter:blur(18px) saturate(180%); }
.hcp-brand, .hcp-header-actions { display:flex; align-items:center; gap:10px; min-width:0; }
.hcp-brand h1 { margin:0; font-size:15px; }
.hcp-mark { width:30px; height:30px; display:grid; place-items:center; flex:none; border-radius:10px; background:var(--inverse-bg); color:var(--inverse-text); font-weight:750; }
.hcp-run-id { display:block; color:var(--text-muted); font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
.hcp-stages { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1px; border-bottom:1px solid var(--border); background:var(--border); }
.hcp-stage { min-width:0; display:flex; align-items:center; gap:9px; padding:10px 14px; background:var(--surface); }
.hcp-stage[data-state='live'] { background:color-mix(in srgb,var(--brand) 8%,var(--surface)); }
.hcp-stage > div { min-width:0; display:grid; gap:1px; }
.hcp-stage strong { font-size:12px; }
.hcp-stage span { overflow:hidden; color:var(--text-muted); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.hcp-main, .hcp-session, .hcp-launch { min-width:0; min-height:0; height:100%; overflow:hidden; }
.hcp-main, .hcp-session, .hcp-launch { display:flex; flex-direction:column; }
.hcp-session code { padding:1px 5px; border-radius:5px; background:var(--inline-code-bg); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.hcp-launch { grid-row:1 / -1; }
.hcp-launch .sui-chat-messages { justify-content:center; padding-bottom:150px; }
@media (max-width:680px) { .hcp-header { align-items:flex-start; padding:10px 12px; } .hcp-header-actions { gap:4px; } .hcp-stage { padding:8px; } .hcp-stage span { display:none; } }
`;

const gatewayToken =
  typeof location === "undefined"
    ? undefined
    : new URLSearchParams(location.search).get("token") ?? undefined;

createGatewayReactRoot(<App />, gatewayToken ? { token: gatewayToken } : {});
