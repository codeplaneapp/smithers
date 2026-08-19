/**
 * The waiting classification a run declares immediately before it suspends.
 *
 * Structurally identical to `@flows/flow`'s `FlowRuntime.WaitingAnnotation`
 * (`packages/flow/src/FlowRuntime/WaitingAnnotation.ts` in the flows tree), so
 * the same value can be handed to `FlowRuntime.annotateWaiting` without a
 * translation step. Stage 1.4 of `.smithers/specs/flows-migration.md` replaces
 * `engine.js`'s inline per-reason waiting states with this one open taxonomy.
 */
export type WaitingAnnotation = {
  readonly reason: WaitingReason;
  /** Absolute epoch-ms deadline a wake sweep compares against. */
  readonly wakeAt?: number;
  /** Compare-and-swap material a wake handler matches against. */
  readonly token?: string;
};

/**
 * The supervisor vocabulary. `released` marks a run whose owning process let
 * it go without settling it (shutdown, heartbeat self-interrupt): it holds no
 * lease and carries no `wakeAt`, so a sweep has to scan for the reason itself.
 */
export type WaitingReason = "approval" | "event" | "timer" | "quota" | "released";
