/**
 * The run store owns `flows_runs` and `flows_attempts` and reserves migration
 * id block 1000 — see `docs/specs/Concepts/Journal Split.md`.
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

describe("run-store migrations", () => {
  it.effect("migrates a fresh database and reruns idempotently", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        yield* Migrations.run
        yield* Migrations.run
      }))
    }))

  it.effect("creates the run and attempt tables and their indexes", () =>
    Effect.gen(function*() {
      const master = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        return yield* sql<SqliteMasterRow>`SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'flows_%'`
      }))

      expect(master.filter((row) => row.type === "table").map((row) => row.name).sort()).toEqual([
        "flows_attempts",
        "flows_migrations",
        "flows_runs"
      ])
      const indexes = master.filter((row) => row.type === "index").map((row) => row.name)
      expect(indexes).toContain("flows_runs_parent_run_id_idx")
      expect(indexes).toContain("flows_runs_cancel_requested_idx")
      expect(indexes).toContain("flows_runs_waiting_reason_wake_at_idx")
      expect(indexes).toContain("flows_runs_lineage_idx")
      expect(master.find((row) => row.name === "flows_runs_lineage_idx")?.sql).toContain("UNIQUE INDEX")
      const runsSql = master.find((row) => row.name === "flows_runs")?.sql ?? ""
      const attemptsSql = master.find((row) => row.name === "flows_attempts")?.sql ?? ""
      expect(runsSql).toContain("status IN")
      expect(runsSql).toContain("status = 'running'")
      expect(runsSql).toContain("status <> 'running'")
      expect(attemptsSql).toContain("FOREIGN KEY (run_id) REFERENCES flows_runs (run_id)")
    }))

  it.effect("reserves its own migration id block so ids cannot collide", () =>
    Effect.gen(function*() {
      const applied = yield* (Migrations.run.pipe(Effect.provide(TestDatabase.layer)))
      expect(applied).toEqual([[1001, "run-store_initial"], [1002, "run-store_lineage"]])
    }))

  it.effect("rejects a half-populated owner tuple", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`INSERT INTO flows_runs (run_id, status, owner_host_id, state_json) VALUES ('run', 'running', 'host', '{}')`
      })))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})
