export type AmbiguityOutcome =
  | "duplicate-delivery"
  | "effect-applied-journal-missing"
  | "journal-applied-ack-missing"
  | "lease-lost"
  | "cancellation-race"
  | "restart-in-task"
  | "lost-wakeup";
export type AmbiguityResult = Readonly<{
  readonly outcome: AmbiguityOutcome;
  readonly guaranteed: "journal-cas-only" | "at-least-once";
  readonly details: Readonly<Record<string, unknown>>;
}>;
export const ambiguity = (outcome: AmbiguityOutcome, details: Record<string, unknown> = {}): AmbiguityResult =>
  Object.freeze({
    outcome,
    guaranteed: outcome === "journal-applied-ack-missing" ? "journal-cas-only" : "at-least-once",
    details: Object.freeze({ ...details }),
  });
