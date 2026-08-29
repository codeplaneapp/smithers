/**
 * The wire contract shared by the sync server and the browser-safe client.
 *
 * Every message is schema-backed so the same definitions serve the RPC group,
 * the HTTP transport, and replay tooling.
 *
 * @since 0.1.0
 */
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Schema from "effect/Schema"
import { ShareCapability } from "./BranchProtocol.ts"

/**
 * Selects every run in the workspace.
 *
 * @category models
 * @since 0.1.0
 */
export const WorkspaceScope = Schema.TaggedStruct("Workspace", {})

/**
 * Selects a single run.
 *
 * @category models
 * @since 0.1.0
 */
export const RunScope = Schema.TaggedStruct("Run", { runId: JournalEvent.RunId })

/**
 * The set of runs a request covers.
 *
 * @category models
 * @since 0.1.0
 */
export const Scope = Schema.Union([WorkspaceScope, RunScope])

/**
 * The set of runs a request covers.
 *
 * @category models
 * @since 0.1.0
 */
export type Scope = typeof Scope.Type

/**
 * The last sequence a client has materialized for one run.
 *
 * @category models
 * @since 0.1.0
 */
export const RunCursor = Schema.Struct({
  runId: JournalEvent.RunId,
  afterSeq: JournalEvent.Seq
})

/**
 * The last sequence a client has materialized for one run.
 *
 * @category models
 * @since 0.1.0
 */
export type RunCursor = typeof RunCursor.Type

/**
 * A client's materialized position across the workspace.
 *
 * @category models
 * @since 0.1.0
 */
export const WorkspaceCursor = Schema.Array(RunCursor)

/**
 * A client's materialized position across the workspace.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkspaceCursor = typeof WorkspaceCursor.Type

/**
 * A durable catch-up request.
 *
 * `capability` authorizes branch runs: a run whose id maps to a shared branch
 * is only read when the capability verifies for that branch. Non-branch runs
 * ignore it.
 *
 * @category models
 * @since 0.1.0
 */
export const ReadRequest = Schema.Struct({
  scope: Scope,
  cursors: WorkspaceCursor,
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  capability: Schema.optional(ShareCapability)
})

/**
 * A durable catch-up request.
 *
 * @category models
 * @since 0.1.0
 */
export type ReadRequest = typeof ReadRequest.Type

/**
 * One page of durable catch-up entries.
 *
 * `done` reports that the page reached the durable tail, which is the point at
 * which a client may switch from paging to following.
 *
 * @category models
 * @since 0.1.0
 */
export const ReadResponse = Schema.Struct({
  entries: Schema.Array(JournalEvent.Entry),
  cursors: WorkspaceCursor,
  done: Schema.Boolean
})

/**
 * One page of durable catch-up entries.
 *
 * @category models
 * @since 0.1.0
 */
export type ReadResponse = typeof ReadResponse.Type

/**
 * A request to follow committed entries.
 *
 * `capability` authorizes branch runs exactly as on {@link ReadRequest}.
 *
 * @category models
 * @since 0.1.0
 */
export const SubscribeRequest = Schema.Struct({
  scope: Scope,
  cursors: WorkspaceCursor,
  credit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  capability: Schema.optional(ShareCapability)
})

/**
 * A request to follow committed entries.
 *
 * @category models
 * @since 0.1.0
 */
export type SubscribeRequest = typeof SubscribeRequest.Type

/**
 * A contiguous batch of committed entries for one run.
 *
 * `fromSeq` and `toSeq` describe the interval the server covered, not the
 * sequences actually carried: dropped admissions leave legitimate holes.
 *
 * @category models
 * @since 0.1.0
 */
export const EntriesFrame = Schema.TaggedStruct("Entries", {
  runId: JournalEvent.RunId,
  fromSeq: JournalEvent.Seq,
  toSeq: JournalEvent.Seq,
  entries: Schema.Array(JournalEvent.Entry)
})

/**
 * A contiguous batch of committed entries for one run.
 *
 * @category models
 * @since 0.1.0
 */
export type EntriesFrame = typeof EntriesFrame.Type

/**
 * A liveness frame emitted while no entries are flowing.
 *
 * @category models
 * @since 0.1.0
 */
export const HeartbeatFrame = Schema.TaggedStruct("Heartbeat", {})

/**
 * A terminal frame reporting that the server ended the subscription.
 *
 * @category models
 * @since 0.1.0
 */
export const ClosedFrame = Schema.TaggedStruct("Closed", {
  reason: Schema.optional(Schema.String)
})

/**
 * Any frame a subscription may emit.
 *
 * @category models
 * @since 0.1.0
 */
export const Frame = Schema.Union([EntriesFrame, HeartbeatFrame, ClosedFrame])

/**
 * Any frame a subscription may emit.
 *
 * @category models
 * @since 0.1.0
 */
export type Frame = typeof Frame.Type

/**
 * Whether a scope covers a run.
 *
 * @category predicates
 * @since 0.1.0
 */
export const covers = (scope: Scope, runId: JournalEvent.RunId): boolean =>
  scope._tag === "Workspace" || scope.runId === runId

/**
 * Default ceiling on the encoded entries one frame, page, or command may
 * carry, in bytes.
 *
 * Both ends of the wire enforce it: the server refuses to serve or append
 * anything larger, and the client refuses to apply anything larger.
 *
 * @category limits
 * @since 0.1.0
 */
export const defaultMaxFrameBytes = 1024 * 1024

const utf8 = new TextEncoder()

/**
 * The wire size of one value: the UTF-8 byte length of its JSON text.
 *
 * Ceilings measure this encoded form rather than in-memory object size, so a
 * limit tracks what a transport actually carries.
 *
 * @category limits
 * @since 0.1.0
 */
export const encodedByteLength = (value: unknown): number => utf8.encode(JSON.stringify(value)).length
