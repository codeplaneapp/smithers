import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { reservationLeaseMs } from "../src/SqlTriggerStore.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const declaration = {
  id: "daily",
  flowId: "flow",
  input: { nested: [1, "two", null], enabled: true },
  cron: "0 0 * * *",
  overlap: "skip" as const,
  catchUp: "none" as const,
  maxCatchUp: 1,
  enabled: true
}

/** Declares the contract shared by durable and in-memory trigger stores. */
export const storeConformance = <LayerError>(
  name: string,
  layer: Layer.Layer<TriggerStore.TriggerStore, LayerError>
): void => {
  const run = <A, E>(effect: Effect.Effect<A, E, TriggerStore.TriggerStore>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(layer),
        Effect.provide(TestClock.layer())
      )
    )

  describe(`${name} TriggerStore conformance`, () => {
    it("reports unknown_trigger from every missing-row path", async () => {
      const errors = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          return yield* Effect.all([
            Effect.flip(store.claimFire({ triggerId: "absent", occurrence: 1, expectedRevision: 1 })),
            Effect.flip(store.recordResult({ triggerId: "absent", occurrence: 1, outcome: "completed" })),
            Effect.flip(store.setPending({ triggerId: "absent", occurrence: 1 })),
            Effect.flip(store.takePending("absent")),
            Effect.flip(store.activeRun("absent")),
            Effect.flip(store.claimPending({ triggerId: "absent", expectedRevision: 1 }))
          ])
        })
      )
      for (const error of errors) {
        expect(error.code).toBe("unknown_trigger")
        expect(error.message).toBe("unknown trigger absent")
      }
    })

    it("uses exact revision and enabled claim fences", async () => {
      const refusals = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          const stale = yield* Effect.flip(
            store.claimFire({
              triggerId: declaration.id,
              occurrence: 1,
              expectedRevision: registered.revision + 1
            })
          )
          const disabled = yield* store.register({ ...declaration, enabled: false })
          const off = yield* Effect.flip(
            store.claimFire({
              triggerId: declaration.id,
              occurrence: 1,
              expectedRevision: disabled.revision
            })
          )
          return { stale, off }
        })
      )
      expect(refusals.stale.code).toBe("revision_mismatch")
      expect(refusals.stale.message).toBe("trigger daily is at revision 1, not the claimed 2")
      expect(refusals.off.code).toBe("trigger_disabled")
      expect(refusals.off.message).toBe("trigger daily is disabled")
    })

    it("round-trips registered JSON input exactly", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          return { registered, stored: yield* store.get(declaration.id) }
        })
      )
      expect(result.registered.input).toEqual(declaration.input)
      expect(result.stored).toMatchObject({ _tag: "Some", value: { input: declaration.input } })
    })

    it("holds live reservations and reclaims them after the shared lease", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          const first = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs - 1)
          const live = yield* store.activeRun(declaration.id)
          yield* TestClock.adjust(2)
          const expired = yield* store.activeRun(declaration.id)
          const retried = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          return { first, live, expired, retried }
        })
      )
      expect(result.first).toMatchObject({ claimed: true, action: "fire" })
      expect(result.live).toMatchObject({
        _tag: "Some",
        value: TriggerStore.reservationId(declaration.id, 1)
      })
      expect(result.expired).toMatchObject({ _tag: "None" })
      expect(result.retried).toMatchObject({ claimed: true, action: "fire" })
    })

    it("reclaims an expired reservation inside a later claim", async () => {
      const claim = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs + 1)
          return yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
        })
      )
      expect(claim).toMatchObject({
        claimed: true,
        action: "fire",
        reservationId: TriggerStore.reservationId(declaration.id, 2)
      })
    })

    it("holds and then reclaims the reservation for the same occurrence", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          const first = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          const live = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs + 1)
          const expired = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          return { first, live, expired }
        })
      )
      expect(result.first).toMatchObject({ claimed: true, action: "fire" })
      expect(result.live).toMatchObject({ claimed: false })
      expect(result.expired).toMatchObject({ claimed: true, action: "fire" })
    })

    it("reclaims reservations with no claim timestamp", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const activeRegistered = yield* store.register({ ...declaration, id: "active-null" })
          const activeReservation = TriggerStore.reservationId("active-null", 1)
          yield* store.claimFire({
            triggerId: "active-null",
            occurrence: 1,
            expectedRevision: activeRegistered.revision
          })
          yield* store.recordResult({
            triggerId: "active-null",
            occurrence: 1,
            outcome: "launched",
            runId: activeReservation
          })
          const active = yield* store.activeRun("active-null")

          const claimRegistered = yield* store.register({ ...declaration, id: "claim-null" })
          const claimReservation = TriggerStore.reservationId("claim-null", 1)
          yield* store.claimFire({
            triggerId: "claim-null",
            occurrence: 1,
            expectedRevision: claimRegistered.revision
          })
          yield* store.recordResult({
            triggerId: "claim-null",
            occurrence: 1,
            outcome: "launched",
            runId: claimReservation
          })
          const claim = yield* store.claimFire({
            triggerId: "claim-null",
            occurrence: 2,
            expectedRevision: claimRegistered.revision
          })
          return { active, claim }
        })
      )
      expect(result.active).toMatchObject({ _tag: "None" })
      expect(result.claim).toMatchObject({
        claimed: true,
        action: "fire",
        reservationId: TriggerStore.reservationId("claim-null", 2)
      })
    })

    it("releases a launch reservation when no run id is reported", async () => {
      const active = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "launched"
          })
          return yield* store.activeRun(declaration.id)
        })
      )
      expect(active).toMatchObject({ _tag: "None" })
    })

    it("claims and clears one buffered occurrence atomically", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "buffer-one" })
          const empty = yield* store.claimPending({
            triggerId: declaration.id,
            expectedRevision: registered.revision
          })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          const buffered = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "completed"
          })
          const resumed = yield* store.claimPending({
            triggerId: declaration.id,
            expectedRevision: registered.revision
          })
          return { empty, buffered, resumed, pending: yield* store.takePending(declaration.id) }
        })
      )
      expect(result.empty).toMatchObject({ _tag: "None" })
      expect(result.buffered).toMatchObject({ claimed: true, action: "buffer" })
      expect(result.resumed).toMatchObject({
        _tag: "Some",
        value: { occurrence: 2, claim: { claimed: true, action: "fire" } }
      })
      expect(result.pending).toMatchObject({ _tag: "None" })
    })

    it("keeps pending work when a claim is refused", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 3,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 3,
            outcome: "skipped"
          })
          yield* store.setPending({ triggerId: declaration.id, occurrence: 3 })
          const refused = yield* store.claimPending({
            triggerId: declaration.id,
            expectedRevision: registered.revision
          })
          return { refused, pending: yield* store.takePending(declaration.id) }
        })
      )
      expect(result.refused).toMatchObject({
        _tag: "Some",
        value: { occurrence: 3, claim: { claimed: false } }
      })
      expect(result.pending).toMatchObject({ _tag: "Some", value: 3 })
    })

    it("keeps pending work behind revision and disabled fences", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          yield* store.setPending({ triggerId: declaration.id, occurrence: 4 })
          const stale = yield* Effect.flip(
            store.claimPending({
              triggerId: declaration.id,
              expectedRevision: registered.revision + 1
            })
          )
          const afterStale = yield* store.takePending(declaration.id)
          yield* store.setPending({ triggerId: declaration.id, occurrence: 5 })
          const disabled = yield* store.register({ ...declaration, enabled: false })
          const off = yield* Effect.flip(
            store.claimPending({
              triggerId: declaration.id,
              expectedRevision: disabled.revision
            })
          )
          return { stale, afterStale, off, afterOff: yield* store.takePending(declaration.id) }
        })
      )
      expect(result.stale.code).toBe("revision_mismatch")
      expect(result.stale.message).toBe("trigger daily is at revision 1, not the claimed 2")
      expect(result.afterStale).toMatchObject({ _tag: "Some", value: 4 })
      expect(result.off.code).toBe("trigger_disabled")
      expect(result.off.message).toBe("trigger daily is disabled")
      expect(result.afterOff).toMatchObject({ _tag: "Some", value: 5 })
    })

    it("re-arms claimed buffered work when its reservation expires", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "buffer-one" })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "completed"
          })
          yield* store.claimPending({
            triggerId: declaration.id,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs + 1)
          const active = yield* store.activeRun(declaration.id)
          return { active, pending: yield* store.takePending(declaration.id) }
        })
      )
      expect(result.active).toMatchObject({ _tag: "None" })
      expect(result.pending).toMatchObject({ _tag: "Some", value: 2 })
    })
  })
}
