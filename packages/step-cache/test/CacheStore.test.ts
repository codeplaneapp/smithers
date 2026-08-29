import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import type * as Statement from "effect/unstable/sql/Statement"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CacheStore } from "../src/CacheStore.ts"
import * as CacheStoreLive from "../src/CacheStore.ts"
import * as Migrations from "../src/Migrations.ts"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => effect

type DatabaseDecorator = Layer.Layer<
  DurableWriter.DurableWriter | SqlClient.SqlClient,
  never,
  DurableWriter.DurableWriter | SqlClient.SqlClient
>

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | CacheStore>,
  database?: DatabaseDecorator
) => {
  const store = database === undefined
    ? CacheStoreLive.layer
    : CacheStoreLive.layer.pipe(Layer.provide(database))
  return run(
    effect.pipe(
      Effect.provide(store),
      Effect.provide(Migrations.layer),
      Effect.provide(TestDatabase.layer)
    )
  )
}

const entry = {
  keyDigest: "digest-1",
  result: { output: "ok" },
  meta: { source: "recorded" },
  createdAtMs: 10,
  recordedRunId: "run-1",
  recordedEventSeq: 7
} as const

/** Names an eviction outcome — its error code, or the boolean it returned. */
const outcomeOf = (exit: Exit.Exit<boolean, CacheStoreLive.CacheStoreError>): string => {
  if (Exit.isSuccess(exit)) return `evicted:${exit.value}`
  const reason = exit.cause.reasons[0]!
  return reason._tag === "Fail" ? reason.error.code : reason._tag
}

const failingDatabase = (cause: unknown): Layer.Layer<DurableWriter.DurableWriter | SqlClient.SqlClient> => {
  const sql = new Proxy(
    () => Effect.fail(cause),
    { apply: () => Effect.fail(cause) }
  ) as unknown as SqlClient.SqlClient
  const write: DurableWriter.Service["write"] = (effect) => effect
  return Layer.merge(
    Layer.succeed(SqlClient.SqlClient)(sql),
    Layer.succeed(DurableWriter.DurableWriter)(DurableWriter.DurableWriter.of({ write }))
  )
}

/**
 * A database whose `.raw` results carry node-postgres' `{rowCount}` shape
 * instead of the SQLite drivers' `{changes}`, one result per statement.
 */
const postgresShapedDatabase = (
  results: ReadonlyArray<unknown>
): Layer.Layer<DurableWriter.DurableWriter | SqlClient.SqlClient> => {
  let next = 0
  const sql = (() => ({ raw: Effect.sync(() => results[next++]) })) as unknown as SqlClient.SqlClient
  const write: DurableWriter.Service["write"] = (effect) => effect
  return Layer.merge(
    Layer.succeed(SqlClient.SqlClient)(sql),
    Layer.succeed(DurableWriter.DurableWriter)(DurableWriter.DurableWriter.of({ write }))
  )
}

/** Records compiled cache-row deletes while preserving the in-memory database. */
const recordingDatabase = (deletes: Array<string>): DatabaseDecorator =>
  Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function*() {
        const base = yield* Effect.service(SqlClient.SqlClient)
        return new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (typeof statement.compile === "function") {
              const [query] = statement.compile()
              if (query.includes("DELETE FROM flows_step_cache")) deletes.push(query)
            }
            return statement
          }
        }) as SqlClient.SqlClient
      })
    ),
    Layer.effect(DurableWriter.DurableWriter, Effect.service(DurableWriter.DurableWriter))
  )

