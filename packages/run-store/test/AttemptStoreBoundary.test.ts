import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import * as RunStore from "../src/RunStore.ts"

const owner: OwnerId = { hostId: "boundary-host", pid: 1, nonce: "boundary-owner" }
const base = Layer.provideMerge(
  RunStore.layer,
  Layer.provideMerge(Migrations.layer, TestDatabase.layer)
)

const withStore = <A, E>(
  body: (
    store: AttemptStore.Service
  ) => Effect.Effect<A, E, RunStore.RunStore | DurableWriter | SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    const store = yield* AttemptStore.makeWith({ inProgressStates: ["running"] })
    const runs = yield* RunStore.RunStore
    yield* runs.create("boundary-run", "{}")
    yield* runs.claimAndOwn(
      "boundary-run",
      { status: "pending", owner: null, heartbeatAtMs: null },
      owner,
      0
    )
    return yield* body(store)
  }).pipe(Effect.provide(base), Effect.scoped)

const valid = (attempt = 0): AttemptStore.Attempt => ({
  runId: "boundary-run",
  stepKeyDigest: `step-${attempt}`,
  attempt,
  state: "running",
  startedAtMs: 1,
  meta: {}
})

const failureCode = <A>(effect: Effect.Effect<A, AttemptStore.AttemptStoreError>) =>
  Effect.map(Effect.flip(effect), (failure) => failure.code)

describe("AttemptStore inert input boundary", () => {
  it.effect("rejects hostile identities and attempt records without invoking accessors", () =>
    withStore((store) =>
      Effect.gen(function*() {
        let calls = 0
        const requiredAccessor = Object.defineProperty({ ...valid() }, "state", {
          enumerable: true,
          get: () => {
            calls++
            return "running"
          }
        })
        const optionalAccessor = Object.defineProperty({ ...valid() }, "checkpoint", {
          enumerable: true,
          get: () => {
            calls++
            return {}
          }
        })
        const extra = { ...valid(), unexpected: true }
        const symbol = { ...valid(), [Symbol("unexpected")]: true }
        const badAttempts = [null, new Date(), requiredAccessor, optionalAccessor, extra, symbol]
        for (const candidate of badAttempts) {
          expect(yield* failureCode(store.put(candidate as never, owner))).toBe("invalid_attempt")
        }
        const hiddenExtra = Object.defineProperty({ ...valid(99) }, "hidden", {
          value: true,
          enumerable: false
        })
        expect(yield* store.put(hiddenExtra, owner)).toEqual({ _tag: "Inserted" })

        const hiddenId = Object.defineProperty(
          {
            runId: "boundary-run",
            stepKeyDigest: "step-0",
            attempt: 0
          },
          "attempt",
          { value: 0, enumerable: false }
        )
        for (const id of [null, new Date(), hiddenId, { runId: "boundary-run", stepKeyDigest: "step-0" }]) {
          expect(yield* failureCode(store.get(id as never))).toBe("invalid_attempt")
        }
        expect(calls).toBe(0)
      })
    ))

  it.effect("validates every optional JSON field before a write", () =>
    withStore((store) =>
      Effect.gen(function*() {
        for (const field of ["checkpoint", "error", "outcome", "meta"] as const) {
          expect(
            yield* failureCode(store.put({ ...valid(), [field]: BigInt(1) } as never, owner))
          ).toBe("invalid_attempt")
        }

        yield* store.put(valid(), owner)
        for (const field of ["error", "outcome", "meta"] as const) {
          expect(
            yield* failureCode(store.finish({
              runId: "boundary-run",
              stepKeyDigest: "step-0",
              attempt: 0,
              state: "completed",
              finishedAtMs: 2,
              [field]: BigInt(1)
            } as never, owner))
          ).toBe("invalid_attempt")
        }
        expect(
          yield* failureCode(store.finish({
            runId: "boundary-run",
            stepKeyDigest: "step-0",
            attempt: 0,
            state: "",
            finishedAtMs: 2
          } as never, owner))
        ).toBe("invalid_attempt")
        expect(yield* failureCode(store.finish(null as never, owner))).toBe("invalid_attempt")

        for (const field of ["checkpoint", "error", "outcome", "meta"] as const) {
          expect(
            yield* failureCode(store.patch(
              { runId: "boundary-run", stepKeyDigest: "step-0", attempt: 0 },
              { [field]: BigInt(1) } as never,
              owner
            ))
          ).toBe("invalid_attempt")
        }
        expect(
          yield* failureCode(store.patch(
            { runId: "boundary-run", stepKeyDigest: "step-0", attempt: 0 },
            null as never,
            owner
          ))
        ).toBe("invalid_attempt")
      })
    ))

  it.effect("rejects malformed immutable store options", () =>
    Effect.gen(function*() {
      let calls = 0
      const accessor = Object.defineProperty({}, "putMode", {
        enumerable: true,
        get: () => {
          calls++
          return "upsert"
        }
      })
      const candidates: ReadonlyArray<AttemptStore.Options> = [
        null as never,
        new Date() as never,
        accessor,
        { inProgressStates: {} as never },
        { inProgressStates: [] },
        { inProgressStates: ["running", "running"] },
        { inProgressStates: [""] },
        { maxCheckpointBytes: 0 },
        { maxCheckpointBytes: 1.5 },
        { maxCheckpointBytes: AttemptStore.maximumCheckpointBytes + 1 },
        { putMode: "replace" as never }
      ]
      for (const options of candidates) {
        const failure = yield* AttemptStore.makeWith(options).pipe(
          Effect.flip,
          Effect.provide(base),
          Effect.scoped
        )
        expect(failure.code).toBe("invalid_attempt")
      }
      expect(calls).toBe(0)
    }))

  it.effect("rejects lifecycle reversals already present in SQLite", () =>
    withStore((store) =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* store.put(valid(0), owner)
        yield* store.put(valid(1), owner)
        yield* sql`
          UPDATE flows_attempts SET finished_at_ms = 0
          WHERE run_id = 'boundary-run' AND step_key_digest = 'step-0'
        `
        yield* sql`
          UPDATE flows_attempts SET heartbeat_at_ms = 0
          WHERE run_id = 'boundary-run' AND step_key_digest = 'step-1'
        `
        for (const attempt of [0, 1]) {
          expect(
            yield* failureCode(store.get({
              runId: "boundary-run",
              stepKeyDigest: `step-${attempt}`,
              attempt
            }))
          ).toBe("decode_failed")
        }
      })
    ))
})
