import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #53: a run whose owner dies without releasing it (SIGKILL, OOM,
 * power loss) stays `status='running'` with a frozen heartbeat and no waiting
 * row. The #39 sweep enumerated only `waitingRuns()`, so nothing ever
 * re-drove such a run — no steal (reachable only through `drive()`), no
 * cancel delivery (`requestCancel` was write-only forever). The periodic
 * sweep must also enumerate stale-running rows and re-drive them through the
 * existing claim/steal path — the analog of Temporal's task-timeout
 * re-dispatch.
 *
 * Uses the SQL `DurableEngineState` over the same database as `RunStore`,
 * because the hard-kill evidence (a `running` row with a stale
 * `heartbeat_at_ms`) lives in `flows_runs` itself.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
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
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("HardKillReclaim/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const makeDriver = (nonce: string) =>
  RunDriver.make({
    owner: { hostId: "reclaim-host", pid: 1, nonce },
    journalSource: "hard-kill-reclaim",
    // The dead owner is never alive: the steal path may proceed.
    isAlive: () => Effect.succeed(false),
    engine: Effect.succeed(fakeEngine)
  })

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

/**
 * Simulates a hard-killed owner: a `running` row with a frozen heartbeat, a
 * dead owner, and no waiting row — exactly what SIGKILL leaves behind
 * (`releaseOwned` never ran, so nothing parked).
 */
const insertHardKilledRun = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter.DurableWriter
    const stateJson = JSON.stringify({
      version: 1,
      flowName: TestFlow._tag,
      payload: {}
    })
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
        'dead-host',
        424242,
        'dead-nonce',
        0,
        ${stateJson}
      )
    `).pipe(Effect.orDie)
  })

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) =>
  withCrypto(
    Effect.scoped(effect as Effect.Effect<A, E, Scope.Scope>).pipe(
      Effect.provide(services),
      Effect.provide(TestClock.layer())
    ) as Effect.Effect<A>
  )

const staleAfterMs = Duration.toMillis(Ownership.heartbeatStaleAfter)
const heartbeatMs = Duration.toMillis(Ownership.heartbeatInterval)

describe("hard-killed running runs are reclaimed (issue #53)", () => {
  it.effect("the sweep steals a stale-running run and re-drives it to completion", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* insertHardKilledRun("hard-kill-redrive")

        const driver = yield* makeDriver("owner-2")
        yield* driver.register(TestFlow, () => Effect.succeed("reclaimed"))

        // Cross the staleness horizon, then let the sweeper tick.
        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        let row = yield* store.get("hard-kill-redrive")
        for (let i = 0; i < 10 && row.status !== "completed"; i++) {
          yield* TestClock.adjust(heartbeatMs)
          row = yield* store.get("hard-kill-redrive")
        }
        return { row }
      }))

      expect(result.row.status).toBe("completed")
      expect(result.row.owner).toBeNull()
    }))

  it.effect("requestCancel against a hard-killed run is eventually delivered", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* insertHardKilledRun("hard-kill-cancel")

        // Another process (the CLI) durably requests cancellation while the
        // dead owner still nominally holds the run.
        yield* store.requestCancel("hard-kill-cancel", 1)

        const driver = yield* makeDriver("owner-2")
        // The flow body must never re-run: the re-activation cancel guard
        // closes the run instead.
        let bodyRuns = 0
        yield* driver.register(TestFlow, () =>
          Effect.sync(() => {
            bodyRuns += 1
          }).pipe(Effect.andThen(Effect.never)))

        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        let row = yield* store.get("hard-kill-cancel")
        for (let i = 0; i < 10 && row.status !== "cancelled"; i++) {
          yield* TestClock.adjust(heartbeatMs)
          row = yield* store.get("hard-kill-cancel")
        }
        return { row, bodyRuns }
      }))

      expect(result.row.status).toBe("cancelled")
      expect(result.bodyRuns).toBe(0)
    }))

  it.effect("does not steal a running run whose heartbeat is still fresh", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* insertHardKilledRun("hard-kill-fresh")

        const driver = yield* makeDriver("owner-2")
        yield* driver.register(TestFlow, () => Effect.succeed("stolen-too-early"))

        // Tick well below the staleness horizon: the run must stay untouched.
        yield* TestClock.adjust(3 * heartbeatMs)
        const row = yield* store.get("hard-kill-fresh")
        return { row }
      }))

      expect(result.row.status).toBe("running")
      expect(result.row.owner).toEqual({ hostId: "dead-host", pid: 424242, nonce: "dead-nonce" })
    }))
})
