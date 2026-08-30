/**
 * Ephemeral presence and cursors for one shared branch.
 *
 * Presence is deliberately NOT journalled. A roster is a lease table: every
 * announcement extends a lease, and a participant that stops announcing —
 * because the tab closed, the network dropped, or the process died — ages out
 * without anyone reporting the disconnect. Writing presence to the journal
 * would make "who was looking at this" part of the durable, replayable history
 * of a run, which is both unbounded and wrong: replaying a branch must not
 * resurrect a stranger's caret.
 *
 * Every operation authorizes through {@link BranchShare}, so a capability for
 * one branch can neither read nor write another branch's roster.
 *
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { BranchId, Cursor, Participant, ParticipantId, ShareCapability } from "./BranchProtocol.ts"
import * as BranchShare from "./BranchShare.ts"
import { SyncError } from "./SyncError.ts"

/**
 * One participant's announcement of itself on a branch.
 *
 * The same shape serves join, heartbeat, and cursor movement: an announcement
 * is idempotent, so a client that reconnects simply announces again.
 *
 * @category models
 * @since 0.1.0
 */
export const Announcement = Schema.Struct({
  capability: ShareCapability,
  branchId: BranchId,
  participantId: ParticipantId,
  displayName: Schema.NonEmptyString,
  cursor: Schema.NullOr(Cursor)
})
/**
 * The value form of {@link Announcement}.
 *
 * @category models
 * @since 0.1.0
 */
export type Announcement = typeof Announcement.Type

/**
 * A capability-bearing request for one branch's roster.
 *
 * @category models
 * @since 0.1.0
 */
export const RosterRequest = Schema.Struct({ capability: ShareCapability, branchId: BranchId })
/**
 * The value form of {@link RosterRequest}.
 *
 * @category models
 * @since 0.1.0
 */
export type RosterRequest = typeof RosterRequest.Type

/**
 * A capability-bearing request to drop one participant.
 *
 * @category models
 * @since 0.1.0
 */
export const LeaveRequest = Schema.Struct({ ...RosterRequest.fields, participantId: ParticipantId })
/**
 * The value form of {@link LeaveRequest}.
 *
 * @category models
 * @since 0.1.0
 */
export type LeaveRequest = typeof LeaveRequest.Type

/**
 * Ephemeral branch presence operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly announce: (announcement: Announcement) => Effect.Effect<Participant, SyncError>
  readonly leave: (request: LeaveRequest) => Effect.Effect<void, SyncError>
  readonly list: (request: RosterRequest) => Effect.Effect<ReadonlyArray<Participant>, SyncError>
  readonly changes: Stream.Stream<BranchId>
}

/**
 * The branch presence registry.
 *
 * @category services
 * @since 0.1.0
 */
export class BranchPresence extends Context.Service<BranchPresence, Service>()("@smthrs/sync/BranchPresence") {}

/**
 * Constructs a presence registry from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => BranchPresence.of(implementation)

const unavailable = new SyncError({ code: "closed", message: "Branch presence is unavailable" })

/**
 * Constructs a presence registry that holds no one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    announce: () => Effect.fail(unavailable),
    leave: () => Effect.fail(unavailable),
    list: () => Effect.succeed([]),
    changes: Stream.empty,
    ...overrides
  })

/**
 * Provides a presence registry that holds no one.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<BranchPresence> = Layer.succeed(BranchPresence, makeNoop())

/**
 * How long an announcement keeps a participant on the roster.
 *
 * @category models
 * @since 0.1.0
 */
export const PresenceOptions = Schema.Struct({
  leaseMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /**
   * Roster changes a stalled {@link Service.changes} subscriber may fall
   * behind by. Defaults to {@link defaultChangesCapacity}.
   */
  changesCapacity: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
})
/**
 * The value form of {@link PresenceOptions}.
 *
 * @category models
 * @since 0.1.0
 */
