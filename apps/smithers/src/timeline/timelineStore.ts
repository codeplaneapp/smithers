import { create } from "zustand";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import { GATE_FRAME } from "../runs/authRefactorFrames";
import { useRunsStore } from "../runs/runsStore";
import { selectRun } from "../runs/selectRun";
import { clampFrame, frameLabel } from "./timeline";

/**
 * The scrubber's UI store. It owns nothing the engine already owns — the viewed
 * frame, the live/paused flag, and the timeline truncation all live in
 * `runsStore`, and this store's actions delegate to it (scrub/setPaused/
 * returnToLive/step/rewindTo/fork). What it does own is the bits the engine has
 * no concept of: a debounce buffer so dragging the slider across many frames
 * coalesces to the last target (a module-level timer, mirroring clockStore's
 * pattern, not a per-component effect), the destructive-rewind confirm flag, and
 * the mock error banner. Side-effects echo through chat + a transient toast, the
 * same shape vcsStore/issuesStore use, since this PWA has no gateway.
 */

/** The error banner's payload; `retriable` gates the Retry button. */
export type TimelineError = {
  message: string;
  hint?: string;
  retriable: boolean;
};

type TimelineState = {
  /** The latest scrub target awaiting flush; null when no scrub is pending. */
  pendingFrame: number | null;
  /** True while the destructive-rewind confirm row is shown. */
  confirmingRewind: boolean;
  /** The current scrub/rewind error banner, or null. */
  error: TimelineError | null;
  scrubTo: (runId: string, frame: number) => void;
  step: (runId: string, delta: number) => void;
  jumpToStart: (runId: string) => void;
  jumpToEnd: (runId: string) => void;
  play: (runId: string) => void;
  pause: (runId: string) => void;
  togglePlay: (runId: string) => void;
  returnToLive: (runId: string) => void;
  requestRewind: (runId: string, frame: number) => void;
  cancelRewind: () => void;
  confirmRewind: (runId: string, frame: number) => void;
  fork: (runId: string) => void;
  replay: (runId: string) => void;
  setError: (error: TimelineError) => void;
  clearError: () => void;
  /** Re-issue the last failed action; only meaningful for a retriable error. */
  retry: (runId: string) => void;
};

// The latest frame the run reached, for clamping. Pure read off the engine.
function latestFrameOf(runId: string): number {
  const run = selectRun(useRunsStore.getState().runs, runId);
  return run ? run.frameCount - 1 : 0;
}

function currentFrameOf(runId: string): number {
  const run = selectRun(useRunsStore.getState().runs, runId);
  return run ? run.frame : 0;
}

// The debounce buffer lives at module scope, exactly like clockStore's interval
// handle: a timer is not something a component renders, and a module timer means
// the coalescing survives re-renders with zero useEffect. We remember the last
// runId so the flush targets the same run the user was dragging.
let scrubTimer: number | null = null;
let scrubRunId: string | null = null;
const SCRUB_DEBOUNCE_MS = 50;

function flushScrub(): void {
  scrubTimer = null;
  const runId = scrubRunId;
  scrubRunId = null;
  const frame = useTimelineStore.getState().pendingFrame;
  useTimelineStore.setState({ pendingFrame: null });
  if (runId === null || frame === null) return;
  useRunsStore.getState().scrub(runId, frame);
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  pendingFrame: null,
  confirmingRewind: false,
  error: null,

  scrubTo: (runId, frame) => {
    const target = clampFrame(frame, latestFrameOf(runId));
    // Buffer the target and (re)arm the module timer; rapid drags coalesce to
    // the last frame instead of thrashing the engine on every pointer move.
    set({ pendingFrame: target });
    scrubRunId = runId;
    if (scrubTimer !== null) {
      window.clearTimeout(scrubTimer);
    }
    scrubTimer = window.setTimeout(flushScrub, SCRUB_DEBOUNCE_MS);
  },

  step: (runId, delta) => {
    // Stepping is discrete and always pauses; go straight through the engine so
    // arrow keys feel immediate, bypassing the drag debounce.
    if (scrubTimer !== null) {
      window.clearTimeout(scrubTimer);
      scrubTimer = null;
    }
    set({ pendingFrame: null });
    useRunsStore.getState().step(runId, delta);
  },

  jumpToStart: (runId) => get().scrubTo(runId, 0),

  jumpToEnd: (runId) => get().scrubTo(runId, latestFrameOf(runId)),

  play: (runId) => {
    // Resume the heartbeat from the latest reached frame: returnToLive both
    // snaps the head forward and clears the paused flag in one engine call.
    useRunsStore.getState().returnToLive(runId);
  },

  pause: (runId) => {
    useRunsStore.getState().setPaused(runId, true);
  },

  togglePlay: (runId) => {
    const run = useRunsStore.getState().runs.find((entry) => entry.id === runId);
    if (!run) return;
    if (run.paused) get().play(runId);
    else get().pause(runId);
  },

  returnToLive: (runId) => {
    if (scrubTimer !== null) {
      window.clearTimeout(scrubTimer);
      scrubTimer = null;
    }
    set({ pendingFrame: null });
    useRunsStore.getState().returnToLive(runId);
  },

  requestRewind: (runId, frame) => {
    void runId;
    void frame;
    set({ confirmingRewind: true });
  },

  cancelRewind: () => set({ confirmingRewind: false }),

  confirmRewind: (runId, frame) => {
    const target = clampFrame(frame, latestFrameOf(runId));
    // Truncate the timeline to `target` and resume from there. The engine drops
    // every frame past it and re-arms the gate, so the heartbeat keeps moving.
    useRunsStore.getState().rewindTo(runId, target);
    set({ confirmingRewind: false, error: null });
    const chat = useChatStore.getState();
    const notify = useNotificationsStore.getState().notify;
    chat.say(
      `Rewound the run to frame ${target} (${frameLabel(target)}); dropped every later frame and resumed from there.`,
    );
    notify({
      title: "Run rewound",
      detail: `frame ${target} · ${frameLabel(target)}`,
      kind: "transient",
      command: "chat",
    });
  },

  fork: (runId) => {
    const frame = currentFrameOf(runId);
    const forkedId = useRunsStore.getState().fork(runId);
    if (!forkedId) return;
    useChatStore
      .getState()
      .postCard(
        { kind: "run", runId: forkedId },
        `Forked a new run from frame ${frame} (${frameLabel(frame)}).`,
      );
    useNotificationsStore.getState().notify({
      title: "Run forked",
      detail: `from frame ${frame}`,
      kind: "transient",
      command: "chat",
    });
  },

  replay: (runId) => {
    const run = selectRun(useRunsStore.getState().runs, runId);
    if (!run) return;
    useChatStore
      .getState()
      .say(`Replaying run ${run.runId} from frame ${run.frame} (${frameLabel(run.frame)})…`);
  },

  setError: (error) => set({ error }),

  clearError: () => set({ error: null }),

  retry: (runId) => {
    const { error } = get();
    if (!error || !error.retriable) return;
    // The mock retry re-issues a return-to-live, the safe "get back on track"
    // action; a real engine would replay the failed scrub/rewind verbatim.
    set({ error: null });
    get().returnToLive(runId);
    useChatStore.getState().say("Retried the timeline action — back on the live frame.");
  },
}));

/** The deploy-gate frame, re-exported for the canvas tick + auto-pause copy. */
export { GATE_FRAME };
