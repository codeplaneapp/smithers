import { create } from "zustand";

type ClockState = {
  /** Wall-clock time in ms, refreshed once a second. */
  nowMs: number;
};

/**
 * One app-wide 1-second tick on the `ephemeral` medium. Every live elapsed-time
 * label subscribes to `nowMs` through `useElapsed` instead of running its own
 * interval, so N cards cost one timer, not N. Module-level interval, no effect
 * (mirrors the engine heartbeat in `runsStore`).
 */
export const useClockStore = create<ClockState>(() => ({
  nowMs: Date.now(),
}));

// Tick for the life of the page. A stopped run reads `Date.now()` directly in
// `useElapsed`, so a frozen card never depends on this subscription.
window.setInterval(() => {
  useClockStore.setState({ nowMs: Date.now() });
}, 1000);
