/**
 * Retention over the real durable engine schema.
 *
 * Nothing in the composition deleted a `flows_runs` row or any row that hangs
 * off one: a workspace database grew with every run it ever finished, and the
 * journal grew with it because compaction is off by default. These cases drive
 * the retention operation against the production SQLite stores — the same rows
 * the engine writes — and pin the two halves that make it safe to run: every
 * dependent of a deleted run goes with it in the same transaction, and nothing
 * a live run still needs is touched.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as RetentionOps from "../src/internal/RetentionOps.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

// The cases age runs by advancing the virtual clock, and every millisecond of
// virtual time the composition's scheduled work has to be stepped through
// costs real time. Two seconds of virtual age with a one-second threshold
// exercises the same before/after cutoff comparison a day would.
const agingMs = 2_000
const thresholdMs = 1_000
/** Far enough out that no seeded clock deadline comes due mid-case. */
const distantDeadlineMs = 30 * 24 * 60 * 60 * 1000

const owner: Ownership.OwnerId = { hostId: "retention-host", pid: 11, nonce: "retention-nonce" }

const runState = JSON.stringify({ version: 1, flowName: "Retention/Test", payload: {} })

const flowName = "Retention/Test"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "retention-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/** The time-travel archive table, which the engine ladder does not install. */
const createArchiveTable = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_archive (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0),
    event_id TEXT NOT NULL CHECK (length(event_id) > 0),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    source_seq INTEGER NOT NULL CHECK (typeof(source_seq) = 'integer' AND source_seq >= 0),
    emitted_at_ms INTEGER NOT NULL CHECK (typeof(emitted_at_ms) = 'integer' AND emitted_at_ms >= 0),
    event_type TEXT NOT NULL CHECK (length(event_type) > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    meta_json TEXT NOT NULL CHECK (json_valid(meta_json)),
    archived_at_ms INTEGER NOT NULL CHECK (typeof(archived_at_ms) = 'integer' AND archived_at_ms >= 0),
    PRIMARY KEY (run_id, seq)
  )`.pipe(Effect.orDie)
})

const archive = (runId: string, seq: number) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`INSERT INTO flows_time_travel_archive
      (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json, archived_at_ms)
      VALUES (${runId}, ${seq}, ${`${runId}-archive-${seq}`}, ${"retention-test"}, ${seq}, ${0}, ${"archived"}, ${"{}"}, ${"{}"}, ${0})`
      .pipe(Effect.orDie)
  })

const countOf = (table: string, column: string, runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const rows = yield* sql<{ readonly total: number }>`
      SELECT COUNT(*) AS total FROM ${sql.unsafe(table)} WHERE ${sql.unsafe(column)} = ${runId}
    `.pipe(Effect.orDie)
    return Number(rows[0]?.total ?? 0)
  })

/** Every table keyed by a run, and how many rows each holds for one run. */
const footprint = (runId: string) =>
  Effect.all({
    runs: countOf("flows_runs", "run_id", runId),
    attempts: countOf("flows_attempts", "run_id", runId),
    clocks: countOf("flows_clock_deadlines", "execution_id", runId),
    deferreds: countOf("flows_deferred_completions", "execution_id", runId),
    journal: countOf("flows_journal_events", "run_id", runId),
    checkpoints: countOf("flows_journal_checkpoints", "run_id", runId),
    archive: countOf("flows_time_travel_archive", "run_id", runId),
    childEdges: countOf("flows_run_parents", "child_id", runId),
    parentEdges: countOf("flows_run_parents", "parent_id", runId)
  })

/** Creates a run, takes ownership, and leaves it `running` under `owner`. */
const activate = (runId: string, parentRunId?: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, runState, parentRunId === undefined ? undefined : { parentRunId })
    const row = yield* runs.get(runId)
    const expected = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, expected, owner, yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    expect(claim._tag).toBe("Claimed")
    if (claim._tag !== "Claimed") return
    expect(yield* runs.activate(runId, owner, claim.claimedAtMs, expected)).toEqual({ _tag: "Activated" })
  })

/** Everything a finished run leaves behind, on one run id. */
const seedDependents = (runId: string) =>
  Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    const state = yield* DurableEngineState.DurableEngineState
    const journal = yield* Journal.Journal
    const sql = yield* Effect.service(SqlClient.SqlClient)

    yield* attempts.put({
      runId,
      stepKeyDigest: `${runId}-step`,
      attempt: 1,
      state: "succeeded",
      startedAtMs: 0,
      finishedAtMs: 1,
      meta: { tier: "sealed" }
    }, owner).pipe(Effect.orDie)
    yield* state.scheduleClock({
      flowName,
      executionId: runId,
      clockName: `${runId}-clock`,
      deferredName: `${runId}-deferred`,
      dueAtMs: distantDeadlineMs,
      completedAtMs: null
    }, owner)
    yield* state.completeDeferred({
      flowName,
      executionId: runId,
      deferredName: `${runId}-deferred`,
      exit: Exit.succeed("done"),
      completedAtMs: 1
    })
    const receipt = yield* journal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        sourceId: JournalEvent.SourceId.make("retention-test"),
        eventType: "flows.retention.seed",
        payload: { runId }
      })
    ).pipe(Effect.orDie)
    // The checkpoint is written directly: `Journal.checkpoint` is owner-fenced
    // on a `running` row, so a finished run can never carry one written
    // through the service.
    yield* sql`INSERT INTO flows_journal_checkpoints (run_id, seq, state_json, created_at_ms)
      VALUES (${runId}, ${receipt.seq}, ${"{}"}, ${0})`.pipe(Effect.orDie)
    yield* archive(runId, 0)
  })

/** Drives an owned run to a terminal status. */
const finish = (runId: string, status: "completed" | "failed" | "cancelled") =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const outcome = yield* runs.transitionOwned(runId, owner, status)
    expect(outcome).toEqual({ _tag: "Transitioned" })
  })

const statusOf = (runId: string) =>
  Effect.map(Effect.flatMap(RunStore.RunStore, (runs) => runs.get(runId)), (row) => row.status)

const stores = TestStores.layerAt(":memory:")

const retention = Effect.gen(function*() {
  yield* createArchiveTable
  return yield* RetentionOps.make()
})

describe("retention", () => {
  it.effect("deletes aged terminal runs with every dependent row and leaves live runs whole", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const state = yield* DurableEngineState.DurableEngineState

        // Three aged terminal runs, one per terminal status, each carrying an
        // attempt, a pending clock deadline, a deferred completion, a journal
        // entry, a checkpoint, an archive row, and a parent edge.
        for (
          const [runId, status] of [
            ["aged-completed", "completed"],
            ["aged-failed", "failed"],
            ["aged-cancelled", "cancelled"]
          ] as const
        ) {
          yield* activate(runId)
          yield* seedDependents(runId)
          yield* finish(runId, status)
        }
        yield* state.recordRunParent("aged-failed", "aged-completed")

        yield* TestClock.adjust(agingMs)

        // A terminal run inside the retention window, and a live one.
        yield* activate("fresh-completed")
        yield* seedDependents("fresh-completed")
        yield* finish("fresh-completed", "completed")
        yield* activate("still-running")
        yield* seedDependents("still-running")

        const before = yield* footprint("still-running")
        const report = yield* retain.retain({ olderThanMs: thresholdMs })
        const after = yield* footprint("still-running")

        expect([...report.runIds].sort()).toEqual(["aged-cancelled", "aged-completed", "aged-failed"])
        expect(report.runs).toBe(3)
        expect(report.attempts).toBe(3)
        expect(report.clockDeadlines).toBe(3)
        expect(report.deferredCompletions).toBe(3)
        expect(report.journalEntries).toBe(3)
        expect(report.journalCheckpoints).toBe(3)
        expect(report.archiveEntries).toBe(3)
        expect(report.dryRun).toBe(false)

        // Every deleted run is gone from every table that keys on it, parent
        // edges included: the `flows_run_parents_gc` trigger drops those.
        for (const runId of ["aged-completed", "aged-failed", "aged-cancelled"]) {
          expect(yield* footprint(runId)).toEqual({
            runs: 0,
            attempts: 0,
            clocks: 0,
            deferreds: 0,
            journal: 0,
            checkpoints: 0,
            archive: 0,
            childEdges: 0,
            parentEdges: 0
          })
        }

        // The run inside the window and the live run are untouched.
        expect((yield* footprint("fresh-completed")).runs).toBe(1)
        expect((yield* footprint("fresh-completed")).journal).toBe(1)
        expect(after).toEqual(before)
        expect(yield* statusOf("still-running")).toBe("running")
        expect(
          yield* state.clock({ flowName, executionId: "still-running", clockName: "still-running-clock" })
        ).toMatchObject({ _tag: "Some" })
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("keeps an aged terminal run whose descendant is still live", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention

        // grandparent <- parent <- child, all aged and terminal except the
        // child, which is still running. Deleting either ancestor would leave
        // the child's `parent_run_id` dangling.
        yield* activate("grandparent")
        yield* activate("parent", "grandparent")
        yield* activate("child", "parent")
        yield* finish("parent", "completed")
        yield* finish("grandparent", "completed")
        // A second lineage, terminal all the way down, is deleted whole.
        yield* activate("doomed-parent")
        yield* activate("doomed-child", "doomed-parent")
        yield* finish("doomed-child", "completed")
        yield* finish("doomed-parent", "completed")

        yield* TestClock.adjust(agingMs)
        const report = yield* retain.retain({ olderThanMs: thresholdMs })

        expect([...report.runIds].sort()).toEqual(["doomed-child", "doomed-parent"])
        expect([...report.retainedForLiveDescendants].sort()).toEqual(["grandparent", "parent"])
        expect(yield* statusOf("grandparent")).toBe("completed")
        expect(yield* statusOf("parent")).toBe("completed")
        expect(yield* statusOf("child")).toBe("running")
        expect((yield* footprint("doomed-parent")).runs).toBe(0)
        expect((yield* footprint("doomed-child")).runs).toBe(0)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("keeps an aged terminal run whose ancestor is still live", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const state = yield* DurableEngineState.DurableEngineState

        // A live parent that spawned a child, and the child settled first.
        // `agent/await` reads a child's result out of its run row, and a
        // parent parked on an approval, a deferred, or a timer can be parked
        // for longer than the retention threshold before it ever awaits. A
        // pass that collects the child leaves that await with `notFound` and
        // drops the parent's DAG edge with it.
        yield* activate("live-parent")
        yield* activate("finished-child", "live-parent")
        yield* state.recordRunParent("finished-child", "live-parent")
        yield* seedDependents("finished-child")
        yield* finish("finished-child", "completed")

        yield* TestClock.adjust(agingMs)
        const first = yield* retain.retain({ olderThanMs: thresholdMs })

        expect(first.runIds).toEqual([])
        expect(first.retainedForLiveAncestors).toEqual(["finished-child"])
        expect(first.runs).toBe(0)
        const child = yield* footprint("finished-child")
        expect(child.runs).toBe(1)
        expect(child.journal).toBe(1)
        expect(child.childEdges).toBe(1)
        expect((yield* footprint("live-parent")).parentEdges).toBe(1)
        expect(yield* statusOf("finished-child")).toBe("completed")

        // The child becomes collectable when the parent that could still ask
        // for it is finished and aged too.
        yield* finish("live-parent", "completed")
        yield* TestClock.adjust(agingMs)
        const second = yield* retain.retain({ olderThanMs: thresholdMs })

        expect([...second.runIds].sort()).toEqual(["finished-child", "live-parent"])
        expect(second.retainedForLiveAncestors).toEqual([])
        expect((yield* footprint("finished-child")).runs).toBe(0)
        expect((yield* footprint("live-parent")).runs).toBe(0)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("reports what it would delete under dryRun without deleting it", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        yield* activate("aged")
        yield* seedDependents("aged")
        yield* finish("aged", "completed")
        yield* TestClock.adjust(agingMs)

        const planned = yield* retain.retain({ olderThanMs: thresholdMs, dryRun: true })
        const untouched = yield* footprint("aged")
        const executed = yield* retain.retain({ olderThanMs: thresholdMs })

        expect(planned.dryRun).toBe(true)
        expect(planned.runIds).toEqual(["aged"])
        expect(untouched.runs).toBe(1)
        expect(untouched.journal).toBe(1)
        expect({ ...planned, dryRun: false }).toEqual(executed)
        expect((yield* footprint("aged")).runs).toBe(0)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("runs against a database that never installed the time-travel tables", () =>
    withCrypto(
      Effect.gen(function*() {
        // Time-travel block 5000 is not installed by the CLI, so the archive
        // table is absent from an ordinary engine database.
        const retain = yield* RetentionOps.make()
        yield* activate("aged")
        yield* finish("aged", "completed")
        yield* TestClock.adjust(agingMs)

        const report = yield* retain.retain({ olderThanMs: thresholdMs })

        expect(report.runIds).toEqual(["aged"])
        expect(report.archiveEntries).toBe(0)
        expect(yield* countOf("flows_runs", "run_id", "aged")).toBe(0)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("bounds one invocation and converges across invocations", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        for (const runId of ["aged-a", "aged-b", "aged-c"]) {
          yield* activate(runId)
          yield* finish(runId, "completed")
        }
        yield* TestClock.adjust(agingMs)

        // A negative bound is read as zero, the way a negative age is. An
        // interpolated `LIMIT -1` is unbounded in SQLite, so without the clamp
        // a mistyped bound is a full sweep rather than a refused one.
        const refused = yield* retain.retain({ olderThanMs: thresholdMs, limit: -1 })
        expect(refused.runs).toBe(0)
        expect(refused.runIds).toEqual([])

        const first = yield* retain.retain({ olderThanMs: thresholdMs, limit: 2 })
        const second = yield* retain.retain({ olderThanMs: thresholdMs, limit: 2 })
        const third = yield* retain.retain({ olderThanMs: thresholdMs, limit: 2 })

        expect(first.runs).toBe(2)
        expect(second.runs).toBe(1)
        expect(third.runs).toBe(0)
        expect(third.runIds).toEqual([])
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("fails typed when the schema it deletes from is not there", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* activate("aged")
        yield* finish("aged", "completed")
        yield* TestClock.adjust(agingMs)
        yield* sql`DROP TABLE flows_attempts`.pipe(Effect.orDie)

        const exit = yield* Effect.exit(retain.retain({ olderThanMs: thresholdMs }))

        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return
        const error = exit.cause.reasons[0]
        expect(error).toMatchObject({ error: { code: "delete_failed" } })
        // The transaction rolled back: nothing was half-deleted.
        expect(yield* countOf("flows_runs", "run_id", "aged")).toBe(1)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("fails typed before deleting anything when the run table cannot be scanned", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* activate("aged")
        yield* finish("aged", "completed")
        yield* TestClock.adjust(agingMs)
        yield* sql`DROP TABLE flows_runs`.pipe(Effect.orDie)

        const exit = yield* Effect.exit(retain.retain({ olderThanMs: thresholdMs }))

        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return
        expect(exit.cause.reasons[0]).toMatchObject({ error: { code: "scan_failed" } })
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("leaves a parked live run replayable after the finished runs around it are collected", () =>
    withCrypto(
      Effect.gen(function*() {
        const gate = DurableDeferred.make("retention-gate", { success: Schema.String })
        const ReplayFlow = Flow.make("Retention/Replay", {
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        })
        let dispatches = 0
        const first = Action.make({
          name: "first",
          success: Schema.String,
          tier: "sealed",
          idempotencyKey: "retention-first-v1",
          execute: Effect.sync(() => {
            dispatches++
            return "first-result"
          })
        })
        const handler = () =>
          Effect.gen(function*() {
            const head = yield* first
            const winner = yield* DurableDeferred.await(gate)
            return `${head}/${winner}`
          })

        const retain = yield* retention
        const makeEngine = EngineStore.make({
          owner: { hostId: "retention-host" },
          journalSource: "retention-test",
          isAlive: () => Effect.succeed(false)
        })

        // The finished neighbour ages first, before an engine exists: advancing
        // the virtual clock while one is composed steps every scheduled fiber
        // it holds through the whole interval.
        yield* activate("aged-neighbour")
        yield* seedDependents("aged-neighbour")
        yield* finish("aged-neighbour", "completed")
        yield* TestClock.adjust(agingMs)

        // A live run parked on a durable deferred, beside the aged one.
        const engine = yield* makeEngine
        yield* engine.register(ReplayFlow, handler)
        yield* engine.execute(ReplayFlow, { executionId: "parked-run", payload: {}, discard: true })

        const report = yield* retain.retain({ olderThanMs: thresholdMs })
        expect(report.runIds).toEqual(["aged-neighbour"])

        // The parked run replays from its own journal and reaches its result.
        const resumed = yield* makeEngine
        yield* resumed.register(ReplayFlow, handler)
        yield* resumed.deferredDone(gate, {
          flowName: ReplayFlow._tag,
          executionId: "parked-run",
          deferredName: gate.name,
          exit: Exit.succeed("winner")
        })
        const value = yield* resumed.execute(ReplayFlow, {
          executionId: "parked-run",
          payload: {},
          discard: false
        })

        expect(value).toBe("first-result/winner")
        expect(dispatches).toBe(1)
        expect(yield* statusOf("parked-run")).toBe("completed")
      }).pipe(
        Effect.scoped,
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))
})
