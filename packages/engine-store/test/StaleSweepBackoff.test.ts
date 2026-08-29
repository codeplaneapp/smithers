/**
 * B-04: what the stale-running sweep costs when the owners are alive.
 *
 * `staleRunningRuns` is `ORDER BY heartbeat_at_ms, run_id LIMIT 64` with no
 * cursor, and the sweep woke that same batch every heartbeat. When the probe
 * answers "the owner is alive" the batch never drains, so two things went
 * wrong at once: the sixty-fifth stale row was never probed at all — the
 * oldest sixty-four are ahead of it forever — and every refusal wrote a
 * durable journal record through the default source id, one row per refused
 * run per second, for as long as the owners stayed alive.
 *
 * Both are fixed by remembering the refusal: a run whose owner was just proven
 * alive is not re-probed until its backoff elapses, which is what lets the
 * batch move past it, and the refusal record is addressed by
 * `(run, owner, heartbeat)` so the journal admits it once.
 *
 * Uses the SQL `DurableEngineState` over the same database as `RunStore`,
 * because the evidence is `flows_runs` itself.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("StaleSweepBackoff/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 4096, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

const staleAfterMs = Duration.toMillis(Ownership.heartbeatStaleAfter)
const heartbeatMs = Duration.toMillis(Ownership.heartbeatInterval)

/** One row per stale run, all older than the cutoff, ordered by heartbeat. */
const rows = 65
const runIdOf = (index: number) => `stale-${String(index).padStart(2, "0")}`

/**
 * A hard-killed-looking row whose owner is nonetheless alive: `running`, a
 * heartbeat frozen at `index` milliseconds, and no waiting row. The nonce
 * carries the run id so the injected probe can say which row it was asked
 * about — the probe is handed an owner and a lease, never a run id.
 */
const insertStaleRun = (index: number) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter.DurableWriter
    const runId = runIdOf(index)
    const stateJson = JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
    yield* writer.write(sql`
      INSERT INTO flows_runs (
        run_id,
        status,
        created_at_ms,
        started_at_ms,
        owner_host_id,
        owner_pid,
        owner_nonce,
        heartbeat_at_ms,
        state_json
      ) VALUES (
        ${runId},
        'running',
        0,
        0,
        'live-host',
        424242,
        ${runId},
        ${index},
        ${stateJson}
      )
    `).pipe(Effect.orDie)
  })

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withCrypto(
    Effect.scoped(effect as Effect.Effect<A, E, Scope.Scope>).pipe(
      Effect.provide(services),
      Effect.provide(TestClock.layer())
    ) as Effect.Effect<A>
  )

/** Every `steal-refused-owner-alive` decision journaled for one run. */
const refusalsOf = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 200 })
    return page.entries.filter((entry) =>
      entry.eventType === "flows.engine.run-decision" &&
      (entry.payload as { readonly decision?: string }).decision === "steal-refused-owner-alive"
    )
  })

