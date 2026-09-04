/**
 * The branch collaboration wire contract: the RPC projection of the write
 * and presence paths that complement the read-only {@link SyncRpcs}.
 *
 * Authorization has two stages. Opening a branch is the bootstrap: no
 * capability can exist yet, so `CreateBranch` requires an authenticated
 * workspace principal supplied by the group's {@link SyncAuth} middleware,
 * and its handler refuses any other principal.
 *
 * Every later procedure carries its own share capability and authorizes
 * through {@link BranchShare}: past the bootstrap the capability IS the
 * credential, and cross-branch or expired capabilities are refused by the
 * same service boundary the in-process callers use.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import * as BranchCommands from "./BranchCommands.ts"
import * as BranchPresence from "./BranchPresence.ts"
import { Access, BranchId, CommandReceipt, Participant, ShareCapability } from "./BranchProtocol.ts"
import { SyncError } from "./SyncError.ts"
import { SyncAuth } from "./SyncRpcs.ts"

/**
 * Maximum lifetime the branch bootstrap may mint.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumBranchTtlMs = 24 * 60 * 60 * 1000

/**
 * Schema for a capability-bearing command submission.
 *
 * It IS `BranchCommands.SubmitRequest`, not a copy of it. Four wire payloads
 * used to re-declare the message their service already owned, and the
 * announce copy had already drifted: it accepted `displayName: ""` where the
 * service requires a non-empty name, so a wire-legal announce reached a
 * `Participant` constructor and threw a defect outside the declared
 * `SyncError` channel. Naming the service's schema makes that drift
 * impossible rather than fixed once.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SubmitPayload = BranchCommands.SubmitRequest

/**
 * A capability-bearing command submission.
 *
 * @category models
 * @since 0.1.0
 */
export type SubmitPayload = typeof SubmitPayload.Type

/**
 * Schema for one participant's announcement of itself on a branch.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AnnouncePayload = BranchPresence.Announcement

/**
 * One participant's announcement of itself on a branch.
 *
 * @category models
 * @since 0.1.0
 */
export type AnnouncePayload = typeof AnnouncePayload.Type

/**
 * Schema for a capability-bearing request to drop one participant.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LeavePayload = BranchPresence.LeaveRequest

/**
 * A capability-bearing request to drop one participant.
 *
 * @category models
 * @since 0.1.0
 */
export type LeavePayload = typeof LeavePayload.Type

/**
 * Schema for a capability-bearing request for one branch's roster.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RosterPayload = BranchPresence.RosterRequest

/**
 * A capability-bearing request for one branch's roster.
 *
 * @category models
 * @since 0.1.0
 */
export type RosterPayload = typeof RosterPayload.Type

/**
 * Schema for a request to open a new shared branch.
 *
 * The RPC authentication middleware must establish the workspace principal
 * before the handler mints the first write capability.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CreateBranchPayload = Schema.Struct({
  ttlMs: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximumBranchTtlMs)
  )
})

/**
 * A request to open a new shared branch.
 *
 * @category models
 * @since 0.1.0
 */
export type CreateBranchPayload = typeof CreateBranchPayload.Type

/**
 * Schema for the freshly opened branch and its owner capability.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CreateBranchResponse = Schema.Struct({
  branchId: BranchId,
  capability: ShareCapability
})

/**
 * The freshly opened branch and its owner capability.
 *
 * @category models
 * @since 0.1.0
 */
export type CreateBranchResponse = typeof CreateBranchResponse.Type

/**
 * Schema for a request to mint a share link for a branch.
 *
 * The presenting capability must hold write access to the branch — only a
 * collaborator can invite one — and the minted link never outlives the
 * capability it was minted from.
 *
 * @category schemas
 * @since 0.1.0
 */
export const MintSharePayload = Schema.Struct({
  capability: ShareCapability,
  access: Access,
  ttlMs: Schema.Int.check(Schema.isGreaterThan(0))
})

/**
 * A request to mint a share link for a branch.
 *
 * @category models
 * @since 0.1.0
 */
export type MintSharePayload = typeof MintSharePayload.Type

/**
 * Schema for one roster emission on a branch watch stream.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RosterFrame = Schema.Struct({
  participants: Schema.Array(Participant)
})

/**
 * One roster emission on a branch watch stream.
 *
 * @category models
 * @since 0.1.0
 */
export type RosterFrame = typeof RosterFrame.Type

/**
 * The remote procedures of branch collaboration.
 *
 * @category groups
 * @since 0.1.0
 */
export const BranchRpcs = RpcGroup.make(
  Rpc.make("Branch.CreateBranch", {
    payload: CreateBranchPayload,
    success: CreateBranchResponse,
    error: SyncError
  }),
  Rpc.make("Branch.MintShare", { payload: MintSharePayload, success: ShareCapability, error: SyncError }),
  Rpc.make("Branch.Submit", { payload: SubmitPayload, success: CommandReceipt, error: SyncError }),
  Rpc.make("Branch.Announce", { payload: AnnouncePayload, success: Participant, error: SyncError }),
  Rpc.make("Branch.Leave", { payload: LeavePayload, success: Schema.Null, error: SyncError }),
  Rpc.make("Branch.Roster", {
    payload: RosterPayload,
    success: Schema.Array(Participant),
    error: SyncError
  }),
  Rpc.make("Branch.WatchRoster", { payload: RosterPayload, success: RosterFrame, error: SyncError, stream: true })
).middleware(SyncAuth)