export type PresenceOptions = typeof PresenceOptions.Type

/**
 * Roster changes a stalled {@link Service.changes} subscriber may fall behind
 * by before the oldest are dropped.
 *
 * Presence is a lease table, and `changes` only says that some branch's roster
 * moved: a follower answers it with `list`. Holding an unbounded backlog for a
 * subscriber that has stopped pulling would let one abandoned watcher retain
 * every announcement the process has seen since. A subscriber that falls
 * further behind than this bound loses the oldest notifications and re-lists;
 * because every notification is answered by a fresh `list`, dropping one never
 * loses roster state.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultChangesCapacity = 256

const key = (branchId: BranchId, participantId: ParticipantId): string => `${branchId}\u0000${participantId}`

/**
 * Constructs the in-memory, lease-expiring presence registry.
 *
 * Announcing requires write access: a read-only share link may watch the
 * roster but never appears on it, so a shared read link cannot be used to
 * impersonate a collaborator.
 *
 * The change feed slides at {@link defaultChangesCapacity}: announcing never
 * waits on a stalled watcher, and never grows the process on its behalf.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeMemory = (options: PresenceOptions): Effect.Effect<Service, never, BranchShare.BranchShare> =>
  Effect.gen(function*() {
    const share = yield* BranchShare.BranchShare
    const roster = new Map<string, Participant>()
    const changes = yield* PubSub.sliding<BranchId>(options.changesCapacity ?? defaultChangesCapacity)

    /** Drops every lease that has run out, so expiry needs no timer fiber. */
    const live = (branchId: BranchId, nowMs: number): Array<Participant> => {
      const remaining: Array<Participant> = []
      for (const [entryKey, participant] of roster) {
        if (participant.leaseExpiresAtMs <= nowMs) {
          roster.delete(entryKey)
          continue
        }
        if (participant.branchId === branchId) remaining.push(participant)
      }
      return remaining.sort((left, right) => left.participantId < right.participantId ? -1 : 1)
    }

    const announce = Effect.fn("BranchPresence.announce")(function*(announcement: Announcement) {
      yield* Effect.annotateCurrentSpan({
        branchId: announcement.branchId,
        participantId: announcement.participantId
      })
      yield* share.verify(announcement.capability, { branchId: announcement.branchId, access: "write" })
      const nowMs = yield* Clock.currentTimeMillis
      const participant = new Participant({
        branchId: announcement.branchId,
        participantId: announcement.participantId,
        displayName: announcement.displayName,
        cursor: announcement.cursor === null
          ? null
          : new Cursor({ cardId: announcement.cursor.cardId, offset: announcement.cursor.offset }),
        leaseExpiresAtMs: nowMs + options.leaseMs
      })
      roster.set(key(announcement.branchId, announcement.participantId), participant)
      yield* PubSub.publish(changes, announcement.branchId)
      return participant
    })

    const leave = Effect.fn("BranchPresence.leave")(function*(request: LeaveRequest) {
      yield* Effect.annotateCurrentSpan({ branchId: request.branchId, participantId: request.participantId })
      yield* share.verify(request.capability, { branchId: request.branchId, access: "write" })
      roster.delete(key(request.branchId, request.participantId))
      yield* PubSub.publish(changes, request.branchId)
    })

    const list = Effect.fn("BranchPresence.list")(function*(request: RosterRequest) {
      yield* Effect.annotateCurrentSpan({ branchId: request.branchId })
      yield* share.verify(request.capability, { branchId: request.branchId, access: "read" })
      return live(request.branchId, yield* Clock.currentTimeMillis)
    })

    return make({ announce, leave, list, changes: Stream.fromPubSub(changes) })
  })

/**
 * Provides the in-memory, lease-expiring presence registry.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: PresenceOptions
): Layer.Layer<BranchPresence, never, BranchShare.BranchShare> => Layer.effect(BranchPresence, makeMemory(options))
