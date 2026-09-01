import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer, Option } from "effect"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import * as RunStore from "../src/RunStore.ts"

const owner: OwnerId = { hostId: "payload-host", pid: 1, nonce: "payload-owner" }
const layer = Layer.mergeAll(RunStore.layer, AttemptStore.layer).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)

const migrated = <A, E>(
  effect: Effect.Effect<A, E, RunStore.RunStore | AttemptStore.AttemptStore>
) => effect.pipe(Effect.provide(layer), Effect.scoped)

const own = (runs: RunStore.Service, runId: string) =>
  runs.claimAndOwn(
    runId,
    { status: "pending", owner: null, heartbeatAtMs: null },
    owner,
    1
  )

describe("run-store payload and timeline limits", () => {
  it.effect("rejects reversed attempt timelines and keeps heartbeats monotonic", () =>
    Effect.gen(function*() {
      const result = yield* migrated(
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          yield* runs.create("timeline-run", "{}")
          yield* own(runs, "timeline-run")
          const reversed = {
            runId: "timeline-run",
            stepKeyDigest: "already-finished",
            attempt: 0,
            state: "completed",
            startedAtMs: 10,
            finishedAtMs: 9,
            meta: {}
          }
          const running = {
            runId: "timeline-run",
            stepKeyDigest: "heartbeat-before-start",
            attempt: 0,
            state: "running",
            startedAtMs: 10,
            meta: {}
          }
          const reversedPut = yield* Effect.flip(attempts.put(reversed, owner))
          const reversedHeartbeatPut = yield* Effect.flip(attempts.put({
            ...running,
            stepKeyDigest: "already-heartbeaten",
            heartbeatAtMs: 9
          }, owner))
          yield* attempts.put(running, owner)
          const earlyHeartbeat = yield* Effect.flip(attempts.heartbeat(
            running.runId,
            running.stepKeyDigest,
            running.attempt,
            owner,
            9
          ))
          const atStart = yield* attempts.heartbeat(
            running.runId,
            running.stepKeyDigest,
            running.attempt,
            owner,
            10
          )
          yield* attempts.heartbeat(running.runId, running.stepKeyDigest, running.attempt, owner, 20)
          yield* attempts.heartbeat(running.runId, running.stepKeyDigest, running.attempt, owner, 15)
          const earlyFinish = yield* Effect.flip(attempts.finish({
            runId: running.runId,
            stepKeyDigest: running.stepKeyDigest,
            attempt: running.attempt,
            state: "completed",
            finishedAtMs: 9
          }, owner))
          return {
            atStart,
            earlyFinish,
            earlyHeartbeat,
            heartbeatRow: Option.getOrThrow(
              yield* attempts.get({
                runId: running.runId,
                stepKeyDigest: running.stepKeyDigest,
                attempt: running.attempt
              })
            ),
            reversedHeartbeatPut,
            reversedPut
          }
        })
      )

      expect(result.reversedPut.code).toBe("invalid_attempt")
      expect(result.reversedHeartbeatPut.code).toBe("invalid_attempt")
      expect(result.earlyHeartbeat.code).toBe("invalid_attempt")
      expect(result.earlyFinish.code).toBe("invalid_attempt")
      expect(result.atStart).toEqual({ _tag: "Updated" })
      expect(result.heartbeatRow).toMatchObject({ startedAtMs: 10, heartbeatAtMs: 20 })
    }))

  it.effect("round-trips multi-megabyte run state, meta, error, and outcome within the published byte bounds", () =>
    Effect.gen(function*() {
      const large = "x".repeat(2 * 1024 * 1024)
      const result = yield* migrated(
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const initialState = JSON.stringify({ phase: "created", large })
          const transitionedState = JSON.stringify({ phase: "running", large })
          yield* runs.create("large-payload-run", initialState)
          yield* own(runs, "large-payload-run")
          yield* runs.transitionOwned("large-payload-run", owner, "running", transitionedState)
          const id = { runId: "large-payload-run", stepKeyDigest: "large-attempt", attempt: 0 }
          const put = yield* attempts.put({
            ...id,
            state: "running",
            startedAtMs: 1,
            meta: { large }
          }, owner)
          const finish = yield* attempts.finish({
            ...id,
            state: "failed",
            finishedAtMs: 2,
            error: { large },
            outcome: { large }
          }, owner)
          const oversizedState = yield* Effect.flip(
            runs.create(
              "oversized-state-run",
              JSON.stringify({ large: "x".repeat(RunStore.maximumRunStateBytes) })
            )
          )
          const oversizedMeta = yield* Effect.flip(attempts.put({
            ...id,
            stepKeyDigest: "oversized-meta",
            state: "running",
            startedAtMs: 1,
            meta: { large: "x".repeat(AttemptStore.maximumValueBytes) }
          }, owner))
          return {
            attempt: Option.getOrThrow(yield* attempts.get(id)),
            finish,
            oversizedMeta,
            oversizedState,
            put,
            run: yield* runs.get("large-payload-run")
          }
        })
      )

      // The public ceilings bound every executable JSON field. Only a
      // checkpoint's lower configured limit may vary within its absolute cap.
      expect(result.put).toEqual({ _tag: "Inserted" })
      expect(result.finish).toEqual({ _tag: "Finished" })
      expect(result.oversizedState).toMatchObject({ code: "invalid_run", method: "create" })
      expect(result.oversizedMeta).toMatchObject({ code: "invalid_attempt", method: "put" })
      expect(result.run.stateJson.length).toBeGreaterThan(2 * 1024 * 1024)
      expect((result.attempt.meta as { readonly large: string }).large).toHaveLength(large.length)
      expect((result.attempt.error as { readonly large: string }).large).toHaveLength(large.length)
      expect((result.attempt.outcome as { readonly large: string }).large).toHaveLength(large.length)
    }))
})
