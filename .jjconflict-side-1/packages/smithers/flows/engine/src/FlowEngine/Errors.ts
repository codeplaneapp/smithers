/**
 * Stable, coded engine refusals that a control plane or proxy can classify
 * without scraping prose from an error message.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * A suspended execution spent the caller's resume retry policy.
 *
 * @category errors
 * @since 1.0.0
 */
export class SuspendedResumeGaveUp extends Schema.TaggedError<SuspendedResumeGaveUp>()(
  "@smthrs/engine/SuspendedResumeGaveUp",
  {
    code: Schema.Literal("suspended_resume_gave_up").pipe(
      Schema.withConstructorDefault(Effect.succeed("suspended_resume_gave_up"))
    ),
    flowName: Schema.String,
    executionId: Schema.String,
    attempt: Schema.Number,
    elapsedMs: Schema.Number,
    reason: Schema.Literals(["expired", "exhausted"]),
    message: Schema.String
  }
) {}

/**
 * A compensable action was admitted without a snapshot boundary.
 *
 * @category errors
 * @since 1.0.0
 */
export class SnapshotBoundaryRequired extends Schema.TaggedError<SnapshotBoundaryRequired>()(
  "@smthrs/engine/SnapshotBoundaryRequired",
  {
    code: Schema.Literal("snapshot_boundary_required").pipe(
      Schema.withConstructorDefault(Effect.succeed("snapshot_boundary_required"))
    ),
    actionName: Schema.String,
    message: Schema.String
  }
) {}

/**
 * A flow operation named a declaration this engine has not registered.
 *
 * @category errors
 * @since 1.0.0
 */
export class FlowNotRegistered extends Schema.TaggedError<FlowNotRegistered>()(
  "@smthrs/engine/FlowNotRegistered",
  {
    code: Schema.Literal("flow_not_registered").pipe(
      Schema.withConstructorDefault(Effect.succeed("flow_not_registered"))
    ),
    flowName: Schema.String,
    message: Schema.String
  }
) {}

/**
 * A caller reused an execution id for a different flow or payload identity.
 *
 * @category errors
 * @since 1.0.0
 */
export class ExecutionIdentityConflict extends Schema.TaggedError<ExecutionIdentityConflict>()(
  "@smthrs/engine/ExecutionIdentityConflict",
  {
    code: Schema.Literal("execution_identity_conflict").pipe(
      Schema.withConstructorDefault(Effect.succeed("execution_identity_conflict"))
    ),
    executionId: Schema.String,
    field: Schema.Literals(["flow", "payload"]),
    expected: Schema.String,
    actual: Schema.String,
    message: Schema.String
  }
) {}