describe("CacheStore", () => {
  it.effect("returns none for a cache miss", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        return yield* store.get("missing")
      }))

      expect(Option.isNone(result)).toBe(true)
    }))

  it.effect("records an entry and returns its recorded provenance", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        const put = yield* store.put(entry)
        const found = yield* store.get(entry.keyDigest)
        return { put, found }
      }))

      expect(result.put).toEqual({ _tag: "Inserted" })
      expect(Option.getOrThrow(result.found)).toEqual(entry)
    }))

  it.effect("serves each provenance its recorded version however the head has moved", () =>
    Effect.gen(function*() {
      const replaced = {
        ...entry,
        result: { output: "replaced" },
        createdAtMs: 20,
        recordedRunId: "run-2",
        recordedEventSeq: 9
      }
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        yield* store.put(entry)
        yield* store.evict(entry.keyDigest)
        yield* store.put(replaced)
        return {
          original: yield* store.get(entry.keyDigest, {
            recordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
          }),
          current: yield* store.get(entry.keyDigest, {
            recordedBy: { runId: replaced.recordedRunId, eventSeq: replaced.recordedEventSeq }
          }),
          // No ledger row under this provenance: the head answers instead.
          fallback: yield* store.get(entry.keyDigest, {
            recordedBy: { runId: entry.recordedRunId, eventSeq: 8 }
          }),
          head: yield* store.get(entry.keyDigest)
        }
      }))

      expect(Option.getOrThrow(result.original)).toEqual(entry)
      expect(Option.getOrThrow(result.current)).toEqual(replaced)
      expect(Option.getOrThrow(result.fallback)).toEqual(replaced)
      expect(Option.getOrThrow(result.head)).toEqual(replaced)
    }))

  it.effect("keeps the first recorded bytes for a provenance across a conflicting re-put", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        yield* store.put(entry)
        const put = yield* store.put({ ...entry, result: { output: "different" } })
        return {
          put,
          recorded: yield* store.get(entry.keyDigest, {
            recordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
          })
        }
      }))

      expect(result.put).toEqual({ _tag: "Conflict" })
      expect(Option.getOrThrow(result.recorded)).toEqual(entry)
    }))

  it.effect("recognizes an identical re-put", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        yield* store.put(entry)
        return yield* store.put(entry)
      }))

      expect(result).toEqual({ _tag: "ExistingSame" })
    }))

  it.effect("rejects a different result under an existing digest without replacing it", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        yield* store.put(entry)
        const put = yield* store.put({ ...entry, result: { output: "different" } })
        const found = yield* store.get(entry.keyDigest)
        return { put, found }
      }))

      expect(result.put).toEqual({ _tag: "Conflict" })
      expect(Option.getOrThrow(result.found).result).toEqual({ output: "ok" })
    }))

  it.effect("reports ExistingSame for structurally equal results built in different key orders (B11)", () =>
    Effect.gen(function*() {
      // `ExistingSame` versus `Conflict` is decided on `result_json` text. Under
      // `JSON.stringify` that text depends on key insertion order, so a body that
      // spreads a decoded record — or that reorders fields across a refactor —
      // produced `Conflict` for a result that had not changed.
      // `ActionPersistence` routes `Conflict` to the `Inconsistency` receiver
      // whose core default verdict is `fail`, so the run failed with
      // `CacheConflictDetected` naming a divergence that did not exist.
      const first = { a: 1, b: 2, nested: { x: "x", y: "y" } }
      const reordered = { nested: { y: "y", x: "x" }, b: 2, a: 1 }
      expect(JSON.stringify(first)).not.toBe(JSON.stringify(reordered))

      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        yield* store.put({ ...entry, result: first })
        const put = yield* store.put({ ...entry, result: reordered })
        const found = yield* store.get(entry.keyDigest)
        return { put, found }
      }))

      expect(result.put).toEqual({ _tag: "ExistingSame" })
      expect(Option.getOrThrow(result.found).result).toEqual(first)
    }))

  it.effect("reports ExistingSame for an identical result with different meta, keeping the first writer's meta", () =>
    Effect.gen(function*() {
      // Pinning the current behaviour, which was undocumented: `meta_json` is
      // not compared, so a second writer agreeing on the result never conflicts
      // and never overwrites. Meta is provenance about the recording, not part
      // of the cached value, so the first writer's copy is the one the row keeps.
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        yield* store.put(entry)
        const put = yield* store.put({ ...entry, meta: { source: "converged", extra: true } })
        const found = yield* store.get(entry.keyDigest)
        return { put, found }
      }))

      expect(result.put).toEqual({ _tag: "ExistingSame" })
      expect(Option.getOrThrow(result.found).meta).toEqual({ source: "recorded" })
    }))

  it.effect("evicts an entry", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        yield* store.put(entry)
        yield* store.evict(entry.keyDigest)
        return yield* store.get(entry.keyDigest)
      }))

      expect(Option.isNone(result)).toBe(true)
    }))

  it.effect("fences an eviction on the row's recorded provenance", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        yield* store.put(entry)
        // A foreign process replaced the row between the poisoned read and the
        // delete: the compare-and-swap must be a no-op, not drop the fresh row.
        const stale = yield* store.evict(entry.keyDigest, {
          ifRecordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq + 1 }
        })
        const survived = yield* store.get(entry.keyDigest)
        const matching = yield* store.evict(entry.keyDigest, {
          ifRecordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
        })
        const gone = yield* store.get(entry.keyDigest)
        return { stale, survived, matching, gone }
      }))

      expect(result.stale).toBe(false)
      expect(Option.isSome(result.survived)).toBe(true)
      expect(result.matching).toBe(true)
      expect(Option.isNone(result.gone)).toBe(true)
    }))

  it.effect("fences an eviction on the recording run, not the event seq alone", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        yield* store.put(entry)
        // Sequence numbers are per-run, so a foreign run's provenance collides
        // on `eventSeq` routinely. Only the run half of the compare-and-swap
        // tells the two recordings apart (issue #135).
        const foreign = yield* store.evict(entry.keyDigest, {
          ifRecordedBy: { runId: "foreign-run", eventSeq: entry.recordedEventSeq }
        })
        const survived = yield* store.get(entry.keyDigest)
        return { foreign, survived }
      }))

      expect(result.foreign).toBe(false)
      expect(Option.isSome(result.survived)).toBe(true)
    }))

  it.effect("is a no-op when a foreign process on another connection landed a fresher row", () =>
    Effect.gen(function*() {
      // The two cells above drive the #119 fence through one connection, which
      // cannot show what the fence is for: the window it closes is a *second
      // process* recording under the same key between a poisoned read and the
      // delete. Two connections over one file database is that window.
      const directory = mkdtempSync(join(tmpdir(), "flows-step-cache-fence-"))
      const filename = join(directory, "cache.db")
      const connection = () =>
        Layer.provideMerge(
          CacheStoreLive.layer,
          Layer.provideMerge(
            Migrations.layer,
            Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
          )
        )

      try {
        const result = yield* run(
          Effect.gen(function*() {
            // The owning process records, then reads its provenance.
            yield* Effect.scoped(
              Effect.gen(function*() {
                const store = yield* CacheStore
                yield* store.put(entry)
              }).pipe(Effect.provide(connection()))
            )

            // A foreign process on its own connection evicts and re-records.
            yield* Effect.scoped(
              Effect.gen(function*() {
                const store = yield* CacheStore
                yield* store.evict(entry.keyDigest)
                yield* store.put({ ...entry, recordedRunId: "run-2", recordedEventSeq: 11 })
              }).pipe(Effect.provide(connection()))
            )

            // The owner's fenced evict still names the provenance it read.
            return yield* Effect.scoped(
              Effect.gen(function*() {
                const store = yield* CacheStore
                const evicted = yield* store.evict(entry.keyDigest, {
                  ifRecordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
                })
                const survivor = yield* store.get(entry.keyDigest)
                return { evicted, survivor }
              }).pipe(Effect.provide(connection()))
            )
          })
        )

        expect(result.evicted).toBe(false)
        expect(Option.getOrThrow(result.survivor).recordedRunId).toBe("run-2")
        expect(Option.getOrThrow(result.survivor).recordedEventSeq).toBe(11)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }))

  it.effect("rejects a malformed eviction fence with invalid_cache and no DELETE", () =>
    Effect.gen(function*() {
      // The fence is a compare-and-swap the caller supplies at runtime. A value
      // that can name no row is a caller defect, and reporting it as an ordinary
      // "nothing matched" hides an eviction that never had a chance to run.
      const deletes: Array<string> = []
      const result = yield* migrated(
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const store = yield* CacheStore
          yield* store.put(entry)
          const malformed: ReadonlyArray<{ readonly runId: string; readonly eventSeq: number }> = [
            { runId: "", eventSeq: entry.recordedEventSeq },
            { runId: entry.recordedRunId, eventSeq: -1 },
            { runId: entry.recordedRunId, eventSeq: 0.5 },
            { runId: entry.recordedRunId, eventSeq: Number.NaN },
            { runId: entry.recordedRunId, eventSeq: Number.MAX_SAFE_INTEGER + 1 }
          ]
          // `Effect.exit`, not `Effect.flip`: a fence that succeeds must surface as
          // the value it returned, so the recorded failure names the behaviour
          // being reported rather than throwing the raw `false` out of the run.
          const outcomes = yield* Effect.forEach(
            malformed,
            (ifRecordedBy) => Effect.exit(store.evict(entry.keyDigest, { ifRecordedBy })).pipe(Effect.map(outcomeOf))
          )
          const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM flows_step_cache
      `
          return { outcomes, count: rows[0]!.count }
        }),
        recordingDatabase(deletes)
      )

      expect(deletes).toEqual([])
      // An eviction that could never have matched fails, and is never reported
      // as an ordinary miss.
      expect(result.outcomes).toEqual(Array.from({ length: 5 }, () => "invalid_cache"))
      // The row the fence could not name is untouched.
      expect(result.count).toBe(1)
    }))

  it.effect("counts affected rows on a driver that reports rowCount rather than changes", () =>
    Effect.gen(function*() {
      // node-postgres hands `.raw` back a `{rowCount}` result; a bun:sqlite
      // `{changes}` cast reads `undefined` there and reports every successful
      // delete as a no-op (issue #134).
      const evicted = yield* run(
        Effect.gen(function*() {
          const store = yield* CacheStore
          return yield* Effect.all([store.evict("digest-1"), store.evict("digest-2")])
        }).pipe(
          Effect.provide(CacheStoreLive.layer),
          Effect.provide(postgresShapedDatabase([{ rowCount: 1, rows: [] }, { rowCount: 0, rows: [] }]))
        )
      )

      expect(evicted).toEqual([true, false])
    }))

  it.effect("rejects empty keys and non-JSON values with invalid_cache", () =>
    Effect.gen(function*() {
      const failures = yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore
        return yield* Effect.all([
          Effect.flip(store.get("")),
          Effect.flip(store.put({ ...entry, keyDigest: "" })),
          Effect.flip(store.put({ ...entry, result: undefined })),
          Effect.flip(store.put({ ...entry, result: BigInt(1) })),
          Effect.flip(store.put({ ...entry, meta: undefined })),
          Effect.flip(store.put({ ...entry, meta: BigInt(1) })),
          Effect.flip(store.evict(""))
        ])
      }))

      expect(failures.every((failure) => failure.code === "invalid_cache")).toBe(true)
      expect(failures.some((failure) => failure.cause !== undefined)).toBe(true)
      expect(failures.some((failure) => failure.cause === undefined)).toBe(true)
    }))

  it.effect("rejects every invalid provenance field before persistence", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* CacheStore
        const invalidEntries: ReadonlyArray<CacheStoreLive.CacheEntry> = [
          { ...entry, createdAtMs: -1 },
          { ...entry, createdAtMs: 0.5 },
          { ...entry, createdAtMs: Number.MAX_SAFE_INTEGER + 1 },
          { ...entry, recordedRunId: "" },
          { ...entry, recordedEventSeq: -1 },
          { ...entry, recordedEventSeq: 0.5 },
          { ...entry, recordedEventSeq: Number.MAX_SAFE_INTEGER + 1 }
        ]
        const failures = yield* Effect.forEach(invalidEntries, (invalid) => Effect.flip(store.put(invalid)))
        const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM flows_step_cache
      `
        return { failures, count: rows[0]!.count }
      }))

      expect(result.failures.map((failure) => failure.code)).toEqual(
        Array.from({ length: 7 }, () => "invalid_cache")
      )
      expect(result.count).toBe(0)
    }))

  it.effect("reports decode_failed for corrupt durable cache JSON", () =>
    Effect.gen(function*() {
      const codes = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* CacheStore
        yield* store.put(entry)
        yield* sql`PRAGMA ignore_check_constraints = ON`
        const codes: Array<string> = []
        for (const column of ["result_json", "meta_json"] as const) {
          yield* sql.unsafe(
            `UPDATE flows_step_cache SET ${column} = 'not-json' WHERE key_digest = 'digest-1'`
          )
          const failure = yield* Effect.flip(store.get(entry.keyDigest))
          codes.push(failure.code)
          yield* sql.unsafe(
            `UPDATE flows_step_cache SET ${column} = '{}' WHERE key_digest = 'digest-1'`
          )
        }
        yield* sql`PRAGMA ignore_check_constraints = OFF`
        return codes
      }))

      expect(codes).toEqual(["decode_failed", "decode_failed"])
    }))

  it.effect("decodes complete durable cache rows before exposing provenance", () =>
    Effect.gen(function*() {
      const codes = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* CacheStore
        yield* store.put(entry)
        yield* sql`PRAGMA ignore_check_constraints = ON`
        const corruptions = [
          ["created_at_ms", "'bad'", "10"],
          ["recorded_run_id", "''", "'run-1'"],
          ["recorded_event_seq", "-1", "7"]
        ] as const
        const failures = yield* Effect.forEach(corruptions, ([column, value, restore]) =>
          Effect.gen(function*() {
            yield* sql.unsafe(
              `UPDATE flows_step_cache SET ${column} = ${value} WHERE key_digest = 'digest-1'`
            )
            const failure = yield* Effect.flip(store.get(entry.keyDigest))
            yield* sql.unsafe(
              `UPDATE flows_step_cache SET ${column} = ${restore} WHERE key_digest = 'digest-1'`
            )
            return failure.code
          }))
        yield* sql`PRAGMA ignore_check_constraints = OFF`
        return failures
      }))

      expect(codes).toEqual(["decode_failed", "decode_failed", "decode_failed"])
    }))

  it.effect("normalizes persistence failures into stable error codes", () =>
    Effect.gen(function*() {
      const existing = new CacheStoreLive.CacheStoreError({
        code: "unknown",
        message: "existing"
      })
      const causes: ReadonlyArray<unknown> = [
        existing,
        new SqlError.SqlError({
          reason: new SqlError.ConstraintError({ cause: new Error("constraint") })
        }),
        new SqlError.SqlError({
          reason: new SqlError.UniqueViolation({ cause: new Error("unique"), constraint: "cache" })
        }),
        new DurableWriter.DatabaseError({ code: "constraint" }),
        { code: "other" },
        {},
        null,
        "failure"
      ]
      const codes = yield* (
        Effect.forEach(
          causes,
          (cause) =>
            Effect.gen(function*() {
              const store = yield* CacheStore
              return (yield* Effect.flip(store.get("digest"))).code
            }).pipe(
              Effect.provide(CacheStoreLive.layer),
              Effect.provide(failingDatabase(cause))
            )
        )
      )

      expect(codes).toEqual([
        "unknown",
        "constraint",
        "constraint",
        "constraint",
        "persistence_failed",
        "persistence_failed",
        "persistence_failed",
        "persistence_failed"
      ])
    }))
})
