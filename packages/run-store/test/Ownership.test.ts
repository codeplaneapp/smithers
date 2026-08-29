/**
 * The lease is evidence.
 *
 * `steal` used to accept only evidence a caller produced out of band — a pid
 * probe on the owner's host, or an unreachability judgement across hosts — so
 * a process that had nothing but the persisted heartbeat could not reclaim a
 * hard-killed owner at all. The lease itself is the one piece of evidence the
 * store can verify: the steal predicate already refuses any row whose
 * `heartbeat_at_ms` is inside the staleness window, so `lease-expired` evidence
 * is checked by the write that consumes it rather than trusted.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Clock, Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import {
  heartbeatStaleAfter,
  leaseLiveness,
  type LivenessEvidence,
  type OwnerId,
  sameHostIncarnation
} from "../src/Ownership.ts"
import { type RunRow, type RunSnapshot, RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const migrated = <A, E>(effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>) =>
  effect.pipe(
    Effect.provide(RunStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer),
    Effect.provide(TestClock.layer())
  )

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const sameHost: OwnerId = { hostId: "host-a", pid: 202, nonce: "owner-b" }
const otherHost: OwnerId = { hostId: "host-b", pid: 303, nonce: "owner-c" }

const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)

const snapshot = (row: RunRow): RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const activateNew = (store: RunStoreLive.Service, runId: string, owner: OwnerId) =>
  Effect.gen(function*() {
    yield* store.create(runId, "{}")
    const pending = yield* store.get(runId)
    const expected = snapshot(pending)
    const claimedAtMs = yield* Clock.currentTimeMillis
    yield* store.claim(runId, expected, owner, claimedAtMs)
    yield* store.activate(runId, owner, claimedAtMs, expected)
    return yield* store.get(runId)
  })

const leaseExpired = (
  expectedOwner: OwnerId,
  checkedAtMs: number
): LivenessEvidence => ({ expectedOwner, checkedAtMs, kind: "lease-expired" })

describe("leaseLiveness", () => {
  it.effect("reports the owner alive while its lease is inside the staleness window", () =>
    Effect.gen(function*() {
      const isAlive = leaseLiveness(heartbeatStaleAfter)
      // The cutoff matches the store's own steal predicate, which is strict:
      // a lease exactly `heartbeatStaleAfter` old is still fresh.
      expect(yield* isAlive(ownerA, { claimant: sameHost, nowMs: staleAfterMs, heartbeatAtMs: 0 })).toBe(true)
      expect(yield* isAlive(ownerA, { claimant: sameHost, nowMs: staleAfterMs + 1, heartbeatAtMs: 0 })).toBe(false)
    }))

  it.effect("reports an owner with no recorded lease as not alive", () =>
    Effect.gen(function*() {
      const isAlive = leaseLiveness(heartbeatStaleAfter)
      expect(yield* isAlive(ownerA, { claimant: sameHost, nowMs: 5_000, heartbeatAtMs: null })).toBe(false)
    }))

  it.effect("uses the supplied window rather than the default cutoff", () =>
    Effect.gen(function*() {
      const isAlive = leaseLiveness(Duration.seconds(1))
      const context = { claimant: sameHost, nowMs: 5_000 }
      expect(yield* isAlive(ownerA, { ...context, heartbeatAtMs: 4_000 })).toBe(true)
      expect(yield* isAlive(ownerA, { ...context, heartbeatAtMs: 3_999 })).toBe(false)
    }))
})

describe("sameHostIncarnation", () => {
  it("is true only for two incarnations that share a host", () => {
    expect(sameHostIncarnation(ownerA, sameHost)).toBe(true)
    expect(sameHostIncarnation(ownerA, otherHost)).toBe(false)
  })
})

describe("lease-expired evidence", () => {
  it.effect("is accepted from a claimant on any host", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const row = yield* activateNew(store, "lease-expired-cross-host", ownerA)
        yield* TestClock.adjust(staleAfterMs + 1)
        const nowMs = yield* Clock.currentTimeMillis
        return yield* store.steal(
          "lease-expired-cross-host",
          snapshot(row),
          otherHost,
          nowMs,
          leaseExpired(ownerA, nowMs)
        )
      }))

      expect(result._tag).toBe("Claimed")
    }))

  it.effect("is still refused while the persisted lease is fresh", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const row = yield* activateNew(store, "lease-expired-too-early", ownerA)
        yield* TestClock.adjust(staleAfterMs - 1)
        const nowMs = yield* Clock.currentTimeMillis
        return yield* store.steal(
          "lease-expired-too-early",
          snapshot(row),
          sameHost,
          nowMs,
          leaseExpired(ownerA, nowMs)
        )
      }))

      // The write predicate, not the evidence, is what refuses here: the
      // claimant asserted the lease was gone and the row says otherwise.
      expect(result._tag).toBe("HeartbeatFresh")
    }))

  it.effect("still names the owner it was collected against", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const row = yield* activateNew(store, "lease-expired-wrong-owner", ownerA)
        yield* TestClock.adjust(staleAfterMs + 1)
        const nowMs = yield* Clock.currentTimeMillis
        return yield* store.steal(
          "lease-expired-wrong-owner",
          snapshot(row),
          otherHost,
          nowMs,
          leaseExpired(otherHost, nowMs)
        )
      }))

      expect(result._tag).toBe("SnapshotChanged")
    }))
})
