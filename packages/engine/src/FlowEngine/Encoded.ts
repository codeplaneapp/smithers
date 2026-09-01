// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The low-level engine contract, expressed over encoded payloads and results.
 *
 * `makeUnsafe` adapts an `Encoded` implementation into the typed
 * `FlowRuntime` port that `@smthrs/flow` declares, adding schema decoding and
 * encoding on the way through. Durable stores implement `Encoded`, never the
 * typed port directly.
 *
 * @since 0.1.0
 */
import type { Action, DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import type * as Crypto from "effect/Crypto"
import type * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import type * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import type * as Round from "./Round.ts"

/**
 * The identity and boundary information supplied to an encoded action
 * executor.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ActionExecuteOptions {
  readonly action: Action.Any
  readonly attempt: number
  readonly key: string
  readonly tier: Action.Tier
  /** Allows a cache put race to retain the first row without failing this run. */
  readonly nondeterministic?: true | undefined
  readonly metadata: unknown
}

/**
 * Low-level flow engine contract that works with encoded payloads and
 * results before `makeUnsafe` adds typed schema decoding and encoding.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Encoded {
  readonly register: (
    flow: Flow.Any,
    execute: (
      payload: object,
      executionId: string
    ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly execute: <const Discard extends boolean>(
    flow: Flow.Any,
    options: {
      readonly executionId: string
      readonly payload: object
      readonly discard: Discard
      readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
      /**
       * The execution's trampoline position. Later rounds name the preceding
       * execution so durable stores can verify the continue-as-new chain.
       */
      readonly round?:
        | (Round.Round & {
          readonly previousExecutionId?: string | undefined
        })
        | undefined
    }
  ) => Effect.Effect<
    Discard extends true ? void : Flow.Result<unknown, unknown>,
    FlowRuntime.FlowCycleDetected
  >
  /**
   * `Option.none` is a known, unsettled execution; an unknown execution id
   * fails with `FlowRuntime.FlowExecutionNotFound`.
   */
  readonly poll: (
    flow: Flow.Any,
    executionId: string
  ) => Effect.Effect<
    Option.Option<Flow.Result<unknown, unknown>>,
    FlowRuntime.FlowExecutionNotFound
  >
  /**
   * Requests cancellation with normal cleanup and compensation semantics.
   * This is not a pause operation.
   *
   * Reports `FlowRuntime.CancelRequestFailed` when a durable implementation
   * could not record the request; an in-memory one never raises it.
   */
  readonly interrupt: (
    flow: Flow.Any,
    executionId: string
  ) => Effect.Effect<void, FlowRuntime.CancelRequestFailed>
  /**
   * Forces cancellation without guaranteeing cleanup or compensation.
   */
  readonly interruptUnsafe: (
    flow: Flow.Any,
    executionId: string
  ) => Effect.Effect<void, FlowRuntime.CancelRequestFailed>
  /**
   * Re-drives a durably suspended execution; it does not undo cancellation.
   */
  readonly resume: (
    flow: Flow.Any,
    executionId: string
  ) => Effect.Effect<void>
  readonly resumeSignal?:
    | ((
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void>)
    | undefined
  readonly actionExecute: (
    options: ActionExecuteOptions
  ) => Effect.Effect<
    Flow.Result<unknown, unknown>,
    never,
    FlowRuntime.FlowInstance | Crypto.Crypto
  >
  /**
   * The durable wall-clock origin of an action's retry sequence: the
   * persisted start time of the first attempt for `key`, when one exists.
   *
   * Durable drivers implement it so a `RetryPolicy.expirationMs`
   * (schedule-to-close) bound survives park/resume and process death
   * (issue #45); when absent the engine falls back to an in-process origin.
   *
   * `Option.none()` means no attempt row for `key` survives at all (for
   * example a retention job pruned every attempt). The engine then falls
   * back to the current clock — restarting the budget rather than failing
   * the run, because turning benign retention pruning into spurious
   * failures is worse than granting a fresh window — and logs a warning so
   * the restarted budget is observable (issue #69). Drivers are expected to
   * keep `Option.some` as long as any attempt row survives, using the
   * earliest surviving row when attempt 1 itself was pruned.
   */
  readonly actionRetryOrigin?:
    | ((options: {
      readonly key: string
    }) => Effect.Effect<Option.Option<number>, never, FlowRuntime.FlowInstance | Crypto.Crypto>)
    | undefined
  /**
   * The highest persisted attempt number for `key`, when attempts survive.
   *
   * Durable drivers implement it so the attempt counter resumes from the
   * persisted sequence after process death (issue #59): a replayed failed
   * attempt keeps its original attempt number, the backoff ladder is not
   * re-slept from attempt 1, and a persisted `nonRetryable` failure is
   * decided against the original attempt instead of re-dispatching.
   */
  readonly actionLatestAttempt?:
    | ((options: {
      readonly key: string
    }) => Effect.Effect<Option.Option<number>, never, FlowRuntime.FlowInstance | Crypto.Crypto>)
    | undefined
  readonly deferredResult: (
    deferred: DurableDeferred.Any
  ) => Effect.Effect<
    Option.Option<Exit.Exit<unknown, unknown>>,
    never,
    FlowRuntime.FlowInstance
  >
  readonly deferredDone: (options: {
    readonly flowName: string
    readonly executionId: string
    readonly deferredName: string
    readonly exit: Exit.Exit<unknown, unknown>
  }) => Effect.Effect<void>
  readonly deferredDoneIfWaiting?:
    | ((options: {
      readonly flowName: string
      readonly executionId: string
      readonly deferredName: string
      readonly reason: string
      readonly token: string
      readonly exit: Exit.Exit<unknown, unknown>
    }) => Effect.Effect<FlowRuntime.DeferredDoneIfWaitingOutcome>)
    | undefined
  readonly scheduleClock: (
    flow: Flow.Any,
    options: {
      readonly executionId: string
      readonly clock: DurableClock.DurableClock
    }
  ) => Effect.Effect<void>
}
