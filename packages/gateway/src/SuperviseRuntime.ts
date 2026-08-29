/**
 * Temporary gateway supervision port for the mid-churn engine resume path.
 *
 * @since 0.1.0
 */
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import type { RunRow } from "@smthrs/run-store/RunStore"
import { Context, Effect, Layer, Schema } from "effect"

/**
 * A stale running run and the evidence that its owner is dead.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface StaleRunningCandidate {
  readonly _tag: "stale-running"
  readonly runRow: RunRow
  readonly livenessEvidence: LivenessEvidence
}

/**
 * A quota-parked run whose reset time has arrived.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface QuotaDueCandidate {
  readonly _tag: "quota-due"
  readonly runRow: RunRow
  readonly resetAtMs: number
}

/**
 * A run whose unactivated claim holder has been proven dead.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface StaleClaimCandidate {
  readonly _tag: "stale-claim"
  readonly runRow: RunRow
  readonly claimantDeathEvidence: LivenessEvidence
}

/**
 * A run that supervision may recover or resume.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Candidate = StaleRunningCandidate | QuotaDueCandidate | StaleClaimCandidate

/**
 * A fenced request to resume one supervision candidate.
 *
 * @since 0.1.0
 * @category models
 * @slop
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
 * @slop
 */
export const ResumeErrorCode = Schema.Literals(["claim_lost", "resume_failed"])

/**
 * A stable supervision runtime resume failure code.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export type ResumeErrorCode = typeof ResumeErrorCode.Type

/**
 * A supervision runtime failure while resuming a candidate.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export class ResumeError extends Schema.TaggedError<ResumeError>()("flows/gateway/ResumeError", {
  code: ResumeErrorCode,
  message: Schema.String,
  cause: Schema.Unknown
}) {}

/**
 * Engine-facing supervision operations.
 *
 * This TODO port is removed when the engine's resume surface stabilizes.
 *
 * @since 0.1.0
 * @category models
 * @slop
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
 * @slop
 */
export class SuperviseRuntime extends Context.Service<SuperviseRuntime, Service>()("flows/gateway/SuperviseRuntime") {}

/**
 * Constructs a supervision runtime service.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (service: Service): Service => SuperviseRuntime.of(service)

/**
 * Constructs a supervision runtime with no candidates and successful resumes.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
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
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<SuperviseRuntime> =>
  Layer.succeed(SuperviseRuntime, makeNoop(overrides))
