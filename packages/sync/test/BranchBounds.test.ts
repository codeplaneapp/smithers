/**
 * Bounds and isolation on the branch write path: the receipt ledger, the
 * roster, the per-branch admission permit, and the replay walk that runs
 * inside it.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchPresence from "../src/BranchPresence.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import { SyncError } from "../src/SyncError.ts"

const branchId = "bounded-branch" as BranchProtocol.BranchId
const otherBranchId = "bounded-other" as BranchProtocol.BranchId
const alice = "alice" as BranchProtocol.ParticipantId
const commandId = (id: string) => id as BranchProtocol.CommandId

const shareLayer = BranchShare.layerHmac({ secret: Redacted.make("bounds-secret") })

const capabilityFor = (target: BranchProtocol.BranchId) =>
  Effect.flatMap(
    BranchShare.BranchShare,
    (share) => share.mint({ branchId: target, capabilityId: `cap-${target}`, access: "write", ttlMs: 600_000 })
  )

const durable = <A, E>(effect: Effect.Effect<A, E, Journal.Journal | BranchShare.BranchShare>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(TestJournal.layer(), shareLayer)),
    Effect.provide(TestClock.layer())
  )

describe("BranchCommands identity and bounds", () => {
  // `${branchId} ${commandId}` collides for valid branded strings: `("a",
  // "b c")` and `("a b", "c")` produced the same key, so one branch's receipt
  // answered another branch's command as a duplicate and the second command
  // was never admitted at all.
  it.effect("keeps two branches' commands apart when their ids share a delimiter", () =>
    Effect.gen(function*() {
      const [first, second, entries] = yield* durable(
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const left = "a" as BranchProtocol.BranchId
          const right = "a b" as BranchProtocol.BranchId
          const leftReceipt = yield* commands.submit({
            capability: yield* capabilityFor(left),
            submission: BranchCommands.submission({
              branchId: left,
              commandId: commandId("b c"),
              participantId: alice,
              name: BranchProtocol.SayCommand
            })
          })
          const rightReceipt = yield* commands.submit({
            capability: yield* capabilityFor(right),
            submission: BranchCommands.submission({
              branchId: right,
              commandId: commandId("c"),
              participantId: alice,
              name: BranchProtocol.SayCommand
            })
          })
          const journal = yield* Journal.Journal
          const page = yield* journal.entries({ runId: BranchProtocol.branchRunId(right), limit: 10 })
          return [leftReceipt, rightReceipt, page.entries] as const
        })
      )

      expect(first.status).toBe("admitted")
      // The second command is its own admission, not the first one's receipt.
      expect(second.status).toBe("admitted")
      expect(second.branchId).toBe("a b")
      expect(entries).toHaveLength(1)
    }))

  // The ledger is a FAST PATH. Losing an entry costs a journal round trip and
  // never correctness, because the journal's own producer identity is the
  // durable exactly-once constraint and answers a known command with a
  // `Duplicate` receipt. That is what makes it safe to bound.
  it.effect("evicts the oldest receipts past the ledger capacity and still dedupes durably", () =>
    Effect.gen(function*() {
      const [first, evicted] = yield* durable(
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLiveWith({ ledgerCapacity: 2 })
          const capability = yield* capabilityFor(branchId)
          const submit = (id: string) =>
            commands.submit({
              capability,
              submission: BranchCommands.submission({
                branchId,
                commandId: commandId(id),
                participantId: alice,
                name: BranchProtocol.SayCommand
              })
            })
          const original = yield* submit("c1")
          yield* submit("c2")
          yield* submit("c3")
          // c1 has been evicted from memory; the journal still refuses to
          // append it twice and hands back the canonical sequence.
          return [original, yield* submit("c1")] as const
        })
      )

      expect(first.status).toBe("admitted")
      expect(evicted.status).toBe("duplicate")
      expect(evicted.seq).toBe(first.seq)
    }))

  it.effect("refuses a ledger policy that is not a positive safe integer", () =>
    Effect.gen(function*() {
      const refusals = yield* durable(
        Effect.gen(function*() {
          return [
            yield* Effect.flip(BranchCommands.makeLiveWith({ ledgerCapacity: 0 })),
            yield* Effect.flip(BranchCommands.makeLiveWith({ maxCommandBytes: Number.NaN }))
          ] as const
        })
      )

      for (const refusal of refusals) {
        expect(refusal.code).toBe("invalid_request")
        expect(refusal.message).toContain("BranchCommands.Options")
      }
    }))

  // `SyncServer.tail` has carried this guard, with a comment explaining it,
  // since it was written; `replay` did not, and it runs inside the admission
  // permit, so a journal reporting more without returning any wedged the
  // branch permanently with no timeout and no cancellation getting through.
  it.effect("ends the replay walk on an empty page whatever the page claims", () =>
    Effect.gen(function*() {
      const outcome = yield* (
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const capability = yield* capabilityFor(branchId)
          return yield* Effect.exit(
            commands.submit({
              capability,
              submission: BranchCommands.submission({
                branchId,
                commandId: commandId("c1"),
                participantId: alice,
                name: BranchProtocol.SayCommand
              })
            })
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                // A journal that always reports more and never returns any.
                entries: () => Effect.succeed({ entries: [], hasMore: true })
              }),
              shareLayer
            )
          ),
          Effect.provide(TestClock.layer()),
          Effect.timeoutOption("5 seconds")
        )
      )

      // Returned at all, rather than spinning forever holding the permit.
      expect(outcome._tag).toBe("Some")
    }))

  // One process-wide permit serialized admission across every branch the
  // process served, so one branch's first-touch history replay blocked every
  // other branch's writes. The permit is per branch.
  it.effect("admits on one branch while another branch's journal is stuck", () =>
    Effect.gen(function*() {
      const outcome = yield* (
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const stuckCapability = yield* capabilityFor(otherBranchId)
          const liveCapability = yield* capabilityFor(branchId)
          const submit = (target: BranchProtocol.BranchId, capability: BranchProtocol.ShareCapability) =>
            commands.submit({
              capability,
              submission: BranchCommands.submission({
                branchId: target,
                commandId: commandId(`cmd-${target}`),
                participantId: alice,
                name: BranchProtocol.SayCommand
              })
            })
          yield* Effect.forkChild(submit(otherBranchId, stuckCapability), { startImmediately: true })
          return yield* submit(branchId, liveCapability)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ runId }) =>
                  runId === BranchProtocol.branchRunId(otherBranchId)
                    // The stuck branch's replay never returns.
                    ? Effect.never
                    : Effect.succeed({ entries: [], hasMore: false }),
                emitDurableUnfenced: () =>
                  Effect.succeed({ _tag: "Durable", seq: 1 } as unknown as Journal.DurableReceipt)
              }),
              shareLayer
            )
          ),
          Effect.provide(TestClock.layer()),
          Effect.timeoutOption("5 seconds"),
          Effect.scoped
        )
      )

      expect(outcome._tag).toBe("Some")
    }))
})

describe("BranchPresence roster bounds", () => {
  const presenceLayer = (options: BranchPresence.PresenceOptions) =>
    BranchPresence.layer(options).pipe(Layer.provideMerge(shareLayer))

  const withPresence = <A, E>(
    options: BranchPresence.PresenceOptions,
    effect: Effect.Effect<A, E, BranchPresence.BranchPresence | BranchShare.BranchShare>
  ) => effect.pipe(Effect.provide(presenceLayer(options)), Effect.provide(TestClock.layer()))

  // Nothing capped how many distinct participants one write capability could
  // announce, so a single share link could pin an arbitrary number of
  // `Participant` objects until their leases expired, and every one of them
  // was walked on every `list` and returned whole by `Branch.Roster`.
  it.effect("refuses an announcement past the participant ceiling with backpressure", () =>
    Effect.gen(function*() {
      const [roster, refusal] = yield* withPresence(
        { leaseMs: 60_000, maxParticipants: 2 },
        Effect.gen(function*() {
          const presence = yield* BranchPresence.BranchPresence
          const capability = yield* capabilityFor(branchId)
          const announce = (participantId: string) =>
            presence.announce({
              capability,
              branchId,
              participantId: participantId as BranchProtocol.ParticipantId,
              displayName: participantId,
              cursor: null
            })
          yield* announce("p1")
          yield* announce("p2")
          const denied = yield* Effect.flip(announce("p3"))
          // A participant already on the roster still heartbeats through.
          yield* announce("p1")
          return [yield* presence.list({ capability, branchId }), denied] as const
        })
      )

      expect(roster.map((participant) => participant.participantId)).toEqual(["p1", "p2"])
      expect(SyncError.is(refusal)).toBe(true)
      expect(refusal.code).toBe("backpressure")
    }))

  // A roster keyed by one flat `${branchId} ${participantId}` string made a
  // `list` for one branch walk every participant in the process, and let two
  // branches share a slot.
  it.effect("keeps each branch's roster to itself", () =>
    Effect.gen(function*() {
      const [left, right] = yield* withPresence(
        { leaseMs: 60_000 },
        Effect.gen(function*() {
          const presence = yield* BranchPresence.BranchPresence
          const leftBranch = "a" as BranchProtocol.BranchId
          const rightBranch = "a b" as BranchProtocol.BranchId
          const leftCapability = yield* capabilityFor(leftBranch)
          const rightCapability = yield* capabilityFor(rightBranch)
          yield* presence.announce({
            capability: leftCapability,
            branchId: leftBranch,
            participantId: "b c" as BranchProtocol.ParticipantId,
            displayName: "Left",
            cursor: null
          })
          yield* presence.announce({
            capability: rightCapability,
            branchId: rightBranch,
            participantId: "c" as BranchProtocol.ParticipantId,
            displayName: "Right",
            cursor: null
          })
          return [
            yield* presence.list({ capability: leftCapability, branchId: leftBranch }),
            yield* presence.list({ capability: rightCapability, branchId: rightBranch })
          ] as const
        })
      )

      expect(left.map((participant) => participant.displayName)).toEqual(["Left"])
      expect(right.map((participant) => participant.displayName)).toEqual(["Right"])
    }))

  // A roster keyed per branch has to drop the branch's own map when the last
  // participant goes, and leave every other branch alone. A leave for a branch
  // nobody is on is a no-op that still publishes, because the change feed is
  // what a watcher answers with a fresh list.
  it.effect("removes one participant without disturbing the others, and tolerates an unknown branch", () =>
    Effect.gen(function*() {
      const [remaining, afterAll, unknownBranch] = yield* withPresence(
        { leaseMs: 60_000 },
        Effect.gen(function*() {
          const presence = yield* BranchPresence.BranchPresence
          const capability = yield* capabilityFor(branchId)
          const otherCapability = yield* capabilityFor(otherBranchId)
          const announce = (participantId: string) =>
            presence.announce({
              capability,
              branchId,
              participantId: participantId as BranchProtocol.ParticipantId,
              displayName: participantId,
              cursor: null
            })
          yield* announce("p1")
          yield* announce("p2")
          yield* presence.leave({
            capability,
            branchId,
            participantId: "p1" as BranchProtocol.ParticipantId
          })
          const withOneLeft = yield* presence.list({ capability, branchId })
          yield* presence.leave({
            capability,
            branchId,
            participantId: "p2" as BranchProtocol.ParticipantId
          })
          // Nobody has ever been on this branch.
          yield* presence.leave({
            branchId: otherBranchId,
            capability: otherCapability,
            participantId: "ghost" as BranchProtocol.ParticipantId
          })
          return [
            withOneLeft,
            yield* presence.list({ capability, branchId }),
            yield* presence.list({ capability: otherCapability, branchId: otherBranchId })
          ] as const
        })
      )

      expect(remaining.map((participant) => participant.participantId)).toEqual(["p2"])
      expect(afterAll).toEqual([])
      expect(unknownBranch).toEqual([])
    }))

  it.effect("refuses a presence policy that is not a positive safe integer", () =>
    Effect.gen(function*() {
      const refusals = yield* (
        Effect.gen(function*() {
          return [
            yield* Effect.flip(BranchPresence.makeMemory({ leaseMs: 0 })),
            yield* Effect.flip(BranchPresence.makeMemory({ leaseMs: 10, changesCapacity: Number.NaN })),
            yield* Effect.flip(BranchPresence.makeMemory({ leaseMs: 10, maxParticipants: -3 }))
          ] as const
        }).pipe(Effect.provide(shareLayer), Effect.provide(TestClock.layer()))
      )

      for (const refusal of refusals) {
        expect(refusal.code).toBe("invalid_request")
        expect(refusal.message).toContain("BranchPresence.PresenceOptions")
      }
    }))
})
