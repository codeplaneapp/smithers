import { create } from "zustand";
import { AUTH_REFACTOR_FRAMES, GATE_FRAME } from "./authRefactorFrames";
import type { Run } from "./Run";

export type RunGate = "none" | "pending" | "approved" | "denied";

export type RunState = {
  id: string;
  title: string;
  model: string;
  runId: string;
  startedAtMs: number;
  frame: number;
  /** Furthest frame the heartbeat has reached. Scrubbing moves `frame` back to
   *  view history; `maxFrame` stays put, so the timeline can tell "historical"
   *  (frame < maxFrame) from "live" and offer Return-to-live. */
  maxFrame: number;
  gate: RunGate;
  note?: string;
  /** Scrubbed via time-travel — auto-advance leaves it alone. */
  paused?: boolean;
  canceled?: boolean;
};

export type Approval = {
  runId: string;
  title: string;
  gate: string;
  status: "pending" | "approved" | "denied";
  note?: string;
};

/**
 * The engine seam: run state plus the actions that mutate it. Derived views
 * (`getRun`, `getApproval`) live in selectors, not here, so subscribing to a run
 * never returns a fresh object every render. Cards and surfaces read this store
 * directly and compose it with `selectRun`/`selectApproval` themselves.
 */
export type EngineApi = {
  runs: RunState[];
  getRun: (id: string) => Run | undefined;
  getApproval: (runId: string) => Approval | undefined;
  launch: (title?: string) => string;
  approve: (runId: string, note?: string) => void;
  deny: (runId: string, note?: string) => void;
  cancel: (runId: string) => void;
  /** Resume a failed/cancelled run: clear the stop flag and let it advance. */
  resume: (runId: string) => void;
  /** Time-travel: preview a past frame (pauses auto-advance for that run). */
  scrub: (runId: string, frame: number) => void;
  /** Explicitly pause or unpause auto-advance (the timeline Play/Pause toggle). */
  setPaused: (runId: string, paused: boolean) => void;
  /** Snap back to the furthest frame reached and unpause (Return to live). */
  returnToLive: (runId: string) => void;
  /** Step the viewed frame by ±1 (pauses, like scrub). */
  step: (runId: string, delta: number) => void;
  /** Destructive rewind: drop frames after `frame` and resume from there. */
  rewindTo: (runId: string, frame: number) => void;
  /** Branch a new run from the current frame. */
  fork: (runId: string) => string | undefined;
};

export type RunsState = Omit<EngineApi, "getRun" | "getApproval">;

const LAST_FRAME = AUTH_REFACTOR_FRAMES.length - 1;
let seq = 4820;

/**
 * Legacy local run controls on the `ephemeral` medium. Real workflow launches
 * and status now come from the gateway run tree; this store remains only for
 * older inspector/timeline actions and never fabricates elapsed progress.
 */
export const useRunsStore = create<RunsState>((set, get) => {
  function patch(id: string, next: Partial<RunState>): void {
    set((state) => ({
      runs: state.runs.map((run) => (run.id === id ? { ...run, ...next } : run)),
    }));
  }

  return {
    runs: [],
    launch: (title = "Local run unavailable") => {
      seq += 1;
      const runId = String(seq);
      const id = `run-${runId}`;
      set((state) => ({
        runs: [
          ...state.runs,
          {
            id,
            title,
            model: "gateway",
            runId,
            startedAtMs: Date.now(),
            frame: 0,
            maxFrame: 0,
            gate: "none",
          },
        ],
      }));
      return id;
    },
    approve: (runId, note) => patch(runId, { gate: "approved", note }),
    deny: (runId, note) => patch(runId, { gate: "denied", note }),
    cancel: (runId) => patch(runId, { canceled: true }),
    resume: (runId) =>
      set((state) => ({
        runs: state.runs.map((run) =>
          run.id === runId
            ? {
                ...run,
                canceled: false,
                paused: false,
                gate: run.gate === "denied" ? "approved" : run.gate,
              }
            : run,
        ),
      })),
    scrub: (runId, frame) =>
      patch(runId, {
        frame: Math.max(0, Math.min(LAST_FRAME, frame)),
        paused: true,
      }),
    setPaused: (runId, paused) => patch(runId, { paused }),
    returnToLive: (runId) => {
      const run = get().runs.find((entry) => entry.id === runId);
      if (!run) return;
      patch(runId, { frame: run.maxFrame, paused: false });
    },
    step: (runId, delta) => {
      const run = get().runs.find((entry) => entry.id === runId);
      if (!run) return;
      patch(runId, {
        frame: Math.max(0, Math.min(LAST_FRAME, run.frame + delta)),
        paused: true,
      });
    },
    rewindTo: (runId, frame) => {
      const clamped = Math.max(0, Math.min(LAST_FRAME, frame));
      patch(runId, {
        frame: clamped,
        maxFrame: clamped,
        paused: false,
        canceled: false,
        // Re-arm the gate to match where the truncated head now sits, so the
        // heartbeat keeps advancing (mirrors fork's gate logic).
        gate: clamped < GATE_FRAME ? "none" : clamped > GATE_FRAME ? "approved" : "pending",
      });
    },
    fork: (runId) => {
      let forkedId: string | undefined;
      set((state) => {
        const source = state.runs.find((run) => run.id === runId);
        if (!source) {
          return state;
        }
        seq += 1;
        const newRunId = String(seq);
        forkedId = `run-${newRunId}`;
        // Match the fork's gate to where it starts, so the heartbeat keeps it
        // moving: before the gate it advances to it, at the gate it waits for
        // approval, past the gate it continues. A flat "none" would strand a
        // fork taken at or past the gate frame.
        const forkGate: RunGate =
          source.frame < GATE_FRAME ? "none" : source.frame > GATE_FRAME ? "approved" : "pending";
        return {
          runs: [
            ...state.runs,
            {
              ...source,
              id: forkedId,
              runId: newRunId,
              title: `${source.title} (fork)`,
              maxFrame: source.frame,
              gate: forkGate,
              paused: false,
              canceled: false,
              startedAtMs: Date.now(),
            },
          ],
        };
      });
      return forkedId;
    },
  };
});
