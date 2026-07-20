const TERMINAL = new Set(["finished", "failed", "errored", "cancelled"]);

/**
 * Whether a run has reached a final state. `waiting-quota` is NOT terminal: a
 * run parked on the 5-hour limit is still in flight and will auto-resume at its
 * reset, so the fleet must keep supervising it, not count it done.
 */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}
