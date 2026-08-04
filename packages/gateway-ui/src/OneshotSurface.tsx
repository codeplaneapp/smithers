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
 * renders through the shared `@smthrs/ui` terminal adapter:
 * binary frames are raw PTY bytes both ways, text frames are JSON control
 * messages (`resize` up, `exit`/`error` down).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  useGatewayActions,
  useGatewayNodeEvents,
  useGatewayRpc,
  useGatewayRunEvents,
  useGatewayRun,
  useGatewayRunDiff,
  useSmithersGateway,
} from "@smthrs/gateway-react";
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
} from "@smthrs/ui";
import { PierreDiffView } from "@smthrs/ui/adapters/pierre-diff-view";
import { HijackTerminal } from "./HijackTerminal";
import { NodeChatStream } from "./NodeChatStream";
import { RunEventLog } from "./RunEventLog";
import { StatusPill } from "./StatusPill";
import { WorkflowUiShell } from "./styleguide";
import { theme } from "./theme";
import {
  hijackActionFor,
  hijackCandidateForNode,
  hijackCandidatesOf,
  type HijackCandidate,
  type HijackStatus,
} from "./hijack";

export { HijackTerminal, type HijackTerminalProps } from "./HijackTerminal";

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
// Trailing debounce for live diff refreshes: agent edits arrive in bursts of
// run events, so refetch once the burst settles instead of polling tightly.
const LIVE_DIFF_REFETCH_DEBOUNCE_MS = 1500;
// Keep request cancellation paired with the fetch implementation captured by
// the Gateway client. Test/browser hosts may replace DOM globals after modules
// load (happy-dom does); mixing constructors produces an invalid AbortSignal.
const RuntimeAbortController = globalThis.AbortController;
const EMPTY_HIJACK_CANDIDATES: HijackCandidate[] = [];

const SURFACE_STYLES = `
@keyframes oneshot-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.75); } }
.oneshot-status-dot { width: 8px; height: 8px; border-radius: 9999px; flex: none; background: ${theme.success}; }
.oneshot-status-dot[data-live="true"] { animation: oneshot-pulse 1.6s ease-in-out infinite; }
.oneshot-status-text { transition: opacity 200ms ease; }
.oneshot-surface-panel { display: flex; flex-direction: column; min-height: 0; overflow: auto; width: min(1200px, 96vw); height: min(820px, 92vh); border: 1px solid ${theme.border}; border-radius: 12px; background: ${theme.bg}; }
.oneshot-surface-panel[data-maximized="true"] { width: 100vw; height: 100vh; border-radius: 0; border: 0; }
.oneshot-surface-embedded { display: flex; flex-direction: column; min-height: 0; }
`;

type HijackCandidatesStore = {
  candidates: HijackCandidate[];
  subscribe(listener: () => void, live: boolean): () => void;
};

export type SingleFlightPoller = {
  pollNow(): void;
  setActive(active: boolean): void;
  dispose(): void;
};

/** Poll only after the previous request settles, and abort it on disposal. */
export function createSingleFlightPoller(
  task: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
): SingleFlightPoller {
  const controller = new RuntimeAbortController();
  let active = false;
  let disposed = false;
  let inflight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const scheduleNext = () => {
    if (!active || disposed || inflight || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, intervalMs);
  };
  const run = async () => {
    if (disposed || inflight) return;
    inflight = true;
    try {
      await task(controller.signal);
    } catch {
      // Poll failures are transient; the next serialized attempt may recover.
    } finally {
      inflight = false;
      scheduleNext();
    }
  };

  return {
    pollNow() {
      if (disposed || inflight) return;
      clearTimer();
      void run();
    },
    setActive(nextActive) {
      active = nextActive;
      if (!active) clearTimer();
      else scheduleNext();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      clearTimer();
      controller.abort();
    },
  };
}

const hijackCandidateStores = new WeakMap<ReturnType<typeof useSmithersGateway>, Map<string, HijackCandidatesStore>>();

