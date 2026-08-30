/**
 * Moving this process's wall clock.
 *
 * Durable waits are recorded as absolute instants, so the only way to test what
 * a restarted host does with a timer that has already come due is to move the
 * clock the host reads. The skew is process-local: a child process spawned by a
 * test does not inherit it, which is why the child runner takes an explicit
 * skew argument instead.
 *
 * @since 1.0.0
 */

/**
 * A live clock skew.
 *
 * @since 1.0.0
 * @category models
 */
export interface SkewedClock {
  /** The skewed instant, in milliseconds. */
  readonly now: () => number
  /** Moves the skew further forward. */
  readonly advance: (ms: number) => void
  /** Puts the real clock back. Idempotent. */
  readonly restore: () => void
}

/**
 * Skews `Date.now` and bare `new Date()` by `skewMs` for this process.
 *
 * @since 1.0.0
 * @category constructors
 */
export const skewClock = (skewMs: number): SkewedClock => {
  const OriginalDate = globalThis.Date
  const originalNow = OriginalDate.now
  let skew = skewMs
  let restored = false

  const now = (): number => originalNow.call(OriginalDate) + skew

  class SkewedDate extends OriginalDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) super(now())
      else super(...args)
    }
    static override now = now
  }

  OriginalDate.now = now
  ;(globalThis as { Date: typeof Date }).Date = SkewedDate as unknown as typeof Date

  return {
    now,
    advance: (ms) => {
      skew += ms
    },
    restore: () => {
      if (restored) return
      restored = true
      OriginalDate.now = originalNow
      ;(globalThis as { Date: typeof Date }).Date = OriginalDate
    }
  }
}
