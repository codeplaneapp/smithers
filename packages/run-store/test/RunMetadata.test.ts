import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Exit, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import * as RunStore from "../src/RunStore.ts"

const owner: OwnerId = { hostId: "host", pid: 1, nonce: "n" }

const layer = Layer.provideMerge(
  RunStore.layer,
  Layer.provideMerge(Migrations.layer, TestDatabase.layer)
)

const effect = <E>(
  name: string,
  body: () => Effect.Effect<void, E, RunStore.RunStore | DurableWriter | SqlClient.SqlClient>
) => it.effect(name, () => body().pipe(Effect.provide(layer), Effect.scoped))

const own = (store: RunStore.Service, runId: string) =>
  store.claimAndOwn(runId, { status: "pending", owner: null, heartbeatAtMs: null }, owner, 1_000)

/** Runs `interfere` immediately before the `nth` statement matching `match`. */
const interleaving = (
  match: string,
  nth: number,
  interfere: (base: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>
) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const base = yield* Effect.service(SqlClient.SqlClient)
      let seen = 0
      return new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          if (typeof statement.compile !== "function" || !statement.compile()[0].includes(match)) {
            return statement
          }
          seen += 1
          return seen === nth ? Effect.andThen(interfere(base), statement) : statement
        }
      }) as SqlClient.SqlClient
    })
  )

const expectRunStoreFailure = <A>(
  exit: Exit.Exit<A, RunStore.RunStoreError>,
  method: string,
  code = "invalid_run"
): void => {
  expect(Exit.isFailure(exit)).toBe(true)
  const failure = Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
    : undefined
  expect(failure?.error).toEqual(expect.objectContaining({ code, method }))
}

