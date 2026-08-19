/**
 * The injected services at the wait/wake seam.
 *
 * Spec 1.5 of `.smithers/specs/flows-migration.md`: provider quota and
 * transient error classification stays in Smithers, so the hard-won provider
 * quirks never move into an executor. flows' own gap analysis lists exactly
 * this pair — `classifyError` / `resolveRetry` — under "gaps that belong at an
 * injected seam, not in core".
 */

/** Which provider's limit vocabulary produced the failure. */
export type ProviderFamily = "anthropic" | "openai" | "google" | "xai" | "unknown";

export type ErrorClassification =
  | {
      readonly kind: "quota";
      readonly providerFamily: ProviderFamily;
      /** Absolute epoch-ms the provider says the limit resets, when it said so. */
      readonly wakeAt?: number;
      /** Verbatim provider text the deadline was read out of. */
      readonly resetHint?: string;
    }
  | { readonly kind: "transient"; readonly providerFamily: ProviderFamily }
  | { readonly kind: "fatal"; readonly providerFamily: ProviderFamily; readonly code?: string };

export type RetryResolution =
  /** Park on the durable clock and wake when `wakeAt` passes. A quota park never spends a retry. */
  | { readonly action: "park"; readonly reason: "quota"; readonly wakeAt?: number }
  /** Retry in place after `waitMs`. */
  | { readonly action: "retry"; readonly waitMs: number }
  /** Out of budget, or never retryable. */
  | { readonly action: "fail"; readonly reason: "non-retryable" | "budget-exhausted" };

export type ClassifyErrorContext = { readonly nowMs: number };

export type ResolveRetryContext = {
  readonly nowMs: number;
  /** Retries already consumed by non-quota failures. */
  readonly attemptsUsed: number;
  /** The task's configured retry budget. */
  readonly retries: number;
};

export type WaitWakeClassifiers = {
  readonly classifyError: (failure: unknown, context: ClassifyErrorContext) => ErrorClassification;
  readonly resolveRetry: (classification: ErrorClassification, context: ResolveRetryContext) => RetryResolution;
};
