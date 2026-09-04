/*
 * Launch checklist (U7) — the shared vocabulary.
 *
 * The runner drives the signed-in checklist (§A-F) headlessly against an
 * explicit target origin. Two probe kinds share one context:
 *
 *  - HTTP probes call the target's client-facing seams with `ctx.fetch`.
 *  - Browser probes ask `ctx.page(cookie)` for a real headless page on the
 *    target and assert against the rendered document. The page is an
 *    interface, not a concrete driver, so the row catalog is unit-testable
 *    without launching a browser (the CDP-backed implementation lives in
 *    scripts/headless-page.ts).
 */

export type Section = "A" | "B" | "C" | "D" | "E" | "F"

export type Status = "pass" | "fail" | "not-testable-yet" | "skipped-dry-run"

/** Thrown by a page factory that has no browser to drive. Rows report not-testable-yet, never fail. */
export class BrowserUnavailableError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "BrowserUnavailableError"
  }
}

/** A live headless page on the target origin, already carrying the session cookie it was opened with. */
export interface ProbePage {
  /** `document.body.innerText` as the user would read it. */
  text(): Promise<string>
  /** Evaluate an expression in the page and return its JSON value. Rejects on a page exception. */
  evaluate<T = unknown>(expression: string): Promise<T>
  /** Type literal characters into the focused element with real key events. */
  type(text: string): Promise<void>
  /** Press one named key ("Enter", "Escape", "Tab", "/") with real key events. */
  press(key: string): Promise<void>
  /** Reload the page, as closing and reopening the browser would. */
  reload(): Promise<void>
}

export interface ProbeContext {
  readonly target: string
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * A headless page on the target, authenticated with `cookie` (a cookie
   * header string, or undefined for a signed-out page). Pages are cached per
   * cookie for the run. Rejects with `BrowserUnavailableError` when no
   * browser can be driven.
   */
  page(cookie: string | undefined): Promise<ProbePage>
  fetch(url: string, init?: RequestInit): Promise<Response>
  /** Monotonic-enough clock, injected so probes' timing assertions are testable. */
  now(): number
  sleep(ms: number): Promise<void>
}

export interface ProbeResult {
  readonly status: "pass" | "fail" | "not-testable-yet"
  readonly detail: string
}

export interface ChecklistRow {
  readonly id: string
  readonly section: Section
  readonly title: string
  /** Env vars this row needs before it can run for real; missing ones report not-testable-yet. */
  readonly requiredEnv?: ReadonlyArray<string>
  /** True when the probe drives a headless page (so a run without a browser can say so precisely). */
  readonly browser?: boolean
  /**
   * State this row must undo before it can grade anything — the account is the
   * fixture, and a previous run left marks on it. Its returned line is recorded
   * as evidence so the report says what was reset.
   *
   * A prepare step is best-effort by construction: it may not have the rights
   * (the checklist session need not be an admin), and a row whose preparation
   * did not happen still runs and still reports honestly. So it never fails a
   * row — the reason lands in the evidence instead.
   */
  readonly prepare?: (ctx: ProbeContext) => Promise<string>
  /** Every row has one. A row with no probe is a row this runner does not actually check. */
  readonly probe: (ctx: ProbeContext) => Promise<ProbeResult>
}

export interface RowResult {
  readonly id: string
  readonly section: Section
  readonly title: string
  readonly status: Status
  readonly reasons: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<string>
  readonly durationMs: number
  readonly tests: ReadonlyArray<string>
  /**
   * True when the PROBE returned not-testable-yet in a real run — the row
   * ran and still decided nothing. Missing env and a missing browser are
   * capability gaps and stay green; a probe that punted is an incomplete
   * check, and in run mode it fails the command (see exitCodeFor).
   */
  readonly undecidedInProbe?: boolean
}

export interface Totals {
  readonly pass: number
  readonly fail: number
  readonly notTestableYet: number
  /** Rows whose probe ran and still decided nothing (subset of notTestableYet). */
  readonly probeUndecided: number
  readonly skippedDryRun: number
}

export interface ChecklistReport {
  readonly generatedAt: string
  readonly mode: "dry-run" | "run"
  readonly target: string | null
  readonly totals: Totals
  readonly rows: ReadonlyArray<RowResult>
}