describe("run metadata", () => {
  effect("create records lineage and exposes it on the row", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("parent", "{}")
      yield* store.create("child", "{}", { parentRunId: "parent" })
      const parent = yield* store.get("parent")
      const child = yield* store.get("child")
      expect(parent.parentRunId).toBeNull()
      expect(parent.cancelRequestedAtMs).toBeNull()
      expect(child.parentRunId).toBe("parent")
      // Absent lineage columns read back as null: an ordinary run is a
      // lineage of one, and every row written before the append-only
      // migration decodes the same way.
      expect(parent.lineageId).toBeNull()
      expect(parent.roundOrdinal).toBeNull()
    }))

  effect("create records the trampoline lineage pair and exposes it on the row", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("round-0", "{}")
      yield* store.create("round-1", "{}", {
        parentRunId: "round-0",
        lineageId: "round-0",
        roundOrdinal: 1
      })
      const round = yield* store.get("round-1")
      expect(round.parentRunId).toBe("round-0")
      expect(round.lineageId).toBe("round-0")
      expect(round.roundOrdinal).toBe(1)
    }))

  effect("lineage is walkable in SQL", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.create("a", "{}")
      yield* store.create("b", "{}", { parentRunId: "a" })
      yield* store.create("c", "{}", { parentRunId: "b" })
      const rows = yield* sql<{ readonly run_id: string }>`
        WITH RECURSIVE ancestry(run_id, parent_run_id) AS (
          SELECT run_id, parent_run_id FROM flows_runs WHERE run_id = 'c'
          UNION ALL
          SELECT flows_runs.run_id, flows_runs.parent_run_id
          FROM flows_runs JOIN ancestry ON flows_runs.run_id = ancestry.parent_run_id
        )
        SELECT run_id FROM ancestry
      `
      expect(rows.map((row) => row.run_id)).toEqual(["c", "b", "a"])
    }))

  effect("requestCancel is idempotent and unfenced", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "AlreadyRequested", requestedAtMs: 500 })
      expect(yield* store.requestCancel("missing", 900)).toEqual({ _tag: "NotFound" })
      expect((yield* store.get("run")).cancelRequestedAtMs).toBe(500)
    }))

  effect("a guarded completion loses to a cancel request", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      yield* store.requestCancel("run", 500)
      const guarded = yield* store.transitionOwned("run", owner, "completed", undefined, {
        cancelRequested: "absent"
      })
      expect(guarded).toEqual({ _tag: "GuardFailed" })
      expect((yield* store.get("run")).status).toBe("running")
    }))

  effect("a guarded completion wins when no cancel was requested", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      const guarded = yield* store.transitionOwned("run", owner, "completed", undefined, {
        cancelRequested: "absent"
      })
      expect(guarded).toEqual({ _tag: "Transitioned" })
    }))

  effect("a cancel-present guard admits only a requested cancellation", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      expect(
        yield* store.transitionOwned("run", owner, "cancelled", undefined, { cancelRequested: "present" })
      ).toEqual({ _tag: "GuardFailed" })
      yield* store.requestCancel("run", 500)
      expect(
        yield* store.transitionOwned("run", owner, "cancelled", undefined, { cancelRequested: "present" })
      ).toEqual({ _tag: "Transitioned" })
    }))

  effect("a guard on a lost fence still reports the fence loss", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      const other: OwnerId = { hostId: "host", pid: 2, nonce: "other" }
      expect(
        yield* store.transitionOwned("run", other, "completed", undefined, { cancelRequested: "absent" })
      ).toEqual({ _tag: "FenceLost" })
      expect(
        yield* store.transitionOwned("missing", owner, "completed", undefined, { cancelRequested: "absent" })
      ).toEqual({ _tag: "NotFound" })
    }))

  effect("a guarded running transition keeps ownership", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      expect(
        yield* store.transitionOwned("run", owner, "running", `{"a":1}`, { cancelRequested: "absent" })
      ).toEqual({ _tag: "Transitioned" })
      yield* store.requestCancel("run", 500)
      expect(
        yield* store.transitionOwned("run", owner, "running", undefined, { cancelRequested: "absent" })
      ).toEqual({ _tag: "GuardFailed" })
    }))

  for (
    const [name, guard] of [
      ["an unknown cancelRequested value", { cancelRequested: "typo" }],
      ["a null value", null],
      ["an excess property", { cancelRequested: "absent", typo: true }]
    ] as const
  ) {
    effect(`transitionOwned rejects ${name} in its guard`, () =>
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const runId = `invalid-guard-${name}`
        yield* store.create(runId, "{}")
        yield* own(store, runId)
        const exit = yield* Effect.exit(
          store.transitionOwned(runId, owner, "completed", undefined, guard as never)
        )
        expectRunStoreFailure(exit, "transitionOwned")
        expect(yield* store.get(runId)).toMatchObject({ status: "running", owner })
      }))
  }

  effect("transitionOwned rejects pending without changing the owned run", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run-no-transition-to-pending", "{}")
      yield* own(store, "run-no-transition-to-pending")
      const exit = yield* Effect.exit(
        store.transitionOwned("run-no-transition-to-pending", owner, "pending")
      )
      expectRunStoreFailure(exit, "transitionOwned")
      expect(yield* store.get("run-no-transition-to-pending")).toMatchObject({
        status: "running",
        owner
      })
    }))

  effect("create rejects an empty parent run id", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const failure = yield* Effect.flip(store.create("run", "{}", { parentRunId: "" }))
      expect(failure.code).toBe("invalid_run")
    }))

  effect("create rejects incomplete or invalid trampoline metadata", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      expect(
        (yield* Effect.flip(store.create("missing-ordinal", "{}", {
          lineageId: "lineage"
        }))).code
      ).toBe("invalid_run")
      expect(
        (yield* Effect.flip(store.create("missing-lineage", "{}", {
          roundOrdinal: 1
        }))).code
      ).toBe("invalid_run")
      expect(
        (yield* Effect.flip(store.create("negative-ordinal", "{}", {
          lineageId: "lineage",
          roundOrdinal: -1
        }))).code
      ).toBe("invalid_run")
    }))

  effect("requestCancel rejects an invalid timestamp", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const failure = yield* Effect.flip(store.requestCancel("run", -1))
      expect(failure.code).toBe("invalid_run")
    }))

  effect("the noop store reports typed losses for the new operations", () =>
    Effect.gen(function*() {
      const store = RunStore.makeNoop()
      expect(yield* store.requestCancel("run", 1)).toEqual({ _tag: "NotFound" })
    }))
})

