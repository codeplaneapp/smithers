import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer, Option } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import * as RunStore from "../src/RunStore.ts"

const owner: OwnerId = { hostId: "host", pid: 1, nonce: "n" }

const base = Layer.provideMerge(
  RunStore.layer,
  Layer.provideMerge(Migrations.layer, TestDatabase.layer)
)

const withStore = <A, E>(
  options: AttemptStore.Options,
  body: (store: AttemptStore.Service) => Effect.Effect<A, E, RunStore.RunStore | DurableWriter | SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    const store = yield* AttemptStore.makeWith(options)
    const runs = yield* RunStore.RunStore
    yield* runs.create("run", "{}")
    yield* runs.claimAndOwn("run", { status: "pending", owner: null, heartbeatAtMs: null }, owner, 1_000)
    return yield* body(store)
  }).pipe(Effect.provide(base), Effect.scoped)

const attempt = (overrides: Partial<AttemptStore.Attempt> = {}): AttemptStore.Attempt => ({
  runId: "run",
  stepKeyDigest: "digest",
  attempt: 0,
  state: "in-progress",
  startedAtMs: 1,
  meta: { a: 1 },
  ...overrides
})

describe("AttemptStore options", () => {
  it.effect("accepts a configured in-progress vocabulary", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          expect(yield* store.put(attempt(), owner)).toEqual({ _tag: "Inserted" })
          expect(yield* store.heartbeat("run", "digest", 0, owner, 2, { c: 1 })).toEqual({ _tag: "Updated" })
          expect(
            yield* store.finish(
              { runId: "run", stepKeyDigest: "digest", attempt: 0, state: "succeeded", finishedAtMs: 3 },
              owner
            )
          ).toEqual({ _tag: "Finished" })
        })
    ))

  it.effect("rejects finishing into a state the store still considers in progress", () =>
    withStore(
      { inProgressStates: ["in-progress", "retrying"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt(), owner)
          const failure = yield* Effect.flip(
            store.finish(
              { runId: "run", stepKeyDigest: "digest", attempt: 0, state: "retrying", finishedAtMs: 3 },
              owner
            )
          )
          expect(failure.code).toBe("invalid_attempt")
        })
    ))

  it.effect("preserves a recorded error when finish omits one", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt({ error: { message: "mid-flight" } }), owner)
          yield* store.finish(
            { runId: "run", stepKeyDigest: "digest", attempt: 0, state: "failed", finishedAtMs: 3 },
            owner
          )
          const row = yield* store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 })
          expect(Option.getOrThrow(row).error).toEqual({ message: "mid-flight" })
        })
    ))

  it.effect("lets finish replace a recorded error", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt({ error: { message: "mid-flight" } }), owner)
          yield* store.finish(
            {
              runId: "run",
              stepKeyDigest: "digest",
              attempt: 0,
              state: "failed",
              finishedAtMs: 3,
              error: { message: "terminal" }
            },
            owner
          )
          const row = yield* store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 })
          expect(Option.getOrThrow(row).error).toEqual({ message: "terminal" })
        })
    ))

  it.effect("upserts a re-put attempt when configured to", () =>
    withStore(
      { inProgressStates: ["in-progress"], putMode: "upsert" },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt(), owner)
          expect(yield* store.put(attempt({ meta: { a: 2 }, startedAtMs: 9 }), owner)).toEqual({ _tag: "Upserted" })
          const row = Option.getOrThrow(yield* store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 }))
          expect(row.meta).toEqual({ a: 2 })
          expect(row.startedAtMs).toBe(9)
        })
    ))

  it.effect("keeps first-writer-wins by default", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt(), owner)
          expect(yield* store.put(attempt({ meta: { a: 2 } }), owner)).toEqual({ _tag: "Conflict" })
        })
    ))

  it.effect("upsert still respects the run fence", () =>
    withStore(
      { putMode: "upsert" },
      (store) =>
        Effect.gen(function*() {
          const other: OwnerId = { hostId: "host", pid: 2, nonce: "other" }
          expect(yield* store.put(attempt({ state: "running" }), other)).toEqual({ _tag: "FenceLost" })
        })
    ))

  it.effect("honours a configured checkpoint cap", () =>
    withStore(
      { inProgressStates: ["in-progress"], maxCheckpointBytes: 32 },
      (store) =>
        Effect.gen(function*() {
          const failure = yield* Effect.flip(store.put(attempt({ checkpoint: "x".repeat(64) }), owner))
          expect(failure.code).toBe("invalid_attempt")
        })
    ))

  it.effect("admits an agent-session checkpoint above the historical 1 MiB cap", () =>
    withStore(
      { inProgressStates: ["in-progress"], maxCheckpointBytes: 8 * 1024 * 1024 },
      (store) =>
        Effect.gen(function*() {
          const conversation = "x".repeat(2 * 1024 * 1024)
          expect(yield* store.put(attempt({ checkpoint: { conversation } }), owner)).toEqual({ _tag: "Inserted" })
        })
    ))

  it.effect("patches opaque fields without touching state", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt({ error: { message: "kept" } }), owner)
          expect(yield* store.patch({ runId: "run", stepKeyDigest: "digest", attempt: 0 }, { meta: { a: 3 } }, owner))
            .toEqual({ _tag: "Patched" })
          const row = Option.getOrThrow(yield* store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 }))
          expect(row.meta).toEqual({ a: 3 })
          expect(row.error).toEqual({ message: "kept" })
          expect(row.state).toBe("in-progress")
        })
    ))

  it.effect("patch reports a missing row and an empty patch", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          expect(yield* store.patch({ runId: "run", stepKeyDigest: "missing", attempt: 0 }, { meta: 1 }, owner))
            .toEqual({ _tag: "NotFound" })
          yield* store.put(attempt(), owner)
          expect(yield* store.patch({ runId: "run", stepKeyDigest: "digest", attempt: 0 }, {}, owner))
            .toEqual({ _tag: "Patched" })
        })
    ))

  it.effect("patch enforces the checkpoint cap and validates ids", () =>
    withStore(
      { maxCheckpointBytes: 16 },
      (store) =>
        Effect.gen(function*() {
          expect(
            (yield* Effect.flip(
              store.patch({ runId: "run", stepKeyDigest: "digest", attempt: 0 }, { checkpoint: "y".repeat(64) }, owner)
            )).code
          ).toBe("invalid_attempt")
          expect(
            (yield* Effect.flip(store.patch({ runId: "", stepKeyDigest: "digest", attempt: 0 }, {}, owner))).code
          ).toBe("invalid_attempt")
        })
    ))

  it.effect("patch writes every optional field", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt(), owner)
          expect(
            yield* store.patch({ runId: "run", stepKeyDigest: "digest", attempt: 0 }, {
              checkpoint: { c: 1 },
              error: { e: 1 },
              outcome: { o: 1 },
              meta: { m: 1 }
            }, owner)
          ).toEqual({ _tag: "Patched" })
          const row = Option.getOrThrow(yield* store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 }))
          expect(row).toMatchObject({
            checkpoint: { c: 1 },
            error: { e: 1 },
            outcome: { o: 1 },
            meta: { m: 1 }
          })
        })
    ))

  it.effect("rejects an invalid options vocabulary", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(AttemptStore.makeWith({ inProgressStates: [] }))
      expect(failure.code).toBe("invalid_attempt")
      const cap = yield* Effect.flip(AttemptStore.makeWith({ maxCheckpointBytes: 0 }))
      expect(cap.code).toBe("invalid_attempt")
    }).pipe(Effect.provide(base), Effect.scoped))

  it.effect("the noop store reports patch as unavailable", () =>
    Effect.gen(function*() {
      const store = AttemptStore.makeNoop()
      const failure = yield* Effect.flip(store.patch({ runId: "r", stepKeyDigest: "d", attempt: 0 }, {}, owner))
      expect(failure.code).toBe("unknown")
    }))

  it.effect("layerWith provides a configured store", () =>
    Effect.gen(function*() {
      const store = yield* AttemptStore.AttemptStore
      const runs = yield* RunStore.RunStore
      yield* runs.create("run", "{}")
      yield* runs.claimAndOwn("run", { status: "pending", owner: null, heartbeatAtMs: null }, owner, 1_000)
      expect(yield* store.put(attempt(), owner)).toEqual({ _tag: "Inserted" })
    }).pipe(
      Effect.provide(
        Layer.provideMerge(AttemptStore.layerWith({ inProgressStates: ["in-progress"] }), base)
      ),
      Effect.scoped
    ))
})
