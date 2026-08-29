import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Exit } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import { RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const owner: OwnerId = { hostId: "lease-host", pid: 17, nonce: "lease-owner" }

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>
) =>
  effect.pipe(
    Effect.provide(RunStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer)
  )

const activate = (store: RunStoreLive.Service, runId: string) =>
  Effect.gen(function*() {
    yield* store.create(runId, "{}")
    expect(
      yield* store.claimAndOwn(
        runId,
        { status: "pending", owner: null, heartbeatAtMs: null },
        owner,
        100
      )
    ).toEqual({ _tag: "Activated" })
  })

describe("RunStore heartbeat timestamp ordering", () => {
  // A late-arriving heartbeat with an older caller timestamp still reports
  // `Updated` — the fence held and the write proves liveness — but it never
  // moves `heartbeat_at_ms` backwards, so a live run cannot be made to look
  // stale to `claimAndOwn`/`steal`'s cutoff by a delayed packet.
  it.effect("keeps the lease timestamp monotonic when an older heartbeat arrives late", () =>
    Effect.gen(function*() {
      const rows = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* activate(store, "lease-monotonic")
          expect(yield* store.heartbeat("lease-monotonic", owner, 200)).toEqual({ _tag: "Updated" })
          expect(yield* store.heartbeat("lease-monotonic", owner, 150)).toEqual({ _tag: "Updated" })
          const afterLate = yield* store.get("lease-monotonic")
          expect(yield* store.heartbeat("lease-monotonic", owner, 250)).toEqual({ _tag: "Updated" })
          return { afterLate, afterNewer: yield* store.get("lease-monotonic") }
        })
      )

      expect(rows.afterLate.heartbeatAtMs).toBe(200)
      // A genuinely newer heartbeat still advances the lease.
      expect(rows.afterNewer.heartbeatAtMs).toBe(250)
    }))

  it.effect("accepts a safe-integer timestamp arbitrarily far in the future", () =>
    Effect.gen(function*() {
      const future = 8_000_000_000_000
      const result = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* activate(store, "lease-future")
          const outcome = yield* store.heartbeat("lease-future", owner, future)
          return { outcome, row: yield* store.get("lease-future") }
        })
      )

      // CONTRACT: RunStore applies no wall-clock plausibility window.
      expect(result.outcome).toEqual({ _tag: "Updated" })
      expect(result.row.heartbeatAtMs).toBe(future)
    }))

  it.effect("rejects negative, fractional, and NaN heartbeat timestamps before persistence", () =>
    Effect.gen(function*() {
      const result = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* activate(store, "lease-invalid")
          const exits = yield* Effect.forEach(
            [-1, 1.5, Number.NaN],
            (timestamp) => Effect.exit(store.heartbeat("lease-invalid", owner, timestamp))
          )
          return { exits, row: yield* store.get("lease-invalid") }
        })
      )

      // CONTRACT: heartbeat validates its timestamp explicitly. It has to —
      // the monotonic MAX() write would otherwise silently absorb an invalid
      // older value instead of letting the column CHECK reject it.
      expect(result.exits.every((exit) => Exit.isFailure(exit))).toBe(true)
      expect(
        result.exits.map((exit) =>
          Exit.isFailure(exit)
            ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
            : undefined
        )
      ).toEqual([
        expect.objectContaining({ code: "invalid_run", method: "heartbeat" }),
        expect.objectContaining({ code: "invalid_run", method: "heartbeat" }),
        expect.objectContaining({ code: "invalid_run", method: "heartbeat" })
      ])
      expect(result.row.heartbeatAtMs).toBe(100)
    }))
})
