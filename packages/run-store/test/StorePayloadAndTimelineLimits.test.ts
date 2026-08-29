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
  it.effect("pins acceptance of reversed attempt finish and heartbeat timelines", () =>
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
          const reversedPut = yield* attempts.put(reversed, owner)
          yield* attempts.put(running, owner)
          const earlyHeartbeat = yield* attempts.heartbeat(
            running.runId,
            running.stepKeyDigest,
            running.attempt,
            owner,
            9
          )
          return {
            earlyHeartbeat,
            heartbeatRow: Option.getOrThrow(yield* attempts.get(running)),
            reversedPut,
            reversedRow: Option.getOrThrow(yield* attempts.get(reversed))
          }
        })
      )

      // CONTRACT: timestamps are range-checked independently; no relational
      // finished >= started or heartbeat >= started constraint exists.
      expect(result.reversedPut).toEqual({ _tag: "Inserted" })
      expect(result.reversedRow).toMatchObject({ startedAtMs: 10, finishedAtMs: 9 })
      expect(result.earlyHeartbeat).toEqual({ _tag: "Updated" })
      expect(result.heartbeatRow).toMatchObject({ startedAtMs: 10, heartbeatAtMs: 9 })
    }))

  it.effect("round-trips multi-megabyte run state, meta, error, and outcome without caps", () =>
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
          return {
            attempt: Option.getOrThrow(yield* attempts.get(id)),
            finish,
            put,
            run: yield* runs.get("large-payload-run")
          }
        })
      )

      // CONTRACT: only checkpoints have a configurable byte ceiling today.
      expect(result.put).toEqual({ _tag: "Inserted" })
      expect(result.finish).toEqual({ _tag: "Finished" })
      expect(result.run.stateJson.length).toBeGreaterThan(2 * 1024 * 1024)
      expect((result.attempt.meta as { readonly large: string }).large).toHaveLength(large.length)
      expect((result.attempt.error as { readonly large: string }).large).toHaveLength(large.length)
      expect((result.attempt.outcome as { readonly large: string }).large).toHaveLength(large.length)
    }))
})
