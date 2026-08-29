/**
 * The step cache owns `flows_step_cache` and reserves migration id block
 * 2000 — see `docs/specs/Concepts/Journal Split.md`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"

interface SqliteMasterRow {
  readonly name: string
  readonly type: "index" | "table"
  readonly sql: string | null
}

const migrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.layer))

describe("step-cache migrations", () => {
  it.effect("migrates a fresh database and reruns idempotently", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        yield* Migrations.run
        yield* Migrations.run
      }))
    }))

  it.effect("creates the head table, the recorded ledger, and nothing else", () =>
    Effect.gen(function*() {
      const master = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        return yield* sql<SqliteMasterRow>`SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'flows_%'`
      }))

      expect(master.filter((row) => row.type === "table").map((row) => row.name).sort()).toEqual([
        "flows_migrations",
        "flows_step_cache",
        "flows_step_cache_recorded"
      ])
      for (const table of ["flows_step_cache", "flows_step_cache_recorded"]) {
        const cacheSql = master.find((row) => row.name === table)?.sql ?? ""
        expect(cacheSql).toContain("length(key_digest) > 0")
        expect(cacheSql).toContain("json_valid(result_json)")
        expect(cacheSql).toContain("json_valid(meta_json)")
        expect(cacheSql).toContain("typeof(created_at_ms) = 'integer'")
        expect(cacheSql).toContain("length(recorded_run_id) > 0")
        expect(cacheSql).toContain("typeof(recorded_event_seq) = 'integer'")
      }
      const ledgerSql = master.find((row) => row.name === "flows_step_cache_recorded")?.sql ?? ""
      expect(ledgerSql).toContain("PRIMARY KEY (key_digest, recorded_run_id, recorded_event_seq)")
    }))

  it.effect("reserves its own migration id block so ids cannot collide", () =>
    Effect.gen(function*() {
      const applied = yield* (Migrations.run.pipe(Effect.provide(TestDatabase.layer)))
      expect(applied).toEqual([[2001, "step-cache_initial"]])
    }))

  it.effect("enforces every cache row invariant at the schema boundary", () =>
    Effect.gen(function*() {
      const outcomes = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const invalidRows = [
          "('', '{}', '{}', 0, 'run', 0)",
          "('bad-result', 'not-json', '{}', 0, 'run', 0)",
          "('bad-meta', '{}', 'not-json', 0, 'run', 0)",
          "('negative-created', '{}', '{}', -1, 'run', 0)",
          "('fractional-created', '{}', '{}', 0.5, 'run', 0)",
          "('unsafe-created', '{}', '{}', 9007199254740992, 'run', 0)",
          "('empty-run', '{}', '{}', 0, '', 0)",
          "('negative-seq', '{}', '{}', 0, 'run', -1)",
          "('fractional-seq', '{}', '{}', 0, 'run', 0.5)",
          "('unsafe-seq', '{}', '{}', 0, 'run', 9007199254740992)"
        ] as const
        return yield* Effect.forEach(invalidRows, (values) =>
          Effect.exit(sql.unsafe(
            `INSERT INTO flows_step_cache (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES ${values}`
          )))
      }))

      expect(outcomes.every(Exit.isFailure)).toBe(true)
    }))
})
