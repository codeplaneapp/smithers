/**
 * The gateway's own remote procedures: the served read path, and the one
 * composite mutation a product client cannot assemble safely on its own.
 *
 * Control mutations are not re-declared here. `@smthrs/control` `ControlRpcs`
 * is the mutation contract and the gateway mounts it unchanged at `/rpc`, so
 * there is exactly one wire definition of `Plan`, `Run`, `Approve`, `Deny`,
 * `Cancel`, `Signal`, `Steer`, `Pause`, `Resume`, `List`, and `Watch`.
 *
 * The group shares `ControlRpcs.ControlAuth`, so one bearer credential
 * authenticates both mounts and one server-stamped principal is recorded for
 * whatever it authorizes.
 *
 * @since 1.0.0
 */
import { ControlError, ControlRpcs, ControlSchema } from "@smthrs/control"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GatewayError } from "./GatewayError.ts"
import * as GatewaySchema from "./GatewaySchema.ts"

/**
 * The decision a client submits for one approval.
 *
 * @since 1.0.0
 * @category models
 */
export const Decision = Schema.Literals(["approve", "deny"])

/**
 * The decision a client submits for one approval.
 *
 * @since 1.0.0
 * @category models
 */
export type Decision = typeof Decision.Type

/**
 * One approval decision, submitted with the exact payload the run published.
 *
 * @since 1.0.0
 * @category models
 */
export const SubmitApprovalInput = Schema.Struct({
  ...ControlSchema.ApprovalPayload.fields,
  decision: Decision
})

/**
 * What submitting an approval did.
 *
 * `decision` is the receipt for the grant or refusal. `resume` is retained as
 * an optional wire-compatibility field and is no longer emitted: Control owns
 * the decision and its durable resume delegation as one domain command.
 *
 * @since 1.0.0
 * @category models
 */
export const SubmitApprovalOutput = Schema.Struct({
  decision: ControlSchema.Receipt,
  /** @deprecated Control resumes node approvals as part of `decision`. */
  resume: Schema.optional(ControlSchema.Receipt)
})

/**
 * What submitting an approval did.
 *
 * @since 1.0.0
 * @category models
 */
export type SubmitApprovalOutput = typeof SubmitApprovalOutput.Type

const submitErrors = Schema.Union([
  ControlError.PlanDigestMismatch,
  ControlError.EnvelopeMismatch,
  ControlError.AlreadyResolved,
  ControlError.RunNotFound,
  ControlError.ClaimLost,
  ControlError.PersistenceError,
  ControlError.Unavailable
])

/**
 * The gateway read path and the composite approval mutation.
 *
 * `Approval.Submit` is the transport form of Control's single decision
 * command. Control records the decision and durable resume delegation; the
 * gateway never composes a second mutation.
 *
 * @since 1.0.0
 * @category groups
 */
export const GatewayRpcs = RpcGroup.make(
  Rpc.make("Projection.Snapshot", {
    payload: Schema.Struct({ selector: GatewaySchema.ProjectionSelector }),
    success: GatewaySchema.ProjectionSnapshot,
    error: GatewayError
  }),
  Rpc.make("Projection.Subscribe", {
    payload: Schema.Struct({ selector: GatewaySchema.ProjectionSelector }),
    success: GatewaySchema.GatewayFrame,
    error: GatewayError,
    stream: true
  }),
  Rpc.make("Approval.Submit", {
    payload: SubmitApprovalInput,
    success: SubmitApprovalOutput,
    error: submitErrors
  })
).middleware(ControlRpcs.ControlAuth)
