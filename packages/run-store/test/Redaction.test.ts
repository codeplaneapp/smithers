/**
 * Executable state must survive the durable round trip verbatim: journal
 * payloads are redacted, but the stores that hold resumable state are not.
 * Split out of `@smthrs/journal`'s redaction suite when the stores moved into
 * their own packages — see `docs/specs/Concepts/Journal Split.md`.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as RunStore from "../src/RunStore.ts"

describe("durable run state redaction", () => {
  // Executable state must round-trip verbatim: a field whose name merely ends
  // in `token`/`secret` is ordinary flow data, and a non-string value replaced
  // by a placeholder string breaks schema decode on resume (issue #72).
  const executable = {
    pageToken: "page-2",
    clientSecret: { rotationMs: 900, scopes: ["read"] },
    retries: 3
  }

  const storeLayers = Layer.mergeAll(
    RunStore.layer,
    AttemptStore.layer
  ).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

  const withStores = <A, E>(
    body: Effect.Effect<
      A,
      E,
      RunStore.RunStore | AttemptStore.AttemptStore | DurableWriter | SqlClient.SqlClient
    >
  ) => body.pipe(Effect.provide(storeLayers), Effect.provide(TestClock.layer()))

  it.effect("round-trips a run's durable state verbatim", () =>
    Effect.gen(function*() {
      const stateJson = yield* withStores(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* store.create("run-redaction", JSON.stringify({ payload: executable }))
        return (yield* store.get("run-redaction")).stateJson
      }))

      expect(JSON.parse(stateJson)).toEqual({ payload: executable })
    }))

  it.effect("round-trips durable state written by transitionOwned verbatim", () =>
    Effect.gen(function*() {
      const stateJson = yield* withStores(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`
        INSERT INTO flows_runs (
          run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
        ) VALUES ('run-transition', 'running', 1, 'host-a', 42, 'nonce-a', 1, '{}')
      `
        const store = yield* RunStore.RunStore
        const owner = { hostId: "host-a", pid: 42, nonce: "nonce-a" }
        const outcome = yield* store.transitionOwned(
          "run-transition",
          owner,
          "running",
          JSON.stringify({ payload: executable })
        )
        expect(outcome._tag).toBe("Transitioned")
        return (yield* store.get("run-transition")).stateJson
      }))

      expect(JSON.parse(stateJson)).toEqual({ payload: executable })
    }))

  it.effect("round-trips attempt checkpoints, errors, outcomes, and meta verbatim", () =>
    Effect.gen(function*() {
      const attempt = yield* withStores(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`
        INSERT INTO flows_runs (
          run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
        ) VALUES ('run-attempt', 'running', 1, 'host-a', 42, 'nonce-a', 1, '{}')
      `
        const store = yield* AttemptStore.AttemptStore
        const owner = { hostId: "host-a", pid: 42, nonce: "nonce-a" }
        yield* store.put({
          runId: "run-attempt",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          checkpoint: executable,
          meta: executable
        }, owner)
        yield* store.finish({
          runId: "run-attempt",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "failed",
          finishedAtMs: 20,
          error: executable,
          outcome: executable
        }, owner)
        return yield* store.get({ runId: "run-attempt", stepKeyDigest: "digest-1", attempt: 0 })
      }))

      expect(Option.getOrThrow(attempt)).toMatchObject({
        checkpoint: executable,
        error: executable,
        outcome: executable,
        meta: executable
      })
    }))

  it.effect("round-trips attempt fields written by patch verbatim", () =>
    Effect.gen(function*() {
      const attempt = yield* withStores(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`
        INSERT INTO flows_runs (
          run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
        ) VALUES ('run-patch', 'running', 1, 'host-a', 42, 'nonce-a', 1, '{}')
      `
        const store = yield* AttemptStore.AttemptStore
        const id = { runId: "run-patch", stepKeyDigest: "digest-2", attempt: 0 }
        yield* store.put({ ...id, state: "running", startedAtMs: 10, meta: null }, {
          hostId: "host-a",
          pid: 42,
          nonce: "nonce-a"
        })
        yield* store.patch(id, { checkpoint: executable }, {
          hostId: "host-a",
          pid: 42,
          nonce: "nonce-a"
        })
        return yield* store.get(id)
      }))

      expect(Option.getOrThrow(attempt)).toMatchObject({ checkpoint: executable })
    }))
})
