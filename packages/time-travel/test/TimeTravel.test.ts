/**
 * Service-level cover for the one public time-travel door.
 *
 * The module suites next door drive `Replay`, `Fork`, `Rewind`, and `Recovery`
 * directly; this one only asserts what the service adds — that the three verbs
 * are reachable with nothing but a `Position`, that the fork workspace and the
 * rewind ownership claim are derived internally, and that an interrupted
 * rewind is resolved while the layer is being built rather than by a call the
 * user has to remember to make.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import { RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as CompensationHandlers from "../src/CompensationHandlers.ts"
import * as Fork from "../src/internal/Fork.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { TimeTravel } from "../src/TimeTravel.ts"
import type { Audit } from "../src/TimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"
import { jjInstalled, parkSealedFlow, runRealEngine, withRealFixture } from "./RealTimeTravelHarness.ts"

const lineageId = "run/root"

const record = (seq: number, amount: number): MemoryTimeTravelStore.JournalRecord => ({
  runId: "run",
  seq,
  eventId: `event-${seq}`,
  lineageId,
  payload: {
    eventType: "test.credited",
    payload: { amount },
    meta: { lineageId }
  }
})

const row = (runId: string): RunStore.RunRow => ({
  runId,
  status: "suspended",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{}"
})

const makeRuns = (): RunStore.Service => {
  const state = new Map([["run", { ...row("run") }]])
  return RunStore.makeNoop({
    get: (runId) => {
      const found = state.get(runId)
      return found === undefined
        ? Effect.fail(
          new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "missing", cause: runId })
        )
        : Effect.succeed({ ...found })
    },
    claim: (runId, _expected, claimant, nowMs) =>
      Effect.sync(() => {
        const found = state.get(runId)!
        found.claim = claimant
        found.claimedAtMs = nowMs
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    activate: (runId, claimant, claimedAtMs) =>
      Effect.sync(() => {
        const found = state.get(runId)!
        found.status = "running"
        found.owner = claimant
        found.heartbeatAtMs = claimedAtMs
        found.claim = null
        found.claimedAtMs = null
        return { _tag: "Activated" as const }
      }),
    transitionOwned: (runId, currentOwner, status) =>
      Effect.sync(() => {
        const found = state.get(runId)!
        if (found.owner?.nonce !== currentOwner.nonce) return { _tag: "FenceLost" as const }
        found.status = status
        found.owner = null
        found.heartbeatAtMs = null
        return { _tag: "Transitioned" as const }
      })
  })
}

const makeJournal = (store: ReturnType<typeof MemoryTimeTravelStore.make>): Journal.Service =>
  Journal.makeNoop({
    entries: ({ after, limit, runId }) =>
      Effect.sync(() => {
        const all = store.state().records
          .filter((entry) => entry.runId === runId && entry.seq > (after ?? -1))
          .sort((left, right) => left.seq - right.seq)
        const selected = all.slice(0, limit)
        return {
          entries: selected.map((entry) => {
            const stored = entry.payload as {
              readonly eventType: string
              readonly payload: unknown
              readonly meta: unknown
            }
            return {
              runId: entry.runId as JournalEvent.RunId,
              seq: entry.seq as JournalEvent.Seq,
              eventId: entry.eventId,
              sourceId: "test" as JournalEvent.SourceId,
              sourceSeq: entry.seq as JournalEvent.SourceSeq,
              emittedAtMs: entry.seq,
              eventType: stored.eventType,
              payload: stored.payload,
              meta: stored.meta
            } as JournalEvent.Entry
          }),
          hasMore: all.length > selected.length
        }
      })
  })

const harness = (options: {
  readonly store: ReturnType<typeof MemoryTimeTravelStore.make>
  readonly workspaces?: Array<string>
}) =>
  TimeTravel.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(TimeTravelStore)(options.store),
        Layer.succeed(RunStore.RunStore)(makeRuns()),
        Layer.succeed(Journal.Journal)(makeJournal(options.store)),
        Layer.succeed(Jj.Jj)(
          Jj.makeNoop({
            snapshot: () => Effect.succeed({ changeId: "current" }),
            workspaceAdd: (name, path) =>
              Effect.sync(() => {
                options.workspaces?.push(`${name}@${path}`)
              }),
            workspaceForget: () => Effect.void
          })
        ),
        CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })
      )
    )
  )

const run = <A>(
  store: ReturnType<typeof MemoryTimeTravelStore.make>,
  body: (timeTravel: TimeTravel["Service"]) => Effect.Effect<A, unknown>,
  workspaces?: Array<string>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const timeTravel = yield* TimeTravel
      return yield* body(timeTravel)
    }).pipe(
      Effect.provide(harness({ store, ...(workspaces === undefined ? {} : { workspaces }) })),
      Effect.orDie
    )
  )

describe("TimeTravel", () => {
  it.effect("inspects a position by folding committed evidence up to the frame", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [record(0, 10), record(1, 20), record(2, 30)]
      })

      const total = yield* run(store, (timeTravel) =>
        timeTravel.inspect(
          { runId: "run", frame: { lineageId, seq: 1 } },
          {
            initial: 0,
            reduce: (state: number, entry) => {
              const payload = entry.payload as { readonly amount?: number } | null
              return state + (payload?.amount ?? 0)
            }
          }
        ))

      expect(total).toBe(30)
    }))

  it.effect("forks at a position and derives the workspace name and path itself", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10), record(1, 20)] })
      const workspaces: Array<string> = []

      const fork = yield* run(
        store,
        (timeTravel) => timeTravel.fork({ runId: "run", frame: { lineageId, seq: 1 } }),
        workspaces
      )

      expect(fork.edge).toMatchObject({ parentRunId: "run", parentSeq: 1, kind: "fork" })
      expect(fork.runId).toBe("run:fork:1")
      // Derived, never caller-supplied: the CHILD names the lane, so a second
      // fork of this frame lands beside this one rather than on top of it.
      const lane = Fork.workspaceNameFor(fork.runId)
      expect(workspaces).toEqual([`${lane}@.flows/forks/${lane}`])
    }))

  it.effect("rewinds at a position with the ownership claim wired internally", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [record(0, 10), record(1, 20), record(2, 30), record(3, 40)]
      })

      const result = yield* run(
        store,
        (timeTravel) => timeTravel.rewind({ runId: "run", frame: { lineageId, seq: 1 } })
      )

      expect(result.archive.archived).toBe(2)
      expect(store.state().records.map((entry) => entry.seq)).toEqual([0, 1])
      expect(store.state().audits.map((audit) => audit.status)).toEqual(["completed"])
    }))

  it.effect("honours the only two knobs it takes: fork root and rewind paging", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [record(0, 10), record(1, 20), record(2, 30), record(3, 40)]
      })
      const workspaces: Array<string> = []

      const result = yield* run(
        store,
        (timeTravel) =>
          Effect.gen(function*() {
            yield* timeTravel.fork({ runId: "run", frame: { lineageId, seq: 1 } }, {
              workspaceRoot: "/tmp/lanes"
            })
            return yield* timeTravel.rewind({ runId: "run", frame: { lineageId, seq: 1 } }, {
              detachedChildren: "cancel",
              pageSize: 1
            })
          }),
        workspaces
      )

      const lane = Fork.workspaceNameFor("run:fork:1")
      expect(workspaces).toEqual([`${lane}@/tmp/lanes/${lane}`])
      expect(result.archive.archived).toBe(2)
    }))

  it.effect("resolves an interrupted rewind while the layer is built", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [record(0, 10), record(1, 20), record(2, 30)]
      })
      const interrupted: Audit = {
        id: "run:interrupted",
        runId: "run",
        frame: { lineageId, seq: 1 },
        status: "in_progress",
        detail: {
          version: 1,
          phase: "preflight_complete",
          originalStatus: "suspended",
          suffixCount: 1,
          warnings: [],
          cancelledChildren: []
        }
      }
      yield* (store.writeAudit(interrupted).pipe(Effect.orDie))

      // No user call: merely acquiring the service resolves the audit.
      const audits = yield* run(store, () => Effect.succeed(store.state().audits))

      expect(audits.map((audit) => audit.status)).toEqual(["failed"])
      expect(audits[0]?.detail).toMatchObject({ phase: "rolled_back" })
      // The suffix the interrupted rewind never committed is still there.
      expect(store.state().records.map((entry) => entry.seq)).toEqual([0, 1, 2])
    }))
})

describe("TimeTravel wiring", () => {
  it.effect("mints distinct deterministic owners while preserving the durable service key across restart layers", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [
          record(0, 10),
          record(1, 20)
        ]
      })
      let current = row("run")
      const claimedOwners: Array<{ readonly hostId: string; readonly nonce: string }> = []
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed({ ...current }),
        claim: (_runId, _expected, claimant, nowMs) =>
          Effect.sync(() => {
            claimedOwners.push(claimant)
            if (current.status === "running" || current.claim !== null) {
              return { _tag: "AlreadyClaimed" as const }
            }
            current = { ...current, claim: claimant, claimedAtMs: nowMs }
            return { _tag: "Claimed" as const, claimedAtMs: nowMs }
          }),
        activate: (_runId, claimant, claimedAtMs) =>
          Effect.sync(() => {
            if (current.claim?.nonce !== claimant.nonce) return { _tag: "ClaimLost" as const }
            current = {
              ...current,
              status: "running",
              owner: claimant,
              heartbeatAtMs: claimedAtMs,
              claim: null,
              claimedAtMs: null
            }
            return { _tag: "Activated" as const }
          }),
        transitionOwned: (_runId, claimant, status) =>
          Effect.sync(() => {
            if (current.owner?.nonce !== claimant.nonce) return { _tag: "FenceLost" as const }
            current = { ...current, status, owner: null, heartbeatAtMs: null }
            return { _tag: "Transitioned" as const }
          })
      })
      const entered = Effect.runSync(Deferred.make<void>())
      const release = Effect.runSync(Deferred.make<void>())
      let suffixReaders = 0
      const blockingJournal = Journal.makeNoop({
        entries: ({ after, limit }) => {
          const page = makeJournal(store).entries({
            runId: "run" as JournalEvent.RunId,
            ...(after === undefined ? {} : { after }),
            limit
          })
          if (after === undefined || suffixReaders > 0) return page
          suffixReaders += 1
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(page)
          )
        }
      })
      const dependencies = Layer.mergeAll(
        Layer.succeed(TimeTravelStore)(store),
        Layer.succeed(RunStore.RunStore)(runs),
        Layer.succeed(Journal.Journal)(blockingJournal),
        Layer.succeed(Jj.Jj)(Jj.makeNoop({ snapshot: () => Effect.succeed({ changeId: "current" }) })),
        CacheStore.layerNoop()
      )
      const serviceLayer = TimeTravel.layer.pipe(Layer.provide(dependencies))
      const fixedClock: Clock.Clock = {
        currentTimeMillisUnsafe: () => 1_000,
        currentTimeMillis: Effect.succeed(1_000),
        currentTimeNanosUnsafe: () => 1_000_000_000n,
        currentTimeNanos: Effect.succeed(1_000_000_000n),
        monotonicTimeNanosUnsafe: () => 1_000_000_000n,
        monotonicTimeNanos: Effect.succeed(1_000_000_000n),
        sleep: () => Effect.void
      }

      const result = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const firstContext = yield* Layer.build(serviceLayer).pipe(Random.withSeed("owner-a"))
            const secondContext = yield* Layer.build(serviceLayer).pipe(Random.withSeed("owner-b"))
            const first = Context.get(firstContext, TimeTravel)
            const second = Context.get(secondContext, TimeTravel)
            const position = { runId: "run", frame: { lineageId, seq: 0 } } as const
            const winner = yield* Effect.forkChild(first.rewind(position), { startImmediately: true })
            yield* Deferred.await(entered)
            const loser = yield* Effect.exit(second.rewind(position))
            yield* Deferred.succeed(release, undefined)
            const won = yield* Fiber.join(winner)
            const completedAfterRace = store.state().audits.filter((audit) => audit.status === "completed").length
            const secondPass = yield* second.rewind(position)
            return { completedAfterRace, loser, secondPass, won }
          }).pipe(Effect.provideService(Clock.Clock, fixedClock))
        )
      )

      expect(result.won.archive.archived).toBe(1)
      expect(result.loser._tag).toBe("Failure")
      expect(result.completedAfterRace).toBe(1)
      expect(result.secondPass.archive.archived).toBe(0)
      expect(claimedOwners).toHaveLength(2)
      expect(claimedOwners[0]).not.toEqual(claimedOwners[1])
      expect(TimeTravel.key).toBe("@smthrs/time-travel/TimeTravel")
      expect(store.state().audits.filter((audit) => audit.status === "completed")).toHaveLength(2)
    }))

  // The finite budget covers two independent production engine/service lifetimes over one file database.
  it.effect.skipIf(!jjInstalled)(
    "keeps the TimeTravel service-key component of step identity stable across an engine restart",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-time-travel-identity-", (fixture) =>
          Effect.gen(function*() {
            let dispatches = 0
            const execute = Effect.sync(() => {
              dispatches += 1
              return "stable"
            })
            const drive = (hostId: string) =>
              runRealEngine(
                fixture.databaseFile,
                hostId,
                Effect.gen(function*() {
                  yield* parkSealedFlow("identity-run", execute)
                  const journal = yield* Journal.Journal
                  yield* journal.flush
                  const sql = yield* Effect.service(SqlClient.SqlClient)
                  return yield* sql<{
                    readonly attempt: number
                    readonly step_key_digest: string
                  }>`
                SELECT step_key_digest, attempt
                FROM flows_attempts
                WHERE run_id = 'identity-run'
                ORDER BY step_key_digest, attempt
              `
                })
              )

            const first = yield* drive("identity-first")
            const restarted = yield* drive("identity-second")

            expect(first).toHaveLength(2)
            expect(restarted).toEqual(first)
            expect(new Set(restarted.map((row) => row.step_key_digest)).size).toBe(2)
            expect(dispatches).toBe(1)
            expect(TimeTravel.key).toBe("@smthrs/time-travel/TimeTravel")
          }))
      }),
    { timeout: 30_000 }
  )

  it.effect("logs and continues when the frame-anchor projection cannot run", () =>
    Effect.gen(function*() {
      // The anchor table is a cache of journal facts, so a journal that cannot be
      // paged for anchoring must not turn a verb into a failure of its own. The
      // fork still reaches its suffix read, and THAT is what fails here.
      const store = MemoryTimeTravelStore.make()
      const failure = yield* (
        Effect.flip(
          Effect.scoped(
            Effect.gen(function*() {
              const timeTravel = yield* TimeTravel
              return yield* timeTravel.fork({ runId: "run", frame: { lineageId, seq: 0 } })
            }).pipe(
              Effect.provide(
                TimeTravel.layer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      Layer.succeed(TimeTravelStore)(store),
                      Layer.succeed(RunStore.RunStore)(makeRuns()),
                      Layer.succeed(Journal.Journal)(Journal.makeNoop()),
                      Layer.succeed(Jj.Jj)(Jj.makeNoop({})),
                      CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })
                    )
                  )
                )
              )
            )
          )
        ) as unknown as Effect.Effect<{ readonly message: string }>
      )

      expect(failure.message).toBe("could not read fork suffix for run")
    }))

  it.effect("maps every member of a contributed handler onto the internal registry", () =>
    Effect.gen(function*() {
      // The door is `CompensationHandlers`; the registry behind it stays internal.
      // A handler that declares its optional members must arrive with them.
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10)] })
      const total = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const timeTravel = yield* TimeTravel
            return yield* timeTravel.inspect({ runId: "run", frame: { lineageId, seq: 0 } }, {
              initial: 0,
              reduce: (state: number, entry) => state + ((entry.payload as { amount: number }).amount ?? 0)
            })
          }).pipe(
            Effect.provide(
              TimeTravel.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    CompensationHandlers.layer([{
                      kind: "billing/Charge",
                      tier: "irreversible",
                      requiresIdempotencyKey: true,
                      residue: () => "The charge stands.",
                      assess: () =>
                        Effect.succeed({ classification: "warning" as const, reason: "policy", residue: "stands" }),
                      revert: () => Effect.succeed({}),
                      rollback: () => Effect.void
                    }]),
                    Layer.succeed(TimeTravelStore)(store),
                    Layer.succeed(RunStore.RunStore)(makeRuns()),
                    Layer.succeed(Journal.Journal)(makeJournal(store)),
                    Layer.succeed(Jj.Jj)(Jj.makeNoop({})),
                    CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })
                  )
                )
              )
            ),
            Effect.orDie
          )
        )
      )

      expect(total).toBe(10)
    }))
})
