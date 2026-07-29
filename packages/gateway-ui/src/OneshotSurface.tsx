/** @jsxImportSource react */
/**
 * `<OneshotSurface>` — the one live surface for a single-agent run.
 *
 * This is the oneshot workflow UI (goal, chain, KPIs, live status, chat, diff,
 * events) with the PTY hijack capability folded in as a first-class tab instead
 * of a monitor-only modal. Two hosts render the exact same component:
 *
 * - standalone, as the oneshot workflow's own UI (`smithers ui`, `smithers
 *   oneshot --open`, and the auto-hijacked runs `smithers chat-create` makes),
 * - embedded in the Monitor, opened from a node row's Hijack / Reopen button,
 *   where it can be maximized to fill the viewport and restored again.
 *
 * The hijack terminal attaches to the gateway's `/v1/pty/hijack` websocket
 * (which runs `smithers hijack <runId> --target <nodeId>` in a real PTY) and
 * renders through the shared `@smithers-orchestrator/ui` terminal adapter:
 * binary frames are raw PTY bytes both ways, text frames are JSON control
 * messages (`resize` up, `exit`/`error` down).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  useGatewayActions,
  useGatewayNodeEvents,
  useGatewayRpc,
  useGatewayRunEvents,
  useGatewayRun,
  useGatewayRunDiff,
  useSmithersGateway,
} from "@smithers-orchestrator/gateway-react";
import {
  Button,
  Card,
  CardContent,
  ChatComposer,
  ChatMessage,
  ChatTranscript,
  Dialog,
  DialogContent,
  DialogTitle,
  EmptyState,
  KpiStat,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  normalizeStatus,
} from "@smithers-orchestrator/ui";
import { Terminal, type TerminalInstance, type TerminalStream } from "@smithers-orchestrator/ui/adapters/terminal";
import { PierreDiffView } from "@smithers-orchestrator/ui/adapters/pierre-diff-view";
import { NodeChatStream } from "./NodeChatStream";
import { RunEventLog } from "./RunEventLog";
import { StatusPill } from "./StatusPill";
import { WorkflowUiShell } from "./styleguide";
import { theme } from "./theme";
import {
  hijackActionFor,
  hijackCandidateForNode,
  hijackCandidatesOf,
  ptyHijackUrl,
  type HijackCandidate,
  type HijackStatus,
} from "./hijack";

export type OneshotSurfaceTab = "chat" | "diff" | "events" | "terminal";

export type OneshotSurfaceProps = {
  /** Run to render. Omit to show the "no run selected" empty state. */
  runId?: string;
  /**
   * How the surface is hosted. `standalone` fills the page (workflow UI),
   * `embedded` renders inline inside a host panel, `overlay` renders as a
   * dismissable dialog over the host (the Monitor's hijack affordance).
   */
  variant?: "standalone" | "embedded" | "overlay";
  /** Tab shown first. Hosts that open the surface to hijack pass `terminal`. */
  initialTab?: OneshotSurfaceTab;
  /** Node whose recorded session the terminal attaches to first. */
  hijackNodeId?: string;
  /** Header title. Defaults to "Oneshot". */
  title?: string;
  /** Start maximized (fills the viewport). Only meaningful when not standalone. */
  defaultMaximized?: boolean;
  /** Rendered when the host can dismiss the surface (overlay/embedded). */
  onClose?: () => void;
  className?: string;
  style?: CSSProperties;
  /** Test hook on the outermost element. */
  "data-testid"?: string;
};

type OneshotChainEntry = { engine?: string; model?: string };
type OneshotStatus = { text: string; engine?: string; timestampMs?: number; seq?: number };
type SteerDelivery = "idle" | "sending" | "queued" | "delivered" | "agent-acked" | "failed";

const STATUS_NODE_ID = "status";
const WEBSOCKET_OPEN = 1;
// Keep request cancellation paired with the fetch implementation captured by
// the Gateway client. Test/browser hosts may replace DOM globals after modules
// load (happy-dom does); mixing constructors produces an invalid AbortSignal.
const RuntimeAbortController = globalThis.AbortController;

