/**
 * The host seam a supervisor would implement to recover abandoned work.
 *
 * The port declares how a host discovers stale runs, quota-due work, and stale
 * claims, and how it takes a fenced lease to resume one. This release ships
 * `make`, `makeNoop`, and `layerNoop` only, and no production host installs it:
 * recovery at 1.0.0-rc.0 is a running engine process with the flow registered,
 * reclaiming a run whose owner stopped renewing its heartbeat. `docs/pages/
 * release/known-limitations.md` records that posture.
 *
 * A candidate names a run by its `@smthrs/control` summary rather than by a
 * store row, so this module keeps the promise the rest of the package makes:
 * a projection is the contract and a store row is an implementation detail.
 *
 * @since 0.1.0
 */
import type { ControlSchema } from "@smthrs/control"
// `Ownership` is the vocabulary of who holds a run and how a host proved the
// holder is gone. It is not a store row, and there is no second spelling of it.
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import { Context, Effect, Layer, Schema } from "effect"

/**
 * A stale running run and the evidence that its owner is dead.
 *
 * @since 0.1.0
 * @category models
 */
export interface StaleRunningCandidate {
  readonly _tag: "stale-running"
  readonly run: ControlSchema.RunSummary
  readonly livenessEvidence: LivenessEvidence
}

/**
 * A quota-parked run whose reset time has arrived.
 *
 * @since 0.1.0
 * @category models
 */
export interface QuotaDueCandidate {
  readonly _tag: "quota-due"
  readonly run: ControlSchema.RunSummary
  readonly resetAtMs: number
}

/**
 * A run whose unactivated claim holder has been proven dead.
 *
 * @since 0.1.0
 * @category models
 */
export interface StaleClaimCandidate {
  readonly _tag: "stale-claim"
  readonly run: ControlSchema.RunSummary
  readonly claimantDeathEvidence: LivenessEvidence
}

/**
 * A run that supervision may recover or resume.
 *
 * @since 0.1.0
 * @category models
 */
export type Candidate = StaleRunningCandidate | QuotaDueCandidate | StaleClaimCandidate

/**
 * A fenced request to resume one supervision candidate.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResumeLease {
  readonly runId: string
  readonly claimant: OwnerId
  readonly candidate: Candidate
}

/**
 * Stable failures returned by a supervision runtime resume.
 *
 * @since 0.1.0
 * @category errors
 */
export const ResumeErrorCode = Schema.Literals(["claim_lost", "resume_failed"])

/**
 * A stable supervision runtime resume failure code.
 *
 * @since 0.1.0
 * @category errors
 */
export type ResumeErrorCode = typeof ResumeErrorCode.Type

/**
 * A supervision runtime failure while resuming a candidate.
 *
 * @since 0.1.0
 * @category errors
 */
export class ResumeError extends Schema.TaggedError<ResumeError>()("flows/gateway/ResumeError", {
  code: ResumeErrorCode,
  message: Schema.String,
  cause: Schema.Unknown
}) {}

/**
 * Engine-facing supervision operations.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly scan: (now: number) => Effect.Effect<ReadonlyArray<Candidate>>
  readonly resume: (lease: ResumeLease) => Effect.Effect<void, ResumeError>
}

/**
 * Service tag for the engine-facing supervision operations.
 *
 * @since 0.1.0
 * @category services
 */
export class SuperviseRuntime extends Context.Service<SuperviseRuntime, Service>()("flows/gateway/SuperviseRuntime") {}

/**
 * Constructs a supervision runtime service.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (service: Service): Service => SuperviseRuntime.of(service)

/**
 * Constructs a supervision runtime with no candidates and successful resumes.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    scan: Effect.fn("SuperviseRuntime.scan")(() => Effect.succeed([])),
    resume: Effect.fn("SuperviseRuntime.resume")(() => Effect.void),
    ...overrides
  })

/**
 * Provides a no-op supervision runtime.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<SuperviseRuntime> =>
  Layer.succeed(SuperviseRuntime, makeNoop(overrides))
