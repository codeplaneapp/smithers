/**
 * Typed failures raised by testing and conformance operations.
 *
 * Every error carries a stable `code` drawn from a closed literal union, so
 * consumers can match on codes without parsing messages. The per-error code
 * schemas and the combined {@link Code} union are exported. Contract source:
 * `docs/specs/Research/Smithers Testing Library Conversion 2026-07-27.md`
 * ("errors are typed values, not string conventions").
 *
 * @since 0.0.0
 */
import type { CancelRequestFailed, FlowCycleDetected } from "@smthrs/flow/FlowRuntime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const constantCode = <const C extends string>(code: C) =>
  Schema.Literal(code).pipe(Schema.withConstructorDefault(Effect.succeed(code)))

/**
 * Codes raised by plan assertions.
 *
 * @since 0.0.0
 * @category codes
 */
export const PlanAssertionCode = Schema.Literals([
  "missing_node",
  "node_count_mismatch",
  "key_mismatch",
  "placement_mismatch",
  "declared_effect_mismatch",
  "envelope_mismatch",
  "missing_edge",
  "unexpected_edge",
  "coverage_mismatch",
  "snapshot_mismatch",
  "key_golden_mismatch",
  "purity_violation",
  "input_decode_failed"
])

/**
 * The decoded form of {@link PlanAssertionCode}.
 *
 * @since 0.0.0
 * @category codes
 */
export type PlanAssertionCode = typeof PlanAssertionCode.Type

/**
 * Codes raised by journal assertions.
 *
 * @since 0.0.0
 * @category codes
 */
export const JournalAssertionCode = Schema.Literals([
  "step_not_executed",
  "execution_order_mismatch",
  "terminal_status_mismatch",
  "effect_not_executed",
  "effect_journaled_more_than_once",
  "missing_idempotency_key",
  "idempotency_key_mismatch"
])

/**
 * The decoded form of {@link JournalAssertionCode}.
 *
 * @since 0.0.0
 * @category codes
 */
export type JournalAssertionCode = typeof JournalAssertionCode.Type

/**
 * Codes raised by fixed-suite score gates.
 *
 * @since 0.0.0
 * @category codes
 */
export const ScoreGateCode = Schema.Literals([
  "invalid_threshold",
  "invalid_score",
  "mean_below_threshold",
  "min_below_threshold",
  "case_below_threshold"
])

/**
 * The decoded form of {@link ScoreGateCode}.
 *
 * @since 0.0.0
 * @category codes
 */
export type ScoreGateCode = typeof ScoreGateCode.Type

/**
 * Every stable code any testing error can carry, as one closed union.
 *
 * @since 0.0.0
 * @category codes
 */
export const Code = Schema.Literals([
  ...PlanAssertionCode.members.map((member) => member.literal),
  ...JournalAssertionCode.members.map((member) => member.literal),
  ...ScoreGateCode.members.map((member) => member.literal),
  "conformance_violation",
  "unscripted_model",
  "REPLAY_HARNESS_MISMATCH",
  "fixture_divergence",
  "EXACTLY_ONCE_UNSUPPORTED",
  "capability_contract_violation",
  "conformance_skipped",
  "engine_unavailable",
  "capability_operation_failed",
  "transaction_commit_failed",
  "rewind_failed",
  "flow_hash_mismatch",
  "TASK_TIMEOUT",
  "RALPH_MAX_REACHED"
])

/**
 * The decoded form of {@link Code}.
 *
 * @since 0.0.0
 * @category codes
 */
export type Code = typeof Code.Type

/**
 * An assertion failure while inspecting a flow plan.
 *
 * @since 0.0.0
 * @category errors
 */
export class PlanAssertionError extends Schema.TaggedError<PlanAssertionError>()("PlanAssertionError", {
  code: PlanAssertionCode,
  message: Schema.String,
  expected: Schema.optional(Schema.Unknown),
  actual: Schema.optional(Schema.Unknown)
}) {}

/**
 * An assertion failure while inspecting a flow journal.
 *
 * @since 0.0.0
 * @category errors
 */
export class JournalAssertionError extends Schema.TaggedError<JournalAssertionError>()("JournalAssertionError", {
  code: JournalAssertionCode,
  message: Schema.String,
  expected: Schema.optional(Schema.Unknown),
  actual: Schema.optional(Schema.Unknown)
}) {}

