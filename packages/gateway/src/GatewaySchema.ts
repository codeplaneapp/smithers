/**
 * Wire schemas shared by the gateway read path, subscriptions, and singleton
 * lifecycle.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * Workspace identity served by a gateway.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const Workspace = Schema.Struct({
  workspaceHash: Schema.String,
  workspacePath: Schema.String
})

/**
 * A workspace identity.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Workspace = typeof Workspace.Type

/**
 * Gateway process configuration.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const GatewayConfig = Schema.Struct({
  workspace: Workspace,
  host: Schema.String,
  port: Schema.Number,
  protocolVersion: Schema.String
})

/**
 * Gateway process configuration.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type GatewayConfig = typeof GatewayConfig.Type

/**
 * Runtime status of a gateway process.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const GatewayStatus = Schema.Struct({
  running: Schema.Boolean,
  url: Schema.NullOr(Schema.String),
  gatewayId: Schema.NullOr(Schema.String),
  startedAtMs: Schema.NullOr(Schema.Number)
})

/**
 * Runtime status of a gateway process.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type GatewayStatus = typeof GatewayStatus.Type

/**
 * Health response used to prove a singleton belongs to this workspace.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const GatewayHealth = Schema.Struct({
  workspaceHash: Schema.String,
  gatewayId: Schema.String,
  protocolVersion: Schema.String
})

/**
 * Health response used for singleton identity probes.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type GatewayHealth = typeof GatewayHealth.Type

/**
 * Projection names served by the gateway read path.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ProjectionName = Schema.Literals([
  "workspace-runs",
  "run-summary",
  "run-events",
  "transcript",
  "run-tree",
  "plan-cards",
  "approvals",
  "node-output"
])

/**
 * A gateway projection name.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ProjectionName = typeof ProjectionName.Type

/**
 * A selector for a workspace-wide run list.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const WorkspaceRunsSelector = Schema.TaggedStruct("workspace-runs", {})

/**
 * A selector for one run's summary.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const RunSummarySelector = Schema.TaggedStruct("run-summary", { runId: Schema.String })

/**
 * A selector for one run's ordered lifecycle events.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const RunEventsSelector = Schema.TaggedStruct("run-events", { runId: Schema.String })

/**
 * A selector for one run's transcript projection.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const TranscriptSelector = Schema.TaggedStruct("transcript", { runId: Schema.String })

/**
 * A selector for one run's flattened tree nodes.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const RunTreeSelector = Schema.TaggedStruct("run-tree", { runId: Schema.String })

/**
 * A selector for workspace plan cards.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const PlanCardsSelector = Schema.TaggedStruct("plan-cards", {})

/**
 * A selector for approvals.
 *
 * Without `runId` it lists the workspace's pending gates, which is the
 * approvals inbox. With one it lists that run's gates including the decided
 * ones, which is what a run card renders: a gate a human already answered
 * still belongs on the card that asked.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ApprovalsSelector = Schema.TaggedStruct("approvals", {
  runId: Schema.optional(Schema.String)
})

/**
 * A selector for one node's output projection.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const NodeOutputSelector = Schema.TaggedStruct("node-output", {
  runId: Schema.String,
  nodeId: Schema.String
})

/**
 * A projection selected for a snapshot or watch subscription.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ProjectionSelector = Schema.Union([
  WorkspaceRunsSelector,
  RunSummarySelector,
  RunEventsSelector,
  TranscriptSelector,
  RunTreeSelector,
  PlanCardsSelector,
  ApprovalsSelector,
  NodeOutputSelector
])

/**
 * A projection selected for a snapshot or watch subscription.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ProjectionSelector = typeof ProjectionSelector.Type

/**
 * A monotonic cursor for one projection and optional run scope.
 *
 * `runId` is null for workspace projections and records the source run for
 * per-run projections, even when a selector later gains more fields.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ProjectionCursor = Schema.Struct({
  projection: ProjectionName,
  runId: Schema.NullOr(Schema.String),
  value: Schema.Number
})

/**
 * A monotonic projection cursor.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ProjectionCursor = typeof ProjectionCursor.Type

/**
 * Every row one selector currently projects, and the cursor they were read
 * at. A client that follows the same selector from this cursor sees each
 * later change exactly once.
 *
 * @since 1.0.0
 * @category models
 */
