export interface SkewClockHandle {
  now: () => number;
  advance: (ms: number) => void;
  restore: () => void;
}

// Process-local: monkey-patches Date.now (and Date itself, so `new Date()` uses
// the same skew) in this process only. A child process spawned via spawnSync
// will not see the skew — those need a separate injection (env var / harness
// flag) which is out of scope for this primitive.
export function skewClock(skewMs: number): SkewClockHandle {
  const originalNow = Date.now;
  const OriginalDate = Date;
  let skew = skewMs;
  let restored = false;

  const now = (): number => originalNow.call(OriginalDate) + skew;

  // Wrapper Date class so `new Date()` (no args) reflects the skew, while
  // Date(arg) and static methods still delegate to the original.
  class SkewedDate extends OriginalDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) {
        super(now());
        return;
      }
      super(...args);
    }
  }
  SkewedDate.now = now;

  OriginalDate.now = now;
  (globalThis as { Date: typeof Date }).Date = SkewedDate as unknown as typeof Date;

  const advance = (ms: number): void => {
    skew += ms;
  };

  const restore = (): void => {
    if (restored) return;
    restored = true;
    OriginalDate.now = originalNow;
    (globalThis as { Date: typeof Date }).Date = OriginalDate;
  };

  return { now, advance, restore };
}