/**
 * B10: the `requestCancel` fallback read collapsed "the row does not exist"
 * and "the row exists with a NULL column" into one `== null` test, so a writer
 * on another connection clearing `cancel_requested_at_ms` between the fenced
 * UPDATE and the fallback SELECT made a live run report `NotFound`. The caller
 * then skipped the retry it performs for a genuine race.
 *
 * Both interleavings are driven here by running the interfering statement from
 * inside the client, at the exact point a second connection would have.
 */
describe("requestCancel distinguishes an absent row from a cleared column (B10)", () => {
  const withInterleaving = (
    match: string,
    nth: number,
    interfere: (base: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>
  ) =>
    Layer.provideMerge(
      RunStore.layer,
      Layer.provideMerge(
        interleaving(match, nth, interfere),
        Layer.provideMerge(Migrations.layer, TestDatabase.layer)
      )
    )

  it.effect("re-records the cancellation when the column is cleared under it", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })
      // The fenced UPDATE now matches nothing, and the fallback SELECT runs
      // against a row whose column another writer just cleared.
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "CancelRequested", requestedAtMs: 900 })
    }).pipe(
      Effect.provide(withInterleaving(
        "SELECT cancel_requested_at_ms",
        1,
        (base) => base`UPDATE flows_runs SET cancel_requested_at_ms = NULL WHERE run_id = 'run'`
      )),
      Effect.scoped
    ))

  it.effect("reports NotFound only when the row is really gone", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })
      // Cleared before the SELECT by the first interleaving, then deleted
      // before the re-record: the run is genuinely absent by then.
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "NotFound" })
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          RunStore.layer,
          Layer.provideMerge(
            Layer.effect(
              SqlClient.SqlClient,
              Effect.gen(function*() {
                const base = yield* Effect.service(SqlClient.SqlClient)
                let updates = 0
                return new Proxy(base, {
                  apply(target, thisArgument, argumentsList) {
                    const statement = Reflect.apply(
                      target,
                      thisArgument,
                      argumentsList
                    ) as Statement.Statement<unknown>
                    if (typeof statement.compile !== "function") return statement
                    const [query] = statement.compile()
                    if (query.includes("SELECT cancel_requested_at_ms")) {
                      return Effect.andThen(
                        base`UPDATE flows_runs SET cancel_requested_at_ms = NULL WHERE run_id = 'run'`,
                        statement
                      )
                    }
                    if (query.includes("SET cancel_requested_at_ms")) {
                      updates += 1
                      // The third UPDATE is the re-record after the SELECT.
                      if (updates === 3) {
                        return Effect.andThen(base`DELETE FROM flows_runs WHERE run_id = 'run'`, statement)
                      }
                    }
                    return statement
                  }
                }) as SqlClient.SqlClient
              })
            ),
            Layer.provideMerge(Migrations.layer, TestDatabase.layer)
          )
        )
      ),
      Effect.scoped
    ))

  it.effect("reports the cancellation another writer recorded before the retry", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "AlreadyRequested", requestedAtMs: 777 })
      expect(yield* store.get("run")).toMatchObject({
        status: "pending",
        cancelRequestedAtMs: 777
      })
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          RunStore.layer,
          Layer.provideMerge(
            interleaving(
              "SET cancel_requested_at_ms",
              3,
              (base) => base`UPDATE flows_runs SET cancel_requested_at_ms = 777 WHERE run_id = 'run'`
            ),
            Layer.provideMerge(
              interleaving(
                "SELECT cancel_requested_at_ms",
                1,
                (base) => base`UPDATE flows_runs SET cancel_requested_at_ms = NULL WHERE run_id = 'run'`
              ),
              Layer.provideMerge(Migrations.layer, TestDatabase.layer)
            )
          )
        )
      ),
      Effect.scoped
    ))
})

