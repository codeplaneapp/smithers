/** @jsxImportSource react */
/**
 * `<RunSurface>` — the one live surface for a single run.
 *
 * Status KPIs, the primary node's chat stream, the run diff, the event log,
 * and the PTY hijack capability as a first-class tab instead of a
 * monitor-only modal. Two hosts render the exact same component:
 *
 * - standalone, as a run's own UI (`smithers ui` for the auto-hijacked runs
 *   `smithers chat-create` makes),
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
  Dialog,
  DialogContent,
  DialogDescription,
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

export type RunSurfaceTab = "chat" | "diff" | "events" | "terminal";

export type RunSurfaceProps = {
  /** Run to render. Omit to show the "no run selected" empty state. */
  runId?: string;
  /**
   * How the surface is hosted. `standalone` fills the page (workflow UI),
   * `embedded` renders inline inside a host panel, `overlay` renders as a
   * dismissable dialog over the host (the Monitor's hijack affordance).
   */
  variant?: "standalone" | "embedded" | "overlay";
  /** Tab shown first. Hosts that open the surface to hijack pass `terminal`. */
  initialTab?: RunSurfaceTab;
  /** Node whose recorded session the terminal attaches to first. */
  hijackNodeId?: string;
  /** Header title. Defaults to the run's workflow name. */
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

// Trailing debounce for live diff refreshes: agent edits arrive in bursts of
// run events, so refetch once the burst settles instead of polling tightly.
const LIVE_DIFF_REFETCH_DEBOUNCE_MS = 1500;
// Keep request cancellation paired with the fetch implementation captured by
// the Gateway client. Test/browser hosts may replace DOM globals after modules
// load (happy-dom does); mixing constructors produces an invalid AbortSignal.
const RuntimeAbortController = globalThis.AbortController;
const EMPTY_HIJACK_CANDIDATES: HijackCandidate[] = [];

const SURFACE_STYLES = `
.run-surface-panel { display: flex; flex-direction: column; min-height: 0; overflow: auto; width: min(1200px, 96vw); height: min(820px, 92vh); border: 1px solid ${theme.border}; border-radius: 12px; background: ${theme.bg}; }
.run-surface-panel[data-maximized="true"] { width: 100vw; height: 100vh; border-radius: 0; border: 0; }
.run-surface-embedded { display: flex; flex-direction: column; min-height: 0; }
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

function elapsedLabel(startedAtMs: number | undefined, finishedAtMs: number | undefined, now: number) {
  if (!startedAtMs) return "Not started";
  const seconds = Math.max(0, Math.floor(((finishedAtMs ?? now) - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
            data-testid="run-surface-hijack-target"
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

export function RunSurface({
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
}: RunSurfaceProps) {
  const runState = useGatewayRun(runId);
  const diffState = useGatewayRunDiff({ runId });
  const actions = useGatewayActions();
  const [now, setNow] = useState(() => Date.now());
  const [pauseRequested, setPauseRequested] = useState(false);
  const [tab, setTab] = useState<RunSurfaceTab>(initialTab);
  const [maximized, setMaximized] = useState(defaultMaximized);
  const [target, setTarget] = useState(hijackNodeId);
  const runEvents = useGatewayRunEvents(runId, { maxEvents: 200 });
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
  const workflowName =
    typeof run?.workflowName === "string"
      ? run.workflowName
      : typeof run?.workflowKey === "string"
        ? run.workflowKey
        : undefined;
  const surfaceTitle = title ?? (workflowName === "chat" ? "Chat" : (workflowName ?? "Run"));

  // Live diff: the gateway diffs the run's working copy while the run is
  // live, so refresh on run events (trailing-debounced — edits arrive in
  // bursts) rather than a tight poll, and once more on the terminal
  // transition to land the authoritative base-to-terminal snapshot.
  const diffRefetch = diffState.refetch;
  // Key on the last event's seq, not the array length: the events ring is
  // capped (maxEvents), so its length stops changing on a long run and a
  // length-keyed effect would silently stop refreshing the diff.
  const lastDiffEventSeq =
    runEvents.events.length > 0 ? Number(runEvents.events[runEvents.events.length - 1]?.seq ?? 0) : 0;
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => void diffRefetch(), LIVE_DIFF_REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [running, lastDiffEventSeq, diffRefetch]);
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (wasRunningRef.current && !running) void diffRefetch();
    wasRunningRef.current = running;
  }, [running, diffRefetch]);

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
          data-testid="run-surface-maximize"
          aria-pressed={maximized}
          title={maximized ? "Restore this surface" : "Maximize this surface"}
          onClick={() => setMaximized((value) => !value)}
        >
          {maximized ? "⤡ Restore" : "⤢ Maximize"}
        </Button>
      ) : null}
      {hijackAction ? (
        <Button
          data-testid="run-surface-hijack-button"
          onClick={() => {
            setTarget(primaryNodeId);
            setTab("terminal");
          }}
        >
          {hijackAction.label}
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
        <Button variant="outline" data-testid="run-surface-close" onClick={onClose}>
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
      <Tabs value={tab} onValueChange={(value: string) => setTab(value as RunSurfaceTab)}>
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
                <span data-testid="run-surface-diff-live" style={{ color: theme.textDim, fontSize: 12 }}>
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
        className={`run-surface-embedded${className ? ` ${className}` : ""}`}
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
        aria-modal="true"
        className={`run-surface-panel${className ? ` ${className}` : ""}`}
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
        <DialogDescription className="sui-sr-only">
          Interactive run controls, activity, changes, and terminal for {surfaceTitle}.
        </DialogDescription>
        {shell}
      </DialogContent>
    </Dialog>
  );
}

export default RunSurface;
