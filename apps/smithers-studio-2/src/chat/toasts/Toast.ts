import type { Overlay } from "../overlay/Overlay";

/**
 * A toast in the upper-right stack. Two flavors:
 *
 * - **run** toasts mirror a running workflow; COLOR = run state (blue running /
 *   green succeeded / red failed) using the DESIGN.md run-state tokens. They are
 *   clickable into the run (mock: opens an overlay). The frame-driven Monitor
 *   agent owns their state and one-line status (see Product spec §7).
 * - **ephemeral** toasts are neutral, non-run notices (e.g. "switching models
 *   breaks the cache") — never run-state colored, and auto-dismiss.
 */
export type RunState = "running" | "succeeded" | "failed";

export type Toast =
  | {
      kind: "run";
      id: string;
      /** Workflow name shown bold in the toast. */
      workflow: string;
      /** One-line latest status, written by the Monitor agent (mock today). */
      status: string;
      state: RunState;
      /** What clicking the toast opens (mock). */
      overlay: Overlay;
    }
  | {
      kind: "ephemeral";
      id: string;
      /** Neutral notice text; not run-state colored. */
      message: string;
    };