describe("requestCancel status decode failures", () => {
  effect("fails decode_failed at the fallback status read", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.create("bad-fallback-status", "{}")
      yield* sql`PRAGMA ignore_check_constraints = ON`
      yield* sql`
        UPDATE flows_runs
        SET status = 'not-a-status', cancel_requested_at_ms = 1
        WHERE run_id = 'bad-fallback-status'
      `
      yield* sql`PRAGMA ignore_check_constraints = OFF`
      const exit = yield* Effect.exit(store.requestCancel("bad-fallback-status", 2))
      expectRunStoreFailure(exit, "requestCancel", "decode_failed")
    }))

  it.effect("fails decode_failed at the closing status read", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })
      const exit = yield* Effect.exit(store.requestCancel("run", 900))
      expectRunStoreFailure(exit, "requestCancel", "decode_failed")
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          RunStore.layer,
          Layer.provideMerge(
            interleaving(
              "SET cancel_requested_at_ms",
              3,
              (base) =>
                Effect.gen(function*() {
                  yield* base`PRAGMA ignore_check_constraints = ON`
                  yield* base`
                    UPDATE flows_runs
                    SET status = 'not-a-status', cancel_requested_at_ms = 777
                    WHERE run_id = 'run'
                  `
                  yield* base`PRAGMA ignore_check_constraints = OFF`
                })
            ),
            Layer.provideMerge(
              interleaving(
                "SELECT cancel_requested_at_ms",
                1,
                (base) => base`UPDATE flows_runs SET cancel_requested_at_ms = NULL WHERE run_id = 'run'`
              ),
              Layer.provideMerge(Migrations.layer, TestDatabase.layer)
            )
          )
        )
      ),
      Effect.scoped
    ))
})

/**
 * B-02: `requestCancel` guarded only on `cancel_requested_at_ms IS NULL`, with
 * no status predicate, so a run that had already settled accepted new
 * cancellation intent forever. The write was not harmless: nothing ever acts
 * on it — the run has no owner and no drive to observe it — and
 * `RunDriver.inheritParentCancellation` reads the column straight off a
 * terminal parent, so a request written against a `completed` parent cancelled
 * children that parent had finished with.
 *
 * A settled run therefore reports the terminal status instead of recording
 * anything. The status is read rather than assumed, so the caller learns which
 * ending it lost to.
 */
