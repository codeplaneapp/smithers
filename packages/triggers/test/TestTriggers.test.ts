import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as TestTriggers from "../src/test/TestTriggers.ts"
import type { Trigger } from "../src/Trigger.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const trigger: Trigger = {
  id: "daily",
  flowId: "flow",
  input: {},
  cron: "0 0 * * *",
  overlap: "skip",
  catchUp: "none",
  maxCatchUp: 0,
  enabled: true
}

const run = <A, E>(effect: Effect.Effect<A, E, TriggerStore.TriggerStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestTriggers.layer)))

// The exported test layer stands in for `SqlTriggerStore` in other packages'
// suites, so it owes the same refusals in the same order. A kinder set of rules
// here would make it an unreliable oracle for the store it replaces.
describe("TestTriggers", () => {
  it("refuses a claim exactly as the SQL store does", async () => {
    const refusals = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const missing = yield* Effect.flip(
          store.claimFire({ triggerId: "absent", occurrence: 1, expectedRevision: 1 })
        )
        const registered = yield* store.register(trigger)
        const stale = yield* Effect.flip(
          store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision + 1 })
        )
        const off = yield* store.register({ ...trigger, enabled: false })
        const disabled = yield* Effect.flip(
          store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: off.revision })
        )
        return { missing, stale, disabled }
      })
    )
    expect(refusals.missing).toMatchObject({ code: "unknown_trigger", message: "unknown trigger absent" })
    expect(refusals.stale).toMatchObject({ code: "revision_mismatch" })
    expect(refusals.stale.message).toBe("trigger daily is at revision 1, not the claimed 2")
    expect(refusals.disabled).toMatchObject({ code: "trigger_disabled" })
  })

  it("fails every other single-trigger method with unknown_trigger", async () => {
    const codes = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        return yield* Effect.all([
          Effect.flip(store.recordResult({ triggerId: "absent", occurrence: 1, outcome: "completed" })),
          Effect.flip(store.setPending({ triggerId: "absent", occurrence: 1 })),
          Effect.flip(store.takePending("absent")),
          Effect.flip(store.activeRun("absent"))
        ])
      })
    )
    for (const error of codes) expect(error.code).toBe("unknown_trigger")
  })

  it("claims one occurrence once and only resumes a buffered one on request", async () => {
    const claims = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        const first = yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 1,
          expectedRevision: registered.revision
        })
        const second = yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 1,
          expectedRevision: registered.revision
        })
        const resumed = yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 1,
          expectedRevision: registered.revision,
          resumeBuffered: true
        })
        return { first, second, resumed }
      })
    )
    expect(claims.first).toMatchObject({ claimed: true, action: "fire" })
    expect(claims.second).toMatchObject({ claimed: false })
    expect(claims.resumed).toMatchObject({ claimed: true, action: "skip" })
  })

  it("lists every trigger and keeps the fire cursor across a re-registration", async () => {
    const state = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        yield* store.register({ ...trigger, id: "other" })
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 5, expectedRevision: registered.revision })
        const replaced = yield* store.register({ ...trigger, flowId: "next" })
        return { all: yield* store.list(), enabled: yield* store.listEnabled(), replaced }
      })
    )
    expect(state.all.map((registered) => registered.id).sort()).toEqual(["daily", "other"])
    expect(state.enabled).toHaveLength(2)
    expect(state.replaced).toMatchObject({ revision: 2, flowId: "next", lastFiredAt: 5 })
  })

  it("keeps the cursor monotonic when an older occurrence settles", async () => {
    const cursor = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 20, expectedRevision: registered.revision })
        yield* store.recordResult({ triggerId: trigger.id, occurrence: 10, outcome: "completed" })
        return yield* store.get(trigger.id)
      })
    )
    expect(cursor._tag === "Some" ? cursor.value.lastFiredAt : undefined).toBe(20)
  })

  it("clears an active run only for the run id that still holds it", async () => {
    const state = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision })
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 1,
          outcome: "launched",
          runId: "run-1"
        })
        yield* store.clearActive(trigger.id, "run-2")
        const stale = yield* store.activeRun(trigger.id)
        yield* store.clearActive(trigger.id, "run-1")
        const cleared = yield* store.activeRun(trigger.id)
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 1,
          outcome: "completed",
          runId: "run-9"
        })
        return { stale, cleared, missing: yield* store.get("absent") }
      })
    )
    expect(state.stale).toMatchObject({ _tag: "Some", value: "run-1" })
    expect(state.cleared).toMatchObject({ _tag: "None" })
    expect(state.missing).toMatchObject({ _tag: "None" })
  })

  it("coalesces buffered occurrences forward and drains them once", async () => {
    const pending = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(trigger)
        yield* store.setPending({ triggerId: trigger.id, occurrence: 20 })
        yield* store.setPending({ triggerId: trigger.id, occurrence: 10 })
        const taken = yield* store.takePending(trigger.id)
        return { taken, drained: yield* store.takePending(trigger.id) }
      })
    )
    expect(pending.taken).toMatchObject({ _tag: "Some", value: 20 })
    expect(pending.drained).toMatchObject({ _tag: "None" })
  })
})