export const ProjectionSnapshot = Schema.Struct({
  cursor: ProjectionCursor,
  rows: Schema.Array(Schema.Unknown)
})

/**
 * A projection snapshot and the cursor it was read at.
 *
 * @since 1.0.0
 * @category models
 */
export type ProjectionSnapshot = typeof ProjectionSnapshot.Type

/**
 * The inputs for one subscription watch tick.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const SubscriptionTick = Schema.Struct({
  sessionId: Schema.String,
  subscriptionId: Schema.String,
  selectors: Schema.Array(ProjectionSelector),
  cursors: Schema.Array(ProjectionCursor)
})

/**
 * The inputs for one subscription watch tick.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type SubscriptionTick = typeof SubscriptionTick.Type

/**
 * Inputs for creating or renewing a subscription watch.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const SubscriptionWatch = SubscriptionTick

/**
 * Inputs for creating or renewing a subscription watch.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type SubscriptionWatch = typeof SubscriptionWatch.Type

/**
 * The start of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const SnapshotStartFrame = Schema.TaggedStruct("snapshot-start", {
  selector: ProjectionSelector,
  cursor: ProjectionCursor
})

/**
 * A row emitted during a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const RowFrame = Schema.TaggedStruct("row", {
  selector: ProjectionSelector,
  cursor: ProjectionCursor,
  row: Schema.Unknown
})

/**
 * The end of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const SnapshotEndFrame = Schema.TaggedStruct("snapshot-end", {
  selector: ProjectionSelector,
  cursor: ProjectionCursor
})

/**
 * A projection mutation after snapshot completion.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const DeltaFrame = Schema.TaggedStruct("delta", {
  selector: ProjectionSelector,
  cursor: ProjectionCursor,
  delta: Schema.Unknown
})

/**
 * A keepalive frame for an active subscription.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const HeartbeatFrame = Schema.TaggedStruct("heartbeat", { atMs: Schema.Number })

/**
 * A frame reporting that a connection's bounded output buffer overflowed.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const OverflowFrame = Schema.TaggedStruct("overflow", { message: Schema.String })

/**
 * A frame reporting that a subscription lease expired.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ExpiredFrame = Schema.TaggedStruct("expired", { subscriptionId: Schema.String })

/**
 * A terminal subscription frame.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const TerminalFrame = Schema.TaggedStruct("terminal", { message: Schema.String })

/**
 * A frame reporting that authorization failed or expired.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const UnauthorizedFrame = Schema.TaggedStruct("unauthorized", { message: Schema.String })

/**
 * A frame sent by the gateway subscription protocol.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const GatewayFrame = Schema.Union([
  SnapshotStartFrame,
  RowFrame,
  SnapshotEndFrame,
  DeltaFrame,
  HeartbeatFrame,
  OverflowFrame,
  ExpiredFrame,
  TerminalFrame,
  UnauthorizedFrame
])

/**
 * A frame sent by the gateway subscription protocol.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type GatewayFrame = typeof GatewayFrame.Type

/**
 * On-disk state proving which gateway owns a workspace singleton.
 *
 * The session token is process-local capability material; it is never part of
 * a health response or token listing.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const SingletonRecord = Schema.Struct({
  gatewayId: Schema.String,
  workspaceHash: Schema.String,
  hostId: Schema.String,
  pid: Schema.Number,
  url: Schema.String,
  protocolVersion: Schema.String,
  startedAtMs: Schema.Number,
  sessionToken: Schema.String
})

/**
 * On-disk workspace gateway singleton state.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type SingletonRecord = typeof SingletonRecord.Type

/**
 * Gateway token permissions.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const TokenScope = Schema.Literals(["sync", "control", "tokens", "admin"])

/**
 * A gateway token permission.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type TokenScope = typeof TokenScope.Type

/**
 * An at-rest gateway token grant.
 *
 * `digest` is the one-way digest of the raw token. Raw bearer tokens must
 * never be persisted or returned after issuance.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const TokenRecord = Schema.Struct({
  id: Schema.String,
  workspaceHash: Schema.String,
  label: Schema.String,
  scopes: Schema.Array(TokenScope),
  digest: Schema.String,
  createdAtMs: Schema.Number,
  expiresAtMs: Schema.Number,
  revokedAtMs: Schema.optional(Schema.Number)
})

/**
 * An at-rest gateway token grant containing only a digest.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type TokenRecord = typeof TokenRecord.Type
