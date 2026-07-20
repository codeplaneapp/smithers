import { useClockStore } from "./clockStore";

/** Format a millisecond duration as "2m14s" / "8s" / "1h03m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}h${String(m).padStart(2, "0")}m`;
  }
  if (m > 0) {
    return `${m}m${String(s).padStart(2, "0")}s`;
  }
  return `${s}s`;
}

/**
 * A live elapsed-time label that ticks once a second while `running`, off the
 * shared clock store. Frozen at the final value once the run stops, so finished
 * cards don't keep counting. While stopped the selector is constant, so the card
 * never re-renders on the tick and reads the clock once during render.
 */
export function useElapsed(startedAtMs: number, running: boolean): string {
  const tick = useClockStore((state) => (running ? state.nowMs : 0));
  return formatElapsed((running ? tick : Date.now()) - startedAtMs);
}
