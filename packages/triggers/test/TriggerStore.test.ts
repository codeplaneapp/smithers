import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
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
// Keeps the SQL client visible so a test can write the row shapes an older
// schema or a corrupted write would leave behind.
const layerWithSql = SqlTriggerStore.layer.pipe(Layer.provideMerge(TestDatabase.layer))

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

  it("reads back every optional column it wrote", async () => {
    const registered = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const written = yield* store.register({
          ...trigger,
          timezone: "America/New_York",
          input: { nested: [1, "two", null], flag: true },
          overlap: "buffer-one",
          catchUp: "all",
          maxCatchUp: 4
        })
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 7, expectedRevision: written.revision })
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 7,
          outcome: "launched",
          runId: "run-1"
        })
        const withCursor = yield* store.get(trigger.id)
        return { written, withCursor }
      }).pipe(Effect.provide(layer))
    )
    expect(registered.written).toMatchObject({
      timezone: "America/New_York",
      overlap: "buffer-one",
      catchUp: "all",
      maxCatchUp: 4,
      enabled: true,
      revision: 1
    })
    expect(registered.written.input).toEqual({ nested: [1, "two", null], flag: true })
    expect(registered.written.lastFiredAt).toBeUndefined()
    expect(registered.withCursor).toMatchObject({ _tag: "Some" })
    expect(
      registered.withCursor._tag === "Some" ? registered.withCursor.value.lastFiredAt : undefined
    ).toBe(7)
  })

  it("answers None for a trigger that was never registered", async () => {
    const missing = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        return yield* store.get("absent")
      }).pipe(Effect.provide(layer))
    )
    expect(missing).toMatchObject({ _tag: "None" })
  })

  it("lists every trigger and only the enabled ones, in id order", async () => {
    const listed = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* store.register({ ...trigger, id: "b-on" })
        yield* store.register({ ...trigger, id: "a-off", enabled: false })
        return { all: yield* store.list(), enabled: yield* store.listEnabled() }
      }).pipe(Effect.provide(layer))
    )
    expect(listed.all.map((registered) => registered.id)).toEqual(["a-off", "b-on"])
    expect(listed.enabled.map((registered) => registered.id)).toEqual(["b-on"])
  })

  // Every method that addresses one trigger owes the same refusal when no such
  // row exists. These used to divide into three behaviours: a typed failure, a
  // silent no-op, and a generic write failure.
  it("fails every single-trigger method with unknown_trigger", async () => {
    const codes = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        return yield* Effect.all([
          Effect.flip(store.claimFire({ triggerId: "absent", occurrence: 1, expectedRevision: 1 })),
          Effect.flip(store.recordResult({ triggerId: "absent", occurrence: 1, outcome: "completed" })),
          Effect.flip(store.setPending({ triggerId: "absent", occurrence: 1 })),
          Effect.flip(store.takePending("absent")),
          Effect.flip(store.activeRun("absent"))
        ])
      }).pipe(Effect.provide(layer))
    )
    for (const error of codes) {
      expect(error.code).toBe("unknown_trigger")
      expect(error.message).toBe("unknown trigger absent")
    }
  })

  // `clearActive` is the documented exception: its compare-and-swap cannot tell
  // a missing trigger from a run id that no longer matches.
  it("leaves clearActive a no-op for a missing trigger and a stale run id", async () => {
    const active = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        yield* store.clearActive("absent", "run-1")
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
        return { stale, cleared: yield* store.activeRun(trigger.id) }
      }).pipe(Effect.provide(layer))
    )
    expect(active.stale).toMatchObject({ _tag: "Some", value: "run-1" })
    expect(active.cleared).toMatchObject({ _tag: "None" })
  })

  it("coalesces a buffered occurrence forward and hands it back exactly once", async () => {
    const pending = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(trigger)
        const empty = yield* store.takePending(trigger.id)
        yield* store.setPending({ triggerId: trigger.id, occurrence: 20 })
        yield* store.setPending({ triggerId: trigger.id, occurrence: 10 })
        yield* store.setPending({ triggerId: trigger.id, occurrence: 30 })
        const taken = yield* store.takePending(trigger.id)
        return { empty, taken, drained: yield* store.takePending(trigger.id) }
      }).pipe(Effect.provide(layer))
    )
    expect(pending.empty).toMatchObject({ _tag: "None" })
    expect(pending.taken).toMatchObject({ _tag: "Some", value: 30 })
    expect(pending.drained).toMatchObject({ _tag: "None" })
  })

  // The claim applies the policy stored on the row, so a caller cannot spoof
  // one, and a claim computed from a declaration that has since changed is
  // refused rather than obeyed.
  it("fences a claim on the declaration it was computed from", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const first = yield* store.register(trigger)
        yield* store.register({ ...trigger, overlap: "supersede" })
        const stale = yield* Effect.flip(
          store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: first.revision })
        )
        const disabled = yield* store.register({ ...trigger, enabled: false })
        const refused = yield* Effect.flip(
          store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: disabled.revision })
        )
        return { stale, refused }
      }).pipe(Effect.provide(layer))
    )
    expect(result.stale).toMatchObject({ code: "revision_mismatch" })
    expect(result.stale.message).toBe("trigger daily is at revision 2, not the claimed 1")
    expect(result.refused).toMatchObject({ code: "trigger_disabled" })
  })

  // The cursor catch-up resumes from only ever moves forward. Settling run 1
  // after occurrence 2 was already skipped used to drag it back to 1 and
  // replay work the store had already recorded.
  it("never moves last_fired_at_ms backwards when an older run settles", async () => {
    const cursors = await Effect.runPromise(
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
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 2, expectedRevision: registered.revision })
        const afterSkip = yield* store.get(trigger.id)
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 1,
          outcome: "completed",
          runId: "run-1"
        })
        return { afterSkip, afterSettle: yield* store.get(trigger.id) }
      }).pipe(Effect.provide(layer))
    )
    const cursor = (option: typeof cursors.afterSkip) => option._tag === "Some" ? option.value.lastFiredAt : undefined
    expect(cursor(cursors.afterSkip)).toBe(2)
    expect(cursor(cursors.afterSettle)).toBe(2)
  })

  it("buffers under buffer-one and resumes the buffered occurrence only when asked", async () => {
    const claims = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register({ ...trigger, overlap: "buffer-one" })
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision })
        const buffered = yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 2,
          expectedRevision: registered.revision
        })
        const again = yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 2,
          expectedRevision: registered.revision
        })
        yield* store.recordResult({ triggerId: trigger.id, occurrence: 1, outcome: "completed" })
        const resumed = yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 2,
          expectedRevision: registered.revision,
          resumeBuffered: true
        })
        return { buffered, again, resumed, pending: yield* store.takePending(trigger.id) }
      }).pipe(Effect.provide(layer))
    )
    expect(claims.buffered).toMatchObject({ claimed: true, action: "buffer" })
    expect(claims.again).toMatchObject({ claimed: false })
    expect(claims.resumed).toMatchObject({ claimed: true, action: "fire" })
    expect(claims.pending).toMatchObject({ _tag: "Some", value: 2 })
  })

  it("reports the run it is superseding", async () => {
    const claim = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register({ ...trigger, overlap: "supersede" })
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision })
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 1,
          outcome: "launched",
          runId: "run-1"
        })
        return yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 2,
          expectedRevision: registered.revision
        })
      }).pipe(Effect.provide(layer))
    )
    expect(claim).toMatchObject({
      claimed: true,
      action: "supersede",
      activeRunId: "run-1",
      reservationId: "trigger-reservation:daily:2"
    })
  })

  it("refuses input that has no JSON representation before it reaches the column", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        return yield* Effect.flip(store.register({ ...trigger, input: undefined as never }))
      }).pipe(Effect.provide(layer))
    )
    expect(error).toMatchObject({ code: "invalid_trigger", path: "input" })
  })

  it("reports input it cannot serialize as a store failure rather than a defect", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const cyclic: Record<string, unknown> = {}
        cyclic["self"] = cyclic
        return yield* Effect.flip(store.register({ ...trigger, input: cyclic as never }))
      }).pipe(Effect.provide(layer))
    )
    expect(error.code).toBe("store")
    expect(error.message).toBe("trigger input is not JSON-serializable")
  })

  it("reports a row it cannot decode as a store failure", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(trigger)
        yield* sql`UPDATE flows_triggers SET input_json = '{not json' WHERE trigger_id = ${trigger.id}`
        return yield* Effect.flip(store.get(trigger.id))
      }).pipe(Effect.provide(layerWithSql))
    )
    expect(error.code).toBe("store")
    expect(error.message).toBe("could not decode trigger row")
    expect(error.cause).toBeDefined()
  })

  // Two stores over one database is the ordinary shape of a restart. The
  // migrator records what it applied, so the second `make` must be a no-op
  // rather than an error or a second `ALTER TABLE`.
  it("applies its migrations exactly once across two store constructions", async () => {
    const survived = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* SqlTriggerStore.make
        yield* first.register(trigger)
        const second = yield* SqlTriggerStore.make
        return yield* second.get(trigger.id)
      }).pipe(Effect.provide(TestDatabase.layer))
    )
    expect(survived).toMatchObject({ _tag: "Some" })
  })

  // A reservation written before migration 0002 existed carries no claim
  // timestamp. Treating that shape as expired is the only way such a row is
  // ever reclaimed.
  it("reclaims a reservation that predates the lease column", async () => {
    const reclaimed = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        yield* sql`UPDATE flows_triggers
          SET active_run_id = ${TriggerStore.reservationId(trigger.id, 1)}, active_claimed_at_ms = NULL
          WHERE trigger_id = ${trigger.id}`
        const active = yield* store.activeRun(trigger.id)
        return {
          active,
          claim: yield* store.claimFire({
            triggerId: trigger.id,
            occurrence: 5,
            expectedRevision: registered.revision
          })
        }
      }).pipe(Effect.provide(layerWithSql))
    )
    expect(reclaimed.active).toMatchObject({ _tag: "None" })
    expect(reclaimed.claim).toMatchObject({ claimed: true, action: "fire" })
  })
})
