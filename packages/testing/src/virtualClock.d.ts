/// <reference path="../types/bun-test-shim.d.ts" />
/**
 * Virtual clock for deterministic agent-trace simulation.
 * Default mode advances time without real wall-clock sleeps so CI stays fast.
 */
type VirtualClockMode = "virtual" | "real";
type VirtualClock = {
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
type CreateVirtualClockOptions = {
    mode?: VirtualClockMode;
    /** Starting time for virtual mode. Default 0. */
    startMs?: number;
};
/**
 * Create a clock. Virtual mode never waits on the wall clock.
 */
declare function createVirtualClock(options?: CreateVirtualClockOptions): VirtualClock;

export { type CreateVirtualClockOptions, type VirtualClock, type VirtualClockMode, createVirtualClock };