const SURFACE_STYLES = `
@keyframes oneshot-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.75); } }
.oneshot-status-dot { width: 8px; height: 8px; border-radius: 9999px; flex: none; background: ${theme.success}; }
.oneshot-status-dot[data-live="true"] { animation: oneshot-pulse 1.6s ease-in-out infinite; }
.oneshot-status-text { transition: opacity 200ms ease; }
.oneshot-surface-panel { display: flex; flex-direction: column; min-height: 0; overflow: auto; width: min(1200px, 96vw); height: min(820px, 92vh); border: 1px solid ${theme.border}; border-radius: 12px; background: ${theme.bg}; }
.oneshot-surface-panel[data-maximized="true"] { width: 100vw; height: 100vh; border-radius: 0; border: 0; }
.oneshot-surface-embedded { display: flex; flex-direction: column; min-height: 0; }
`;

/** Poll the gateway's per-node hijack candidates for a run. */
function useHijackCandidates(runId: string | undefined, live = true): HijackCandidate[] {
  const gateway = useSmithersGateway();
  const [candidates, setCandidates] = useState<HijackCandidate[]>([]);
  useEffect(() => {
    setCandidates([]);
    if (!runId) return;
    const controller = new RuntimeAbortController();
    const load = async () => {
      try {
        const headers = new Headers(gateway.headers);
        if (gateway.token) headers.set("authorization", `Bearer ${gateway.token}`);
        const response = await gateway.fetchImpl(
          `${gateway.baseUrl}/v1/api/runs/${encodeURIComponent(runId)}/hijack-candidates`,
          { headers, signal: controller.signal },
        );
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!controller.signal.aborted) setCandidates(hijackCandidatesOf(body));
      } catch {
        // Transient fetch failures just keep the previous candidate view.
      }
    };
    void load();
    const timer = live ? setInterval(() => void load(), 5_000) : null;
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [gateway, runId, live]);
  return candidates;
}

export type HijackCandidateButtonProps = {
  runId: string;
  nodeId: string;
  runStatus?: string;
  nodeLive: boolean;
  compact?: boolean;
  onOpen: (candidate: HijackCandidate, action: NonNullable<ReturnType<typeof hijackActionFor>>) => void;
};

/**
 * Candidate-aware Monitor affordance for opening the shared surface.
 *
 * Keeping candidate discovery here means hosts do not need to publish or
 * duplicate the gateway data hook.
 */