/**
 * A failed executable conformance pin.
 *
 * @since 0.0.0
 * @category errors
 */
export class ConformanceViolation extends Schema.TaggedError<ConformanceViolation>()("ConformanceViolation", {
  code: constantCode("conformance_violation"),
  pin: Schema.String,
  message: Schema.String,
  expected: Schema.optional(Schema.Unknown),
  actual: Schema.optional(Schema.Unknown)
}) {}

/**
 * A recorded model received a request with no matching fixture.
 *
 * @since 0.0.0
 * @category errors
 */
export class UnscriptedModelError extends Schema.TaggedError<UnscriptedModelError>()("UnscriptedModelError", {
  code: constantCode("unscripted_model"),
  request: Schema.Unknown
}) {}

/**
 * A replay harness produced output different from its recorded expectation.
 *
 * The code literal is inherited from the Smithers testing library's stable
 * `REPLAY_HARNESS_MISMATCH` code.
 *
 * @since 0.0.0
 * @category errors
 */
export class ReplayHarnessMismatchError extends Schema.TaggedError<ReplayHarnessMismatchError>()(
  "ReplayHarnessMismatchError",
  {
    code: constantCode("REPLAY_HARNESS_MISMATCH"),
    expected: Schema.String,
    actual: Schema.String
  }
) {}

/**
 * The first divergent field in a fixture sequence.
 *
 * @since 0.0.0
 * @category errors
 */
export class FixtureDivergenceError extends Schema.TaggedError<FixtureDivergenceError>()(
  "FixtureDivergenceError",
  {
    code: constantCode("fixture_divergence"),
    index: Schema.Number,
    field: Schema.String,
    expected: Schema.Unknown,
    actual: Schema.Unknown
  }
) {}

/**
 * Exactly-once assertions are unsupported because the assertion vocabulary must
 * not be able to lie: the engine does not provide exactly-once execution.
 *
 * The code literal is inherited from the Smithers testing library's stable
 * `EXACTLY_ONCE_UNSUPPORTED` code.
 *
 * @since 0.0.0
 * @category errors
 */
export class ExactlyOnceUnsupportedError extends Schema.TaggedError<ExactlyOnceUnsupportedError>()(
  "ExactlyOnceUnsupportedError",
  {
    code: constantCode("EXACTLY_ONCE_UNSUPPORTED"),
    message: Schema.String
  }
) {}

/**
 * An operation violated its declared capability contract.
 *
 * When the violation is a wrong typed capability code, the expectation and the
 * observation are carried as the typed `expectedCode` / `actualCode` fields —
 * never encoded into the operation string.
 *
 * @since 0.0.0
 * @category errors
 */
export class CapabilityContractError extends Schema.TaggedError<CapabilityContractError>()(
  "CapabilityContractError",
  {
    code: constantCode("capability_contract_violation"),
    capability: Schema.String,
    operation: Schema.String,
    expectedCode: Schema.optional(Schema.String),
    actualCode: Schema.optional(Schema.String)
  }
) {}

/**
 * A conformance pin could not run because its subject does not implement the
 * capability named by the pin.
 *
 * This is a failure, not a successful test outcome. Suite adapters may choose
 * not to register capability pins for subjects that declare a narrower
 * contract, but once a pin runs it must either assert behavior or fail with
 * this stable code.
 *
 * @since 0.0.0
 * @category errors
 */
export class ConformanceSkipped extends Schema.TaggedError<ConformanceSkipped>()("ConformanceSkipped", {
  code: constantCode("conformance_skipped"),
  pin: Schema.String,
  capability: Schema.String,
  reason: Schema.String
}) {}

/**
 * A score sample did not satisfy a configured gate.
 *
 * @since 0.0.0
 * @category errors
 */
export class ScoreGateError extends Schema.TaggedError<ScoreGateError>()("ScoreGateError", {
  code: ScoreGateCode,
  threshold: Schema.Number,
  actual: Schema.Number
}) {}

/**
 * The requested engine subject is unavailable for a test or conformance pin.
 *
 * @since 0.0.0
 * @category errors
 */
export class EngineUnavailableError extends Schema.TaggedError<EngineUnavailableError>()("EngineUnavailableError", {
  code: constantCode("engine_unavailable"),
  message: Schema.String
}) {}

/**
 * Transaction commit-failure injection boundaries.
 *
 * @since 0.0.0
 * @category codes
 */