function hijackCandidatesStore(gateway: ReturnType<typeof useSmithersGateway>, runId: string): HijackCandidatesStore {
  let stores = hijackCandidateStores.get(gateway);
  if (!stores) {
    stores = new Map();
    hijackCandidateStores.set(gateway, stores);
  }
  const existing = stores.get(runId);
  if (existing) return existing;

  const listeners = new Set<() => void>();
  let liveSubscribers = 0;
  let started = false;
  let disposeTicket: { cancelled: boolean } | undefined;
  const poller = createSingleFlightPoller(async (signal) => {
    try {
      const headers = new Headers(gateway.headers);
      if (gateway.token) headers.set("authorization", `Bearer ${gateway.token}`);
      const response = await gateway.fetchImpl(
        `${gateway.baseUrl}/v1/api/runs/${encodeURIComponent(runId)}/hijack-candidates`,
        { headers, signal },
      );
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (!signal.aborted) {
        store.candidates = hijackCandidatesOf(body);
        listeners.forEach((listener) => listener());
      }
    } catch {
      // Transient fetch failures just keep the previous candidate view.
    }
  }, 5_000);
  const updateTimer = () => {
    poller.setActive(liveSubscribers > 0);
  };
  const store: HijackCandidatesStore = {
    candidates: EMPTY_HIJACK_CANDIDATES,
    subscribe(listener, live) {
      if (disposeTicket) {
        disposeTicket.cancelled = true;
        disposeTicket = undefined;
      }
      listeners.add(listener);
      if (live) liveSubscribers += 1;
      if (!started) {
        started = true;
        poller.pollNow();
      }
      updateTimer();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (live) liveSubscribers -= 1;
        updateTimer();
        if (listeners.size > 0) return;
        const ticket = { cancelled: false };
        disposeTicket = ticket;
        queueMicrotask(() => {
          if (ticket.cancelled || listeners.size > 0) return;
          poller.dispose();
          updateTimer();
          stores!.delete(runId);
        });
      };
    },
  };
  stores.set(runId, store);
  return store;
}

/** Read the shared run-level hijack-candidate poller. */
function useHijackCandidates(runId: string | undefined, live = true): HijackCandidate[] {
  const gateway = useSmithersGateway();
  const store = useMemo(() => (runId ? hijackCandidatesStore(gateway, runId) : undefined), [gateway, runId]);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener, live) ?? (() => {}),
    [store, live],
  );
  return useSyncExternalStore(
    subscribe,
    () => store?.candidates ?? EMPTY_HIJACK_CANDIDATES,
    () => EMPTY_HIJACK_CANDIDATES,
  );
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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers = new Headers(gateway.headers);
  headers.set("content-type", "application/json");
  if (gateway.token) headers.set("authorization", `Bearer ${gateway.token}`);
  const response = await gateway.fetchImpl(
    `${gateway.baseUrl}/v1/api/runs/${encodeURIComponent(runId)}/oneshot-monitor/${action}`,
    { method: "POST", headers, body: JSON.stringify(body), signal },
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
  const liveDiff = Boolean(diff && "live" in diff && diff.live);
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
    const poller = createSingleFlightPoller(async (signal) => {
      try {
        const result = await postOneshotControl(gateway, runId, "attach", {}, signal);
        if (!signal.aborted) setNarratorAvailable(result.narrator !== false);
      } catch {
        if (!signal.aborted) setNarratorAvailable(false);
      }
    }, 15_000);
    poller.setActive(true);
    poller.pollNow();
    return () => poller.dispose();
  }, [gateway, runId, running, oneshotControls]);

  // Live diff: the gateway diffs the run's working copy while the run is
  // live, so refresh on run events (trailing-debounced — edits arrive in
  // bursts) rather than a tight poll, and once more on the terminal
  // transition to land the authoritative base-to-terminal snapshot.
  const diffRefetch = diffState.refetch;
  const diffEventCount = controlEvents.events.length;
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => void diffRefetch(), LIVE_DIFF_REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [running, diffEventCount, diffRefetch]);
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (wasRunningRef.current && !running) void diffRefetch();
    wasRunningRef.current = running;
  }, [running, diffRefetch]);

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
      <Tabs value={tab} onValueChange={(value: string) => setTab(value as OneshotSurfaceTab)}>
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
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
              {liveDiff ? (
                <span data-testid="oneshot-diff-live" style={{ color: theme.textDim, fontSize: 12 }}>
                  Live working-copy diff — refreshes as the agent edits; the final snapshot lands when the run ends.
                </span>
              ) : null}
              <PierreDiffView
                patch={patch}
                emptyLabel={
                  running
                    ? "No changes yet — the diff appears here as the agent edits files."
                    : "No finished diff is available yet."
                }
              />
            </div>
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
    <Dialog open onOpenChange={(open: boolean) => !open && onClose?.()}>
      <DialogContent
        showCloseButton={false}
        className={`oneshot-surface-panel${className ? ` ${className}` : ""}`}
        data-maximized={maximized}
        data-testid={testId}
        onEscapeKeyDown={(event: KeyboardEvent) => {
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