export function HijackCandidateButton({
  runId,
  nodeId,
  runStatus,
  nodeLive,
  compact = false,
  onOpen,
}: HijackCandidateButtonProps) {
  const candidates = useHijackCandidates(runId, nodeLive);
  const candidate = hijackCandidateForNode(candidates, nodeId);
  const action = hijackActionFor(runStatus, nodeLive, candidate !== null);
  if (!candidate || !action) return null;
  return (
    <Button
      variant="outline"
      size={compact ? "sm" : undefined}
      className={compact ? "mon-hijack-inline" : undefined}
      data-testid={compact ? "monitor-hijack-inline" : "monitor-hijack-button"}
      data-hijack-kind={action.kind}
      title={
        action.kind === "hijack"
          ? `Take over this node's live ${candidate.engine} session in an embedded terminal`
          : `Reopen this node's recorded ${candidate.engine} session in an embedded terminal`
      }
      onClick={() => onOpen(candidate, action)}
    >
      {compact ? `⌁ ${action.kind === "hijack" ? "Hijack terminal" : "Reopen terminal"}` : action.label}
    </Button>
  );
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

/**
 * The cheap narrator's lane: the recent one-line status updates the sidecar
 * agent records while a monitor is attached. `available === false` means no
 * narrator tier could be started, which the lane says outright instead of
 * silently showing nothing.
 */
function NarratorLane({
  runId,
  running,
  now,
  labelPrefix,
  available,
}: {
  runId: string | undefined;
  running: boolean;
  now: number;
  labelPrefix: string;
  available?: boolean;
}) {
  const { statuses, loading } = useOneshotStatus(runId);
  if (statuses.length === 0 && !running && !loading) return null;
  const latest = statuses.at(-1);
  const label =
    available === false
      ? `${labelPrefix} unavailable`
      : latest?.engine
        ? `${labelPrefix} · ${latest.engine}`
        : labelPrefix;
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

/**
 * Call one of the gateway's oneshot monitor controls (`attach`, `steer`,
 * `restart`) through the provider's Gateway client, so auth and base URL are
 * whatever the host configured.
 */
async function postOneshotControl(
  gateway: ReturnType<typeof useSmithersGateway>,
  runId: string,
  action: "attach" | "steer" | "restart",
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const headers = new Headers(gateway.headers);
  headers.set("content-type", "application/json");
  if (gateway.token) headers.set("authorization", `Bearer ${gateway.token}`);
  const response = await gateway.fetchImpl(
    `${gateway.baseUrl}/v1/api/runs/${encodeURIComponent(runId)}/oneshot-monitor/${action}`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
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

export type HijackTerminalProps = {
  runId: string;
  nodeId?: string;
  onStatus?: (status: HijackStatus) => void;
  style?: CSSProperties;
};

/**
 * One interactive PTY hand-off. The websocket is owned by the terminal's
 * `stream` seam, so it is created after the emulator opens (real cols/rows) and
 * torn down with it. Remount on a target change is driven by the caller's key.
 */
export function HijackTerminal({ runId, nodeId, onStatus, style }: HijackTerminalProps) {
  const gateway = useSmithersGateway();
  const terminalRef = useRef<TerminalInstance | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const sendResize = useCallback((cols: number, rows: number) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) return;
    socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }, []);

  const stream = useCallback<TerminalStream>(
    (write) => {
      const term = terminalRef.current;
      const cols = term?.cols ?? 80;
      const rows = term?.rows ?? 24;
      onStatusRef.current?.("connecting");
      const WebSocketImpl = gateway.WebSocketImpl;
      if (!WebSocketImpl) {
        onStatusRef.current?.("error");
        write("\r\n\x1b[1;31mWebSocket is unavailable in this browser.\x1b[0m\r\n");
        return;
      }
      const socket = new WebSocketImpl(ptyHijackUrl(gateway.baseUrl, runId, nodeId, { cols, rows }, gateway.token));
      let terminalEnded = false;
      socketRef.current = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        onStatusRef.current?.("connected");
        sendResize(terminalRef.current?.cols ?? cols, terminalRef.current?.rows ?? rows);
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          // JSON control frames; unknown types are ignored for forward compat.
          try {
            const message = JSON.parse(event.data) as { type?: unknown; code?: unknown; message?: unknown };
            if (message.type === "exit") {
              terminalEnded = true;
              onStatusRef.current?.("exited");
              write(
                `\r\n\x1b[2m[session ended${typeof message.code === "number" ? ` · exit ${message.code}` : ""}]\x1b[0m\r\n`,
              );
            } else if (message.type === "error") {
              terminalEnded = true;
              onStatusRef.current?.("error");
              write(`\r\n\x1b[1;31m${String(message.message ?? "PTY error")}\x1b[0m\r\n`);
            }
          } catch {
            // Not JSON: drop, PTY bytes only travel on binary frames.
          }
          return;
        }
        write(new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onerror = () => {
        terminalEnded = true;
        onStatusRef.current?.("error");
        write("\r\n\x1b[1;31mTerminal socket error — the connection to the gateway failed.\x1b[0m\r\n");
      };
      socket.onclose = () => {
        if (!terminalEnded) onStatusRef.current?.("closed");
      };
      return () => {
        socketRef.current = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close(1000, "terminal closed");
        } catch {
          // Closing a CONNECTING socket can throw in some environments.
        }
      };
    },
    [gateway, runId, nodeId, sendResize],
  );

  return (
    <Terminal
      data-testid="oneshot-hijack-terminal"
      style={{ height: "100%", minHeight: 320, ...style }}
      onReady={(instance) => {
        terminalRef.current = instance;
        instance.focus();
      }}
      onData={(data) => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WEBSOCKET_OPEN) return;
        const bytes = new TextEncoder().encode(data);
        socket.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      }}
      onResize={({ cols, rows }) => sendResize(cols, rows)}
      stream={stream}
    />
  );
}