describe("requestCancel refuses a run that already settled (B-02)", () => {
  /** Settles a run terminally through the owned transition, as a driver does. */
  const settle = (store: RunStore.Service, runId: string, status: RunStore.RunStatus) =>
    Effect.gen(function*() {
      yield* store.create(runId, "{}")
      yield* own(store, runId)
      expect(yield* store.transitionOwned(runId, owner, status, undefined)).toEqual({ _tag: "Transitioned" })
    })

  effect("a completed run answers Terminal twice and leaves the column NULL", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* settle(store, "run", "completed")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "Terminal", status: "completed" })
      expect((yield* store.get("run")).cancelRequestedAtMs).toBeNull()
      // Repeating it is the operator retry: it must stay Terminal rather than
      // decaying into AlreadyRequested off a column the first call wrote.
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "Terminal", status: "completed" })
      expect((yield* store.get("run")).cancelRequestedAtMs).toBeNull()
    }))

  effect("a failed run answers Terminal and leaves the column NULL", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* settle(store, "run", "failed")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "Terminal", status: "failed" })
      expect((yield* store.get("run")).cancelRequestedAtMs).toBeNull()
    }))

  effect("a cancelled run answers Terminal and keeps the request that closed it", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })
      expect(yield* store.transitionOwned("run", owner, "cancelled", undefined)).toEqual({ _tag: "Transitioned" })
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "Terminal", status: "cancelled" })
      expect((yield* store.get("run")).cancelRequestedAtMs).toBe(500)
    }))

  it.effect("reports the ending a run reached while the request was being retried", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })
      // The narrow window the retry path opens: the fallback SELECT reads a
      // live run with a cleared column, so the call retries — and the run
      // settles before that retry lands. The retried UPDATE loses to the
      // status predicate, which is indistinguishable from a missing row unless
      // the miss is read back. `NotFound` about a run that just completed is
      // the wrong answer twice over: the row is there, and the caller is told
      // to look for a run rather than that its request lost to an ending.
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "Terminal", status: "completed" })
      expect((yield* store.get("run")).status).toBe("completed")
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          RunStore.layer,
          Layer.provideMerge(
            Layer.effect(
              SqlClient.SqlClient,
              Effect.gen(function*() {
                const base = yield* Effect.service(SqlClient.SqlClient)
                let updates = 0
                return new Proxy(base, {
                  apply(target, thisArgument, argumentsList) {
                    const statement = Reflect.apply(
                      target,
                      thisArgument,
                      argumentsList
                    ) as Statement.Statement<unknown>
                    if (typeof statement.compile !== "function") return statement
                    const [query] = statement.compile()
                    // Clear the column ahead of the fallback SELECT, so the
                    // call sees a live run with nothing recorded and retries.
                    if (query.includes("SELECT cancel_requested_at_ms")) {
                      return Effect.andThen(
                        base`UPDATE flows_runs SET cancel_requested_at_ms = NULL WHERE run_id = 'run'`,
                        statement
                      )
                    }
                    if (query.includes("SET cancel_requested_at_ms")) {
                      updates += 1
                      // The third UPDATE is the re-record after the SELECT.
                      if (updates === 3) {
                        return Effect.andThen(
                          base`
                            UPDATE flows_runs
                            SET
                              status = 'completed',
                              started_at_ms = COALESCE(started_at_ms, created_at_ms),
                              finished_at_ms = COALESCE(started_at_ms, created_at_ms),
                              owner_host_id = NULL,
                              owner_pid = NULL,
                              owner_nonce = NULL,
                              heartbeat_at_ms = NULL,
                              claim_host_id = NULL,
                              claim_pid = NULL,
                              claim_nonce = NULL,
                              claimed_at_ms = NULL
                            WHERE run_id = 'run'
                          `,
                          statement
                        )
                      }
                    }
                    return statement
                  }
                }) as SqlClient.SqlClient
              })
            ),
            Layer.provideMerge(Migrations.layer, TestDatabase.layer)
          )
        )
      ),
      Effect.scoped
    ))

  it.effect("reports NotFound when the run is deleted during the retry window", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "NotFound" })
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          RunStore.layer,
          Layer.provideMerge(
            interleaving(
              "SET cancel_requested_at_ms",
              3,
              (base) => base`DELETE FROM flows_runs WHERE run_id = 'run'`
            ),
            Layer.provideMerge(
              interleaving(
                "SELECT cancel_requested_at_ms",
                1,
                (base) => base`UPDATE flows_runs SET cancel_requested_at_ms = NULL WHERE run_id = 'run'`
              ),
              Layer.provideMerge(Migrations.layer, TestDatabase.layer)
            )
          )
        )
      ),
      Effect.scoped
    ))

  effect("a pending, running, or suspended run still records the request", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("pending-run", "{}")
      expect(yield* store.requestCancel("pending-run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })

      yield* store.create("running-run", "{}")
      yield* own(store, "running-run")
      expect(yield* store.requestCancel("running-run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })

      yield* store.create("suspended-run", "{}")
      yield* own(store, "suspended-run")
      yield* store.transitionOwned("suspended-run", owner, "suspended", undefined)
      expect(yield* store.requestCancel("suspended-run", 500)).toEqual({
        _tag: "CancelRequested",
        requestedAtMs: 500
      })
    }))
})