export const TransactionBoundary = Schema.Literals(["frame", "snapshot", "output", "attempt", "event"])

/**
 * The decoded form of {@link TransactionBoundary}.
 *
 * @since 0.0.0
 * @category codes
 */
export type TransactionBoundary = typeof TransactionBoundary.Type

/**
 * Rewind boundaries at which a conformance subject can inject a failure.
 *
 * @since 0.0.0
 * @category codes
 */
export const RewindBoundary = Schema.Literals([
  "load-frame",
  "validate-frame",
  "truncate-journal",
  "restore-snapshot",
  "restore-output",
  "restore-attempt",
  "append-audit",
  "resume"
])

/**
 * The decoded form of {@link RewindBoundary}.
 *
 * @since 0.0.0
 * @category codes
 */
export type RewindBoundary = typeof RewindBoundary.Type

/**
 * A requested capability operation has no valid subject.
 *
 * @since 0.0.0
 * @category errors
 */
export class CapabilityOperationError
  extends Schema.TaggedError<CapabilityOperationError>()("CapabilityOperationError", {
    code: constantCode("capability_operation_failed"),
    capability: Schema.String,
    operation: Schema.String,
    message: Schema.String
  })
{}

/**
 * A failure raised at an injected transactional commit boundary.
 *
 * @since 0.0.0
 * @category errors
 */
export class TransactionCommitError extends Schema.TaggedError<TransactionCommitError>()("TransactionCommitError", {
  code: constantCode("transaction_commit_failed"),
  boundary: TransactionBoundary
}) {}

/**
 * A failure raised at an injected frame-rewind boundary.
 *
 * @since 0.0.0
 * @category errors
 */
export class RewindFailureError extends Schema.TaggedError<RewindFailureError>()("RewindFailureError", {
  code: constantCode("rewind_failed"),
  executionId: Schema.String,
  frame: Schema.Number,
  boundary: RewindBoundary
}) {}

/**
 * Resume was rejected because the current flow or import graph differs
 * from the stamp recorded for the execution.
 *
 * @since 0.0.0
 * @category errors
 */
export class FlowHashMismatchError extends Schema.TaggedError<FlowHashMismatchError>()("FlowHashMismatchError", {
  code: constantCode("flow_hash_mismatch"),
  executionId: Schema.String,
  expectedFlowHash: Schema.String,
  actualFlowHash: Schema.String,
  expectedImportHash: Schema.String,
  actualImportHash: Schema.String
}) {}

/**
 * An approval failed because its durable deadline elapsed under the fail
 * policy.
 *
 * @since 0.0.0
 * @category errors
 */
export class TaskTimeoutError extends Schema.TaggedError<TaskTimeoutError>()("TaskTimeoutError", {
  code: constantCode("TASK_TIMEOUT"),
  requestId: Schema.String,
  policy: Schema.Literal("fail"),
  requestedAtLogicalTimeMillis: Schema.Number,
  timedOutAtLogicalTimeMillis: Schema.Number
}) {}

/**
 * A bounded flow loop exhausted its iteration budget.
 *
 * @since 0.0.0
 * @category errors
 */
export class RalphMaxReachedError extends Schema.TaggedError<RalphMaxReachedError>()("RalphMaxReachedError", {
  code: constantCode("RALPH_MAX_REACHED"),
  loopId: Schema.String,
  maxIterations: Schema.Number
}) {}

/**
 * Every typed failure an engine subject (or one of its optional capabilities)
 * may raise. The conformance seam never carries an `unknown` error channel: a
 * subject that laundered a foreign cause into `unknown` could not be matched on
 * by a pin.
 *
 * `FlowCycleDetected` is re-declared here because it is part of the engine's
 * typed `execute` contract: a recoverable failure carrying the cycle `path`,
 * which pins must be able to match on rather than a stringified dump.
 * `CancelRequestFailed` is part of the engine's typed interrupt contract for
 * the same reason.
 *
 * @since 0.0.0
 * @category errors
 */
export type EngineSubjectError =
  | EngineUnavailableError
  | CapabilityContractError
  | ConformanceSkipped
  | CapabilityOperationError
  | TransactionCommitError
  | RewindFailureError
  | FlowHashMismatchError
  | TaskTimeoutError
  | RalphMaxReachedError
  | FlowCycleDetected
  | CancelRequestFailed