function HijackPanel({
  runId,
  candidates,
  nodeId,
  onSelect,
  height,
}: {
  runId: string;
  candidates: readonly HijackCandidate[];
  nodeId: string | undefined;
  onSelect: (nodeId: string) => void;
  height: number;
}) {
  const [status, setStatus] = useState<HijackStatus>("connecting");
  const target = hijackCandidateForNode(candidates, nodeId) ?? candidates[0];
  if (!target) {
    return (
      <EmptyState
        title="Hijack not ready"
        description="A terminal appears here as soon as an agent session is recorded for this run."
      />
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {candidates.map((candidate) => (
          <Button
            key={candidate.nodeId}
            size="sm"
            variant={candidate.nodeId === target.nodeId ? "default" : "outline"}
            data-testid="oneshot-hijack-target"
            title={`Attach to the recorded ${candidate.engine} session for ${candidate.nodeId}`}
            onClick={() => onSelect(candidate.nodeId)}
          >
            {candidate.nodeId} · {candidate.engine}
          </Button>
        ))}
        <span style={{ flex: 1 }} />
        <StatusPill
          status={status === "connected" ? "running" : status === "error" ? "failed" : "pending"}
          label={status}
        />
      </div>
      <div style={{ height, minHeight: 0 }}>
        <HijackTerminal key={`${runId}:${target.nodeId}`} runId={runId} nodeId={target.nodeId} onStatus={setStatus} />
      </div>
    </div>
  );
}

export function OneshotSurface({
  runId,
  variant = "standalone",
  initialTab = "chat",
  hijackNodeId,
  title,
  defaultMaximized = false,
  onClose,
  className,
  style,
  "data-testid": testId,
}: OneshotSurfaceProps) {
  const runState = useGatewayRun(runId);
  const diffState = useGatewayRunDiff({ runId });
  const actions = useGatewayActions();
  const [now, setNow] = useState(() => Date.now());
  const [pauseRequested, setPauseRequested] = useState(false);
  const [tab, setTab] = useState<OneshotSurfaceTab>(initialTab);
  const [maximized, setMaximized] = useState(defaultMaximized);
  const [target, setTarget] = useState(hijackNodeId);
  const [steerText, setSteerText] = useState("");
  const [steerMessageId, setSteerMessageId] = useState<string>();
  const [steerDelivery, setSteerDelivery] = useState<SteerDelivery>("idle");
  const [controlError, setControlError] = useState<string>();
  const [restartBusy, setRestartBusy] = useState(false);
  const [narratorAvailable, setNarratorAvailable] = useState<boolean>();
  const gateway = useSmithersGateway();
  const controlEvents = useGatewayRunEvents(runId, { maxEvents: 200 });
  const pause = useGatewayRpc("pauseRun", { runId: runId ?? "" }, { enabled: Boolean(runId && pauseRequested) });

  useEffect(() => setTarget(hijackNodeId), [hijackNodeId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (pause.data || pause.error) setPauseRequested(false);
  }, [pause.data, pause.error]);

  const run = runState.data as Record<string, unknown> | undefined;
  const status = normalizeStatus(typeof run?.status === "string" ? run.status : "pending");
  const running = status === "running";
  const candidates = useHijackCandidates(runId, running);
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
  const workflowName =
    typeof run?.workflowName === "string"
      ? run.workflowName
      : typeof run?.workflowKey === "string"
        ? run.workflowKey
        : undefined;
  const surfaceTitle = title ?? (workflowName === "chat" ? "Chat" : "Oneshot");
  // Steering, restart, and narration are the oneshot pipeline's monitor
  // controls; a run without oneshot config has no such endpoints to call.
  const oneshotControls = Boolean(oneshot);

  useEffect(() => {
    if (!runId || !running || !oneshotControls) return;
    let stopped = false;
    const attach = async () => {
      try {
        const result = await postOneshotControl(gateway, runId, "attach");
        if (!stopped) setNarratorAvailable(result.narrator !== false);
      } catch {
        if (!stopped) setNarratorAvailable(false);
      }
    };
    void attach();
    const timer = setInterval(() => void attach(), 15_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [gateway, runId, running, oneshotControls]);

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
      const result = await postOneshotControl(gateway, runId, "steer", { message });
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
      const result = await postOneshotControl(gateway, runId, "restart");
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

  const candidateTarget = hijackCandidateForNode(candidates, target);
  const primaryNodeId = candidateTarget?.nodeId ?? candidates[0]?.nodeId ?? target ?? "implement";
  const hijackAction = hijackActionFor(status, running, candidates.length > 0);

  // Embedded maximized surfaces are not Radix dialogs, so retain the expected
  // Escape-to-restore behavior there. Overlay Escape is handled by Dialog.
  useEffect(() => {
    if (variant !== "embedded" || !maximized) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMaximized(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [variant, maximized]);

  const controls = (
    <>
      {variant !== "standalone" ? (
        <Button
          variant="outline"
          data-testid="oneshot-surface-maximize"
          aria-pressed={maximized}
          title={maximized ? "Restore this surface" : "Maximize this surface"}
          onClick={() => setMaximized((value) => !value)}
        >
          {maximized ? "⤡ Restore" : "⤢ Maximize"}
        </Button>
      ) : null}
      {hijackAction ? (
        <Button
          data-testid="oneshot-hijack-button"
          onClick={() => {
            setTarget(primaryNodeId);
            setTab("terminal");
          }}
        >
          {hijackAction.label}
        </Button>
      ) : null}
      {oneshotControls ? (
        <Button
          variant="outline"
          data-testid="oneshot-restart-button"
          onClick={() => void restart()}
          disabled={!runId || restartBusy}
        >
          {restartBusy ? "Restarting…" : "Restart"}
        </Button>
      ) : null}
      <Button variant="outline" onClick={() => runId && actions.resumeRun({ runId })} disabled={!runId}>
        Resume
      </Button>
      <Button variant="outline" onClick={() => setPauseRequested(true)} disabled={!runId || pauseRequested}>
        Pause
      </Button>
      <Button variant="destructive" onClick={() => runId && actions.cancelRun({ runId })} disabled={!runId}>
        Cancel
      </Button>
      {onClose ? (
        <Button variant="outline" data-testid="oneshot-surface-close" onClick={onClose}>
          Close
        </Button>
      ) : null}
    </>
  );

  const terminalHeight = maximized ? 560 : 380;
  const body: ReactNode = !runId ? (
    <EmptyState title="No run selected" description="Open this surface with a run ID." />
  ) : (
    <>
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
      <NarratorLane
        runId={runId}
        running={running}
        now={now}
        labelPrefix={workflowName === "chat" ? "Live status" : "Cheap narrator"}
        available={narratorAvailable}
      />
      <Tabs value={tab} onValueChange={(value) => setTab(value as OneshotSurfaceTab)}>
        <TabsList>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="diff" count={filesChanged}>
            Diff
          </TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="terminal" count={candidates.length}>
            Terminal
          </TabsTrigger>
        </TabsList>
        <TabsContent value="chat">
          <NodeChatStream
            runId={runId}
            nodeId={primaryNodeId}
            title={primaryNodeId === "implement" ? "Implement" : primaryNodeId}
            height={terminalHeight}
          />
          {hasReview ? <NodeChatStream runId={runId} nodeId="review" title="Review" height={320} /> : null}
          {oneshotControls ? (
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
                  statusText={
                    controlError
                      ? controlError
                      : steerDelivery === "idle"
                        ? "Claude Code: interrupt at an event boundary, append the message, then resume."
                        : `Delivery: ${steerDelivery}`
                  }
                />
              </CardContent>
            </Card>
          ) : null}
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
          <RunEventLog runId={runId} style={{ height: terminalHeight }} />
        </TabsContent>
        <TabsContent value="terminal">
          <HijackPanel
            runId={runId}
            candidates={candidates}
            nodeId={target}
            onSelect={setTarget}
            height={terminalHeight}
          />
        </TabsContent>
      </Tabs>
    </>
  );

  const shell = (
    <>
      <style>{SURFACE_STYLES}</style>
      <WorkflowUiShell title={surfaceTitle} meta={<StatusPill status={status} />} actions={controls}>
        {body}
      </WorkflowUiShell>
    </>
  );

  if (variant === "standalone") {
    return (
      <div className={className} style={style} data-testid={testId}>
        {shell}
      </div>
    );
  }

  if (variant === "embedded") {
    return (
      <div
        className={`oneshot-surface-embedded${className ? ` ${className}` : ""}`}
        data-maximized={maximized}
        data-testid={testId}
        style={
          maximized
            ? { position: "fixed", inset: 0, zIndex: 60, background: theme.bg, overflow: "auto", ...style }
            : style
        }
      >
        {shell}
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose?.()}>
      <DialogContent
        showCloseButton={false}
        className={`oneshot-surface-panel${className ? ` ${className}` : ""}`}
        data-maximized={maximized}
        data-testid={testId}
        onEscapeKeyDown={(event) => {
          if (!maximized) return;
          event.preventDefault();
          setMaximized(false);
        }}
        style={
          maximized
            ? {
                top: 0,
                left: 0,
                transform: "none",
                maxWidth: "none",
                maxHeight: "none",
                padding: 0,
                ...style,
              }
            : { maxWidth: "none", maxHeight: "none", padding: 0, ...style }
        }
      >
        <DialogTitle style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          {surfaceTitle}
        </DialogTitle>
        {shell}
      </DialogContent>
    </Dialog>
  );
}

export default OneshotSurface;
