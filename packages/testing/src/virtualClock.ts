/**
 * Virtual clock for deterministic agent-trace simulation.
 * Default mode advances time without real wall-clock sleeps so CI stays fast.
 */

export type VirtualClockMode = "virtual" | "real";

export type VirtualClock = {
  readonly mode: VirtualClockMode;
  /** Current simulated (or real) epoch ms. */
  now(): number;
  /** Advance the clock by `ms` (virtual) or sleep (real). */
  advance(ms: number): Promise<void>;
  /** Alias for advance — agent stream delays call this. */
  sleep(ms: number): Promise<void>;
  /** Reset to an absolute epoch (virtual only; ignored in real mode). */
  setNow(ms: number): void;
};

export type CreateVirtualClockOptions = {
  mode?: VirtualClockMode;
  /** Starting time for virtual mode. Default 0. */
  startMs?: number;
};

/**
 * Create a clock. Virtual mode never waits on the wall clock.
 */
export function createVirtualClock(options: CreateVirtualClockOptions = {}): VirtualClock {
  const mode: VirtualClockMode = options.mode === "real" ? "real" : "virtual";
  let current = typeof options.startMs === "number" && Number.isFinite(options.startMs) ? options.startMs : 0;

  async function advance(ms: number) {
    const n = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (mode === "real") {
      if (n > 0) {
        await new Promise((r) => setTimeout(r, n));
      }
      return;
    }
    current += n;
  }

  return {
    mode,
    now() {
      return mode === "real" ? Date.now() : current;
    },
    advance,
    sleep: advance,
    setNow(ms: number) {
      if (mode === "virtual" && typeof ms === "number" && Number.isFinite(ms)) {
        current = ms;
      }
    },
  };
}