describe("the stale-running sweep backs off refused rows (B-04)", () => {
  it.effect("probes past the batch within two ticks and journals one refusal per lease", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        /** Owner nonces the probe was asked about, in order, per tick. */
        const probed: Array<string> = []
        const driver = yield* RunDriver.make({
          owner: { hostId: "sweep-host", pid: 1, nonce: "sweeper" },
          journalSource: "stale-sweep-backoff",
          // The owner is alive on every probe, so no steal ever succeeds and
          // the stale set never shrinks. That is the shape this case is about.
          isAlive: (expectedOwner) =>
            Effect.sync(() => {
              probed.push(expectedOwner.nonce)
              return true
            }),
          engine: Effect.succeed(fakeEngine)
        })
        yield* driver.register(TestFlow, () => Effect.succeed("never reached"))
        for (let index = 1; index <= rows; index++) {
          yield* insertStaleRun(index)
        }

        // Cross the staleness horizon so every row is sweepable, then take
        // exactly two sweep ticks.
        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        const afterFirstTick = [...probed]
        yield* TestClock.adjust(heartbeatMs)
        const afterSecondTick = [...probed]

        // Then keep ticking well past the first backoff: the refusals repeat,
        // and the journal must not.
        yield* TestClock.adjust(heartbeatMs * 10)

        return {
          afterFirstTick,
          afterSecondTick,
          refusalsFirst: (yield* refusalsOf(runIdOf(1))).length,
          refusalsLast: (yield* refusalsOf(runIdOf(rows))).length,
          probesForLast: probed.filter((nonce) => nonce === runIdOf(rows)).length,
          statuses: yield* Effect.forEach(
            [runIdOf(1), runIdOf(rows)],
            (runId) => Effect.flatMap(store.get(runId), (row) => Effect.succeed(row.status))
          )
        }
      }))

      // The first tick can only reach the batch, which is the oldest 64 rows.
      expect(result.afterFirstTick).toHaveLength(64)
      expect(result.afterFirstTick).not.toContain(runIdOf(rows))
      // The second tick has to reach past them, or the sixty-fifth row is
      // never arbitrated at all.
      expect(result.afterSecondTick).toContain(runIdOf(rows))
      // And it is probed, not merely enumerated.
      expect(result.probesForLast).toBeGreaterThanOrEqual(1)
      // One durable refusal record per (run, owner, heartbeat), however many
      // times the sweep re-probes: the lease never moved, so there is only
      // ever one thing to say.
      expect(result.refusalsFirst).toBe(1)
      expect(result.refusalsLast).toBe(1)
      // Nothing was stolen from a live owner.
      expect(result.statuses).toEqual(["running", "running"])
    }))

  it.effect("forgets a refusal once its row leaves the stale window", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter.DurableWriter
        const probed: Array<number> = []
        const driver = yield* RunDriver.make({
          owner: { hostId: "sweep-host", pid: 1, nonce: "sweeper" },
          journalSource: "stale-sweep-backoff",
          isAlive: (_expectedOwner, context) =>
            Effect.sync(() => {
              probed.push(context.nowMs)
              return true
            }),
          engine: Effect.succeed(fakeEngine)
        })
        yield* driver.register(TestFlow, () => Effect.succeed("never reached"))
        yield* insertStaleRun(1)

        /** Rewrites the row's lease, which is what a stalling owner does. */
        const setHeartbeat = (heartbeatAtMs: number) =>
          writer.write(sql`
            UPDATE flows_runs SET heartbeat_at_ms = ${heartbeatAtMs} WHERE run_id = ${runIdOf(1)}
          `).pipe(Effect.orDie)

        // Three refusals in a row: the wait doubles each time, so by the third
        // the row is deferred for several ticks.
        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        yield* TestClock.adjust(heartbeatMs * 2)
        yield* TestClock.adjust(heartbeatMs * 4)
        const afterThreeRefusals = probed.length

        // The owner starts heartbeating again, so the row leaves the stale
        // window entirely and the sweep stops seeing it.
        const nowMs = yield* Clock.currentTimeMillis
        yield* setHeartbeat(nowMs)
        yield* TestClock.adjust(heartbeatMs)
        const whileFresh = probed.length

        // …and then stalls again, under a new lease. The refusal the driver
        // was holding was about the old one, so this stall is arbitrated now
        // rather than waiting out a backoff it did not earn.
        yield* setHeartbeat((yield* Clock.currentTimeMillis) - staleAfterMs - 1)
        yield* TestClock.adjust(heartbeatMs)
        return { afterThreeRefusals, whileFresh, afterNewLease: probed.length }
      }))

      expect(result.afterThreeRefusals).toBe(3)
      // A row outside the stale window is not probed at all.
      expect(result.whileFresh).toBe(3)
      // The new stall is probed on the first tick that sees it.
      expect(result.afterNewLease).toBe(4)
    }))
})
