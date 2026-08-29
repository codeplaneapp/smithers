import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import { SyncError } from "../src/SyncError.ts"

const branchId = "live-branch" as BranchProtocol.BranchId
const otherBranchId = "other-branch" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
const alice = "alice" as BranchProtocol.ParticipantId
const bob = "bob" as BranchProtocol.ParticipantId
const commandId = (id: string) => id as BranchProtocol.CommandId

const shareLayer = BranchShare.layerHmac({ secret: "commands-secret" })

const capabilityFor = (target: BranchProtocol.BranchId, access: BranchProtocol.Access) =>
  Effect.flatMap(
    BranchShare.BranchShare,
    (share) => share.mint({ branchId: target, capabilityId: `cap-${target}`, access, ttlMs: 600_000 })
  )

const durable = <A, E>(effect: Effect.Effect<A, E, Journal.Journal | BranchShare.BranchShare>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(TestJournal.layer(), shareLayer)),
    Effect.provide(TestClock.layer())
  )

const entriesOf = Effect.flatMap(
  Journal.Journal,
  (journal) => journal.entries({ runId, limit: 100 })
)

describe("BranchCommands", () => {
  it.effect("admits one command and records it on the branch journal", () =>
    Effect.gen(function*() {
      const [receipt, page] = yield* durable(
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const capability = yield* capabilityFor(branchId, "write")
          const admitted = yield* commands.submit({
            capability,
            submission: BranchCommands.submission({
              branchId,
              commandId: commandId("c1"),
              participantId: alice,
              name: BranchProtocol.SayCommand,
              args: "hello"
            })
          })
          return [admitted, yield* entriesOf] as const
        })
      )

      expect(receipt.status).toBe("admitted")
      expect(page.entries).toHaveLength(1)
      expect(page.entries[0]?.eventType).toBe(BranchProtocol.CommandEvent)
      // The producer identity IS the exactly-once constraint: it must derive
      // from the command, not the participant, so two servers racing the same
      // command collide durably inside the journal.
      expect(page.entries[0]?.sourceId).toBe(BranchProtocol.commandSourceId(commandId("c1")))
      expect(page.entries[0]?.sourceSeq).toBe(BranchProtocol.commandSourceSeq)
      expect(page.entries[0]?.seq).toBe(receipt.seq)
    }))

  it.effect("dedupes a retransmission to the original sequence without a second write", () =>
    Effect.gen(function*() {
      const [first, retry, page] = yield* durable(
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const capability = yield* capabilityFor(branchId, "write")
          const request = {
            capability,
            submission: BranchCommands.submission({
              branchId,
              commandId: commandId("c1"),
              participantId: alice,
              name: "goal",
              args: "ship it"
            })
          }
          return [yield* commands.submit(request), yield* commands.submit(request), yield* entriesOf] as const
        })
      )

      expect(first.status).toBe("admitted")
      expect(retry.status).toBe("duplicate")
      expect(retry.seq).toBe(first.seq)
      expect(page.entries).toHaveLength(1)
    }))

  it.effect("admits exactly once when two clients submit the same command concurrently", () =>
    Effect.gen(function*() {
      const [receipts, page] = yield* durable(
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const capability = yield* capabilityFor(branchId, "write")
          const submit = (participantId: BranchProtocol.ParticipantId) =>
            commands.submit({
              capability,
              submission: BranchCommands.submission({
                branchId,
                commandId: commandId("shared"),
                participantId,
                name: "goal",
                args: "ship it"
              })
            })
          const settled = yield* Effect.all([submit(alice), submit(bob)], { concurrency: "unbounded" })
          return [settled, yield* entriesOf] as const
        })
      )

      expect(receipts.map((receipt) => receipt.status).sort()).toEqual(["admitted", "duplicate"])
      expect(new Set(receipts.map((receipt) => receipt.seq)).size).toBe(1)
      expect(page.entries).toHaveLength(1)
    }))

  it.effect("rehydrates its ledger from the journal, so a restart re-executes nothing", () =>
    Effect.gen(function*() {
      const [first, afterRestart, page] = yield* durable(
        Effect.gen(function*() {
          const capability = yield* capabilityFor(branchId, "write")
          const request = {
            capability,
            submission: BranchCommands.submission({
              branchId,
              commandId: commandId("c1"),
              participantId: alice,
              name: "goal",
              args: "ship it"
            })
          }
          const before = yield* Effect.flatMap(BranchCommands.makeLive, (commands) => commands.submit(request))
          // A second service over the same journal is a restarted server: its
          // ledger is empty until it replays the branch.
          const after = yield* Effect.flatMap(BranchCommands.makeLive, (commands) => commands.submit(request))
          return [before, after, yield* entriesOf] as const
        })
      )

      expect(first.status).toBe("admitted")
      expect(afterRestart.status).toBe("duplicate")
      expect(afterRestart.seq).toBe(first.seq)
      expect(page.entries).toHaveLength(1)
    }))

  it.effect("refuses cross-branch and read-only submissions before taking the admission permit", () =>
    Effect.gen(function*() {
      const [foreignFailure, readFailure, page] = yield* durable(
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const foreign = yield* capabilityFor(otherBranchId, "write")
          const readOnly = yield* capabilityFor(branchId, "read")
          const submission = BranchCommands.submission({
            branchId,
            commandId: commandId("c1"),
            participantId: alice,
            name: BranchProtocol.SayCommand,
            args: "hello"
          })
          return [
            yield* Effect.flip(commands.submit({ capability: foreign, submission })),
            yield* Effect.flip(commands.submit({ capability: readOnly, submission })),
            yield* entriesOf
          ] as const
        })
      )

      expect(foreignFailure.code).toBe("unauthorized")
      expect(readFailure.message).toBe("The share capability is read-only")
      expect(page.entries).toEqual([])
    }))

  it.effect("pages a long branch history and skips entries it did not write", () =>
    Effect.gen(function*() {
      const foreign = new JournalEvent.Entry({
        runId,
        seq: 1 as JournalEvent.Seq,
        eventId: "engine-1",
        sourceId: "flows/engine" as JournalEvent.SourceId,
        sourceSeq: 0 as JournalEvent.SourceSeq,
        emittedAtMs: 0,
        eventType: "flows/engine/step",
        payload: { commandId: "engine" },
        meta: null
      })
      const shapes: ReadonlyArray<unknown> = ["text", null, { commandId: 7 }, { commandId: "c-known" }]
      const history = shapes.map((payload, index) =>
        new JournalEvent.Entry({
          runId,
          seq: (index + 2) as JournalEvent.Seq,
          eventId: `command-${index}`,
          sourceId: BranchProtocol.commandSourceId(commandId(`command-${index}`)),
          sourceSeq: BranchProtocol.commandSourceSeq,
          emittedAtMs: 0,
          eventType: BranchProtocol.CommandEvent,
          payload,
          meta: null
        })
      )
      const pages = [[foreign], history]

      const [known, fresh] = yield* (
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const capability = yield* capabilityFor(branchId, "write")
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
          return [yield* submit("c-known"), yield* submit("c-new")] as const
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ after }) =>
                  Effect.succeed(
                    after === undefined
                      ? { entries: pages[0] ?? [], hasMore: true }
                      : { entries: pages[1] ?? [], hasMore: false }
                  ),
                emitDurableUnfenced: () =>
                  Effect.succeed({
                    _tag: "Accepted",
                    seq: 99 as JournalEvent.Seq,
                    sourceSeq: 9 as JournalEvent.SourceSeq
                  })
              }),
              shareLayer
            )
          ),
          Effect.provide(TestClock.layer())
        )
      )

      expect(known.status).toBe("duplicate")
      expect(known.seq).toBe(5)
      expect(fresh.status).toBe("admitted")
      expect(fresh.seq).toBe(99)
    }))

  it.effect("reports journal failures honestly, whether or not they are Errors", () =>
    Effect.gen(function*() {
      const failureOf = (cause: unknown) =>
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const capability = yield* capabilityFor(branchId, "write")
          return yield* Effect.flip(
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
                entries: () => Effect.fail(cause as Journal.JournalError)
              }),
              shareLayer
            )
          ),
          Effect.provide(TestClock.layer())
        )

      expect((yield* failureOf(new Error("disk is gone"))).message).toBe("disk is gone")
      expect((yield* failureOf("nope")).message).toBe("Branch journal write failed")
    }))

  it.effect("refuses to call a conflict a duplicate when the replay cannot find the winner", () =>
    Effect.gen(function*() {
      // A journal whose conflict report and entries disagree is broken; the
      // ledger must report that honestly instead of minting a receipt for an
      // admission it cannot see.
      const failure = yield* (
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const capability = yield* capabilityFor(branchId, "write")
          return yield* Effect.flip(
            commands.submit({
              capability,
              submission: BranchCommands.submission({
                branchId,
                commandId: commandId("contested"),
                participantId: alice,
                name: BranchProtocol.SayCommand
              })
            })
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: () => Effect.succeed({ entries: [], hasMore: false }),
                emitDurableUnfenced: () =>
                  Effect.fail(
                    new Journal.JournalError({
                      code: "idempotency_conflict",
                      message: "source event reused with different content"
                    })
                  )
              }),
              shareLayer
            )
          ),
          Effect.provide(TestClock.layer())
        )
      )

      expect(failure.code).toBe("unknown")
      expect(failure.message).toBe("source event reused with different content")
    }))

  it.effect("admits nothing through the noop layer, and honours overrides", () =>
    Effect.gen(function*() {
      const capability = new BranchProtocol.ShareCapability({
        claims: new BranchProtocol.ShareClaims({
          branchId,
          capabilityId: "cap",
          access: "write",
          issuedAtMs: 0,
          expiresAtMs: 1
        }),
        signature: ""
      })
      const submission = BranchCommands.submission({
        branchId,
        commandId: commandId("c1"),
        participantId: alice,
        name: BranchProtocol.SayCommand,
        args: "hi",
        target: "title"
      })
      const noop = BranchCommands.makeNoop()

      expect(submission.target).toBe("title")
      expect((yield* (Effect.flip(noop.submit({ capability, submission })))).code).toBe("closed")
      expect(
        (yield* (
          Effect.flip(
            Effect.flatMap(BranchCommands.BranchCommands, (service) => service.submit({ capability, submission })).pipe(
              Effect.provide(BranchCommands.layerNoop)
            )
          )
        )).message
      ).toBe("Branch commands are unavailable")
      expect(
        (yield* (
          Effect.flip(
            BranchCommands.makeNoop({
              submit: () => Effect.fail(new SyncError({ code: "unauthorized", message: "overridden" }))
            }).submit({ capability, submission })
          )
        )).message
      ).toBe("overridden")
      expect(BranchCommands.make(noop).submit).toBe(noop.submit)
    }))

  it.effect("provides the ledger as a layer over the workspace journal", () =>
    Effect.gen(function*() {
      const status = yield* durable(
        Effect.gen(function*() {
          const commands = yield* BranchCommands.BranchCommands
          const capability = yield* capabilityFor(branchId, "write")
          return (yield* commands.submit({
            capability,
            submission: BranchCommands.submission({
              branchId,
              commandId: commandId("c1"),
              participantId: alice,
              name: BranchProtocol.SayCommand
            })
          })).status
        }).pipe(Effect.provide(BranchCommands.layer)) as Effect.Effect<
          string,
          SyncError,
          Journal.Journal | BranchShare.BranchShare
        >
      )

      expect(status).toBe("admitted")
    }))

  it.effect("streams the branch run so a follower resumes from the canonical cursor", () =>
    Effect.gen(function*() {
      const seqs = yield* durable(
        Effect.gen(function*() {
          const commands = yield* BranchCommands.makeLive
          const journal = yield* Journal.Journal
          const capability = yield* capabilityFor(branchId, "write")
          for (const id of ["c1", "c2", "c3"]) {
            yield* commands.submit({
              capability,
              submission: BranchCommands.submission({
                branchId,
                commandId: commandId(id),
                participantId: alice,
                name: BranchProtocol.SayCommand,
                args: id
              })
            })
          }
          const all = yield* journal.entries({ runId, limit: 10 })
          const resumeFrom = all.entries[0]?.seq
          const tail = yield* Stream.runCollect(
            Stream.take(
              journal.stream({ runId, ...(resumeFrom === undefined ? {} : { afterSequence: resumeFrom }) }),
              2
            )
          )
          return Array.from(tail, (entry) => entry.seq)
        })
      )

      expect(seqs).toHaveLength(2)
      expect(seqs[0]).toBeGreaterThan(0)
    }))
})
