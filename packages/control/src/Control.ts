/**
 * Transport-independent control-plane vtable.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Stream } from "effect"
import type {
  AlreadyResolved,
  ClaimLost,
  ControlError,
  EnvelopeMismatch,
  FlowNotFound,
  InvalidInput,
  LaunchFailed,
  NoMatchingWait,
  PersistenceError,
  PlanDigestMismatch,
  RunNotFound,
  Unavailable
} from "./ControlError.ts"
import { Unavailable as UnavailableError } from "./ControlError.ts"
import type {
  ApprovalPayload,
  ControlEvent,
  Envelope,
  FlowId,
  IdempotencyKey,
  ListRequest,
  ListResponse,
  PlanCard,
  Principal,
  Receipt,
  RunId,
  SignalPayload,
  SteerMessage,
  WatchFilter
} from "./ControlSchema.ts"

/**
 * Raw input submitted to planning. Decoding is owned by `ControlRuntime`.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface PlanInput {
  readonly flowId: FlowId
  readonly input: unknown
  readonly idempotencyKey?: IdempotencyKey | undefined
}

/**
 * Starts an approved plan or joins/resumes an existing run.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type RunInput =
  | {
    readonly _tag: "Plan"
    readonly planId: string
    readonly digest: string
    readonly envelope: Envelope
    readonly idempotencyKey: IdempotencyKey
  }
  | {
    readonly _tag: "Resume"
    readonly runId: RunId
    readonly idempotencyKey: IdempotencyKey
  }

/**
 * @category models
 * @since 0.1.0
 * @slop
 */
export type { ApprovalTarget } from "./ControlSchema.ts"

/**
 * Full approval decision submitted to the authenticated server boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ApprovalInput extends ApprovalPayload {
  readonly principal?: Principal | undefined
}

/**
 * Steering mutation arguments.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SteerInput {
  readonly runId: RunId
  readonly message: SteerMessage
  readonly idempotencyKey: IdempotencyKey
}

/**
 * Signal mutation arguments.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SignalInput {
  readonly runId: RunId
  readonly signal: SignalPayload
  readonly idempotencyKey: IdempotencyKey
}

/**
 * Run lifecycle mutation arguments.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RunMutationInput {
  readonly runId: RunId
  readonly idempotencyKey: IdempotencyKey
  /**
   * Why the run is being cancelled or resumed.
   *
   * Free text, recorded on the journal entry the mutation writes and projected
   * back onto `RunSummary.cancellation`. An operator reading a cancelled run a
   * week later asks "why", and a control plane that never carried the answer
   * cannot produce one afterwards.
   */
  readonly reason?: string | undefined
  /**
   * Who is asking. Stamped by the runtime, which supplies its own principal
   * when the caller names none.
   */
  readonly principal?: Principal | undefined
}

/**
 * Transport-independent control operations.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly plan: (
    input: PlanInput
  ) => Effect.Effect<PlanCard, FlowNotFound | InvalidInput | PersistenceError | Unavailable>
  readonly run: (
    input: RunInput
  ) => Effect.Effect<
    Receipt,
    RunNotFound | PlanDigestMismatch | EnvelopeMismatch | ClaimLost | LaunchFailed | PersistenceError | Unavailable
  >
  readonly approve: (
    input: ApprovalInput
  ) => Effect.Effect<
    Receipt,
    PlanDigestMismatch | EnvelopeMismatch | AlreadyResolved | RunNotFound | PersistenceError | Unavailable
  >
  readonly deny: (
    input: ApprovalInput
  ) => Effect.Effect<
    Receipt,
    PlanDigestMismatch | EnvelopeMismatch | AlreadyResolved | RunNotFound | PersistenceError | Unavailable
  >
  readonly steer: (
    input: SteerInput
  ) => Effect.Effect<Receipt, RunNotFound | InvalidInput | PersistenceError | Unavailable>
  readonly signal: (
    input: SignalInput
  ) => Effect.Effect<Receipt, RunNotFound | NoMatchingWait | PersistenceError | Unavailable>
  readonly cancel: (
    input: RunMutationInput
  ) => Effect.Effect<Receipt, RunNotFound | ClaimLost | PersistenceError | Unavailable>
  readonly resume: (
    input: RunMutationInput
  ) => Effect.Effect<Receipt, RunNotFound | ClaimLost | PersistenceError | Unavailable>
  readonly list: (input: ListRequest) => Effect.Effect<ListResponse, ControlError>
  readonly watch: (filter: WatchFilter) => Stream.Stream<ControlEvent, ControlError>
}

/**
 * Service key for the authoritative control-plane vtable.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Control extends Context.Service<Control, Service>()("/control/Control") {}

/**
 * Constructs a control service from an implementation record.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => Control.of(implementation)

const unavailable = (feature: string): Unavailable =>
  new UnavailableError({ feature, ticket: "control-runtime-engine-integration" })

/**
 * Provides an unavailable control implementation for optional integrations.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop: Layer.Layer<Control> = Layer.succeed(
  Control,
  make({
    plan: Effect.fn("Control.plan")(() => Effect.fail(unavailable("plan"))),
    run: Effect.fn("Control.run")(() => Effect.fail(unavailable("run"))),
    approve: Effect.fn("Control.approve")(() => Effect.fail(unavailable("approve"))),
    deny: Effect.fn("Control.deny")(() => Effect.fail(unavailable("deny"))),
    steer: Effect.fn("Control.steer")(() => Effect.fail(unavailable("steer"))),
    signal: Effect.fn("Control.signal")(() => Effect.fail(unavailable("signal"))),
    cancel: Effect.fn("Control.cancel")(() => Effect.fail(unavailable("cancel"))),
    resume: Effect.fn("Control.resume")(() => Effect.fail(unavailable("resume"))),
    list: Effect.fn("Control.list")(() => Effect.fail(unavailable("list"))),
    watch: () => Stream.fail(unavailable("watch"))
  })
)
