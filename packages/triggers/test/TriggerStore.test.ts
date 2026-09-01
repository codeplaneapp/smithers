import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as SqlTriggerStore from "../src/SqlTriggerStore.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const trigger = {
  id: "daily",
  flowId: "flow",
  input: {},
  cron: "0 0 * * *",
  overlap: "skip" as const,
  catchUp: "none" as const,
  maxCatchUp: 1,
  enabled: true
}
const layer = SqlTriggerStore.layer.pipe(Layer.provide(TestDatabase.layer))

describe("TriggerStore", () => {
  it("refuses to register a cron the calendar never satisfies", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        return yield* Effect.flip(store.register({ ...trigger, cron: "0 0 30 2 *" }))
      }).pipe(Effect.provide(layer))
    )
    expect(error.code).toBe("unsatisfiable_cron")
  })

  it("revisions replacements and claims an occurrence exactly once", async () => {
    const program = Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const first = yield* store.register(trigger)
      const second = yield* store.register({ ...trigger, flowId: "other" })
      const claims = yield* Effect.all([
        store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: second.revision }),
        store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: second.revision })
      ], { concurrency: "unbounded" })
      return { first, second, claims }
    }).pipe(Effect.provide(layer))
    const result = await Effect.runPromise(program)
    expect(result.first.revision).toBe(1)
    expect(result.second.revision).toBe(2)
    expect(result.second.flowId).toBe("other")
    expect(result.claims.filter((claim) => claim.claimed)).toHaveLength(1)
  })

  it("retains an active run across buffered and skipped outcomes and clears it on completion", async () => {
    const program = Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const registered = yield* store.register(trigger)
      for (const occurrence of [1, 2, 3]) {
        yield* store.claimFire({ triggerId: trigger.id, occurrence, expectedRevision: registered.revision })
      }
      yield* store.recordResult({
        triggerId: trigger.id,
        occurrence: 1,
        outcome: "launched",
        runId: "run-1"
      })
      yield* store.recordResult({ triggerId: trigger.id, occurrence: 2, outcome: "buffered" })
      yield* store.recordResult({ triggerId: trigger.id, occurrence: 3, outcome: "skipped" })
      const active = yield* store.activeRun(trigger.id)
      yield* store.recordResult({
        triggerId: trigger.id,
        occurrence: 1,
        outcome: "completed",
        runId: "run-1"
      })
      const completed = yield* store.activeRun(trigger.id)
      return { active, completed }
    }).pipe(Effect.provide(layer))
    const result = await Effect.runPromise(program)
    expect(result.active).toMatchObject({ _tag: "Some", value: "run-1" })
    expect(result.completed).toMatchObject({ _tag: "None" })
  })

  it("atomically applies overlap across different due occurrences", async () => {
    const program = Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const registered = yield* store.register(trigger)
      return yield* Effect.all([
        store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision }),
        store.claimFire({ triggerId: trigger.id, occurrence: 2, expectedRevision: registered.revision })
      ], { concurrency: "unbounded" })
    }).pipe(Effect.provide(layer))
    const claims = await Effect.runPromise(program)
    expect(claims.filter((claim) => claim.claimed && claim.action === "fire")).toHaveLength(1)
    expect(claims.filter((claim) => claim.claimed && claim.action === "skip")).toHaveLength(1)
  })

  it("reclaims a launch reservation after its deterministic lease expires", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        const first = yield* store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision })
        yield* TestClock.adjust(SqlTriggerStore.reservationLeaseMs + 1)
        const noLongerActive = yield* store.activeRun(trigger.id)
        const retried = yield* store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision })
        return { first, noLongerActive, retried }
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))
    )

    expect(result.first).toMatchObject({ claimed: true, action: "fire" })
    expect(result.noLongerActive).toMatchObject({ _tag: "None" })
    expect(result.retried).toMatchObject({ claimed: true, action: "fire" })
  })
})
