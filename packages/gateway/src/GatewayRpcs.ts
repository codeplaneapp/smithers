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
 * `decision` is the receipt for the grant or refusal; `resume` is the receipt
 * for restarting the run the decision unblocked, which the gateway performs on
 * the caller's behalf. `resume` is absent for a plan-scoped decision, which
 * has no run to restart, and for a denial, which leaves the run parked.
 *
 * @since 1.0.0
 * @category models
 */
export const SubmitApprovalOutput = Schema.Struct({
  decision: ControlSchema.Receipt,
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
 * `Approval.Submit` exists because approving a parked node and restarting the
 * run it parked are one operator act and two control mutations. A product
 * client that made them two round trips would leave a run approved and
 * stopped whenever the second call was lost, which is exactly the state a
 * human reads as "I approved it and nothing happened". Binding them here
 * keeps the pair on the server side of the relay. When the control plane
 * resumes on approval itself, this procedure keeps its signature and stops
 * issuing the second mutation.
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
