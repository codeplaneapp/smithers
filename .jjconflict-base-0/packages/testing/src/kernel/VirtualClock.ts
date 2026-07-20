export type Timer = Readonly<{ readonly id: number; readonly at: number; readonly callback: () => void }>;
export class VirtualClock {
  private current = 0;
  private nextId = 0;
  private timers: Timer[] = [];
  now(): number { return this.current; }
  sleep(ms: number, callback: () => void): number { if (!Number.isFinite(ms) || ms < 0) throw new RangeError("virtual sleep requires a finite non-negative duration"); const timer = { id: this.nextId++, at: this.current + ms, callback }; this.timers.push(timer); this.timers.sort((a, b) => a.at - b.at || a.id - b.id); return timer.id; }
  cancel(id: number): void { this.timers = this.timers.filter((timer) => timer.id !== id); }
  advance(ms: number): void { if (!Number.isFinite(ms) || ms < 0) throw new RangeError("virtual clock can only advance forwards"); this.current += ms; this.flush(); }
  advanceToNextTimer(): boolean { const timer = this.timers[0]; if (!timer) return false; this.current = Math.max(this.current, timer.at); this.flush(); return true; }
  runUntilIdle(limit = 10_000): void { if (!Number.isInteger(limit) || limit < 1) throw new RangeError("virtual-time limit must be a positive integer"); let steps = 0; while (this.timers.length) { const timer = this.timers[0]!; this.current = Math.max(this.current, timer.at); while (this.timers[0]?.at <= this.current) { if (++steps > limit) throw Object.assign(new Error("VIRTUAL_TIME_BUDGET_EXHAUSTED: virtual-time callback budget exhausted"), { code: "VIRTUAL_TIME_BUDGET_EXHAUSTED", details: { limit, now: this.current } }); this.timers.shift()?.callback(); } } }
  pending(): readonly Timer[] { return [...this.timers]; }
  clear(): void { this.timers = []; }
  private flush(): void { let steps = 0; while (this.timers[0]?.at <= this.current) { if (++steps > 10_000) throw Object.assign(new Error("virtual-time callback budget exhausted"), { code: "VIRTUAL_TIME_BUDGET_EXHAUSTED" }); this.timers.shift()?.callback(); } }
}
