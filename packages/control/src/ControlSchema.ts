/**
 * Serializable control-plane values shared by local and RPC projections.
 *
 * @since 0.1.0
 */
import * as PersistedPlan from "@smthrs/plan/Plan"
import { Schema } from "effect"

/**
 * A durable control-plane run identifier.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const RunId = Schema.String

/**
 * A durable control-plane run identifier.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type RunId = typeof RunId.Type

/**
 * A registry flow identifier.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const FlowId = Schema.String

/**
 * A registry flow identifier.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type FlowId = typeof FlowId.Type

/**
 * A caller-supplied key that makes a control mutation idempotent.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const IdempotencyKey = Schema.String

/**
 * A caller-supplied key that makes a control mutation idempotent.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type IdempotencyKey = typeof IdempotencyKey.Type

/**
 * A server-authenticated identity stamped at the control boundary.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const Principal = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  stampedAt: Schema.Number
})

/**
 * A server-authenticated identity stamped at the control boundary.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Principal = typeof Principal.Type

/**
 * The capabilities, flows, budget, and placement approved for a plan.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const Envelope = Schema.Struct({
  capabilities: Schema.Array(Schema.String),
  flows: Schema.Array(Schema.String),
  budget: Schema.Struct({
    tokens: Schema.optional(Schema.Number),
    milliseconds: Schema.optional(Schema.Number)
  }),
  host: Schema.optional(Schema.String)
})

/**
 * The capabilities, flows, budget, and placement approved for a plan.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Envelope = typeof Envelope.Type

/**
 * The durability selected for an approval grant.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const GrantScope = Schema.Literals(["once", "run", "remembered"])

/**
 * The durability selected for an approval grant.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type GrantScope = typeof GrantScope.Type

/**
 * A plan or in-run approval target. The digest and full envelope are submitted
 * with the target so the server can verify exactly what the caller reviewed.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ApprovalTarget = Schema.Union([
  Schema.TaggedStruct("Plan", {
    planId: Schema.String,
    digest: Schema.String,
    envelope: Envelope
  }),
  Schema.TaggedStruct("Node", {
    runId: RunId,
    requestId: Schema.String,
    digest: Schema.String,
    envelope: Envelope
  })
])

/**
 * A plan or in-run approval target.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ApprovalTarget = typeof ApprovalTarget.Type

/**
 * The complete, reviewable payload emitted by planning and submitted unchanged
 * when an approval decision is made.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ApprovalPayload = Schema.Struct({
  target: ApprovalTarget,
  scope: GrantScope,
  idempotencyKey: IdempotencyKey
})

/**
 * The complete, reviewable payload emitted by planning.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ApprovalPayload = typeof ApprovalPayload.Type

/**
 * What `smithers plan` reports for one node before anything runs.
 *
 * The two dispositions fall out of step keys for free — a key either hits the
 * step cache or it does not — which is why they are reported here rather than
 * discovered during execution (`docs/specs/Concepts/Reconciliation.md`). The
 * third column that note describes, `release`, belongs to orphan
 * reconciliation and is deliberately not part of a plan card.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const PlanNodeStatus = Schema.Literals(["cached", "run"])

/**
 * What `smithers plan` reports for one node before anything runs.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type PlanNodeStatus = typeof PlanNodeStatus.Type

/**
 * One keyed node of the plan an approval is being taken on.
 *
 * `key` is an `@smthrs/keys` `Key` produced by `@smthrs/plan`'s step-key
 * compiler, so a node named here and a node recorded in the persisted plan are
 * the same node. Ids are lookup addresses and are never hashed.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const PlanNode = Schema.Struct({
  ...PersistedPlan.PlanNode.fields,
  status: PlanNodeStatus
})

/**
 * One keyed node of the plan an approval is being taken on.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type PlanNode = typeof PlanNode.Type

/**
 * The reviewable, signed payload returned by planning and resubmitted to
 * approval without reconstructing authority client-side.
 *
 * `nodes` is the keyed node graph the plan phase produced. It is part of the
 * card, and part of the digest an approval binds to, because "approve this
 * flow with this input" and "approve this graph of keyed work" are different
 * promises: a change that re-keys a node changes what will run, and an
 * approval taken against the old graph must not authorize the new one. A host
 * that has not built a graph reports an empty one and loses nothing.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const PlanCard = Schema.Struct({
  planId: Schema.String,
  flowId: FlowId,
  digest: Schema.String,
  inputSummary: Schema.String,
  envelope: Envelope,
  deployClass: Schema.Boolean,
  plan: Schema.optional(PersistedPlan.Plan),
  nodes: Schema.Array(PlanNode),
  approval: ApprovalPayload
})

/**
 * The reviewable, signed payload returned by planning and resubmitted to
 * approval without reconstructing authority client-side.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type PlanCard = typeof PlanCard.Type

/**
 * Stable statuses projected for a durable run.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const RunStatus = Schema.Literals([
  "accepted",
  "running",
  "parked",
  "waiting-approval",
  "cancelled",
  "completed",
  "failed"
])

/**
 * Stable statuses projected for a durable run.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type RunStatus = typeof RunStatus.Type

/**
 * A compact summary for run listings and status projections.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const RunSummary = Schema.Struct({
  runId: RunId,
  flowId: FlowId,
  status: RunStatus,
  planId: Schema.optional(Schema.String),
  planDigest: Schema.optional(Schema.String),
  ownerId: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number
})

/**
 * A compact summary for run listings and status projections.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type RunSummary = typeof RunSummary.Type

/**
 * A durable operator message delivered at an execution turn boundary.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const SteerMessage = Schema.Struct({
  messageId: Schema.String,
  runId: RunId,
  body: Schema.String,
  principal: Principal,
  createdAt: Schema.Number
})

/**
 * A durable operator message delivered at an execution turn boundary.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type SteerMessage = typeof SteerMessage.Type

/**
 * A durable, named signal delivered to a waiting run.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const SignalPayload = Schema.Struct({
  name: Schema.String,
  payload: Schema.Json
})

/**
 * A durable, named signal delivered to a waiting run.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type SignalPayload = typeof SignalPayload.Type

/**
 * A journal-projection cursor, optional run restriction, and delivery mode.
 * Omitting `follow` preserves the live-stream behavior; `false` requests a
 * finite snapshot of entries durable when the request is handled.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const WatchFilter = Schema.Struct({
  runId: Schema.optional(RunId),
  afterSequence: Schema.optional(Schema.Number),
  follow: Schema.optional(Schema.Boolean)
})

/**
 * A resumable journal-projection watch cursor and optional run restriction.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type WatchFilter = typeof WatchFilter.Type

/**
 * One ordered journal-projection delta streamed by `watch`.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ControlEvent = Schema.Struct({
  sequence: Schema.Number,
  kind: Schema.String,
  runId: Schema.optional(RunId),
  occurredAt: Schema.Number,
  payload: Schema.Json
})

/**
 * One ordered journal-projection delta streamed by `watch`.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ControlEvent = typeof ControlEvent.Type

/**
 * A typed listing request for discovered flows or durable runs.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ListRequest = Schema.Union([
  Schema.TaggedStruct("flows", {
    filters: Schema.optional(Schema.Json),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number)
  }),
  Schema.TaggedStruct("runs", {
    filters: Schema.optional(Schema.Struct({
      runId: Schema.optional(RunId),
      flowId: Schema.optional(FlowId),
      status: Schema.optional(RunStatus),
      principalId: Schema.optional(Schema.String)
    })),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number)
  })
])

/**
 * A typed listing request for discovered flows or durable runs.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ListRequest = typeof ListRequest.Type

/**
 * A typed page returned for a flow or run listing.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ListResponse = Schema.Union([
  Schema.TaggedStruct("flows", {
    items: Schema.Array(Schema.Struct({ flowId: FlowId, description: Schema.String })),
    nextCursor: Schema.optional(Schema.String)
  }),
  Schema.TaggedStruct("runs", {
    items: Schema.Array(RunSummary),
    nextCursor: Schema.optional(Schema.String)
  })
])

/**
 * A typed page returned for a flow or run listing.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ListResponse = typeof ListResponse.Type

/**
 * The idempotent outcome returned by every control mutation.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const Receipt = Schema.Union([
  Schema.TaggedStruct("Accepted", { receiptId: Schema.String, runId: Schema.optional(RunId) }),
  Schema.TaggedStruct("AlreadyApplied", { receiptId: Schema.String, runId: Schema.optional(RunId) }),
  Schema.TaggedStruct("Parked", {
    receiptId: Schema.String,
    planId: Schema.String,
    status: Schema.Literal("waiting-approval")
  }),
  Schema.TaggedStruct("Conflict", { message: Schema.String }),
  Schema.TaggedStruct("Terminal", { runId: RunId, status: RunStatus })
])

/**
 * The idempotent outcome returned by every control mutation.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Receipt = typeof Receipt.Type
