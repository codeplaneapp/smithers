/**
 * Pins the namespacing contract of the composed migrator: two storage packages
 * that both ship an `0001_initial` must migrate to distinct identities, and a
 * package that mis-declares its namespace or id block must fail the migration
 * loudly rather than silently shadow its neighbour's table.
 *
 * Derived contract: `docs/specs/Concepts/Journal Split.md`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Migrator from "effect/unstable/sql/Migrator"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"

const createTable = (name: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY)`)
  })

const alpha: Migrations.MigrationSet = {
  namespace: "alpha",
  idOffset: 0,
  migrations: { "0001_initial": createTable("alpha_rows") }
}

const beta: Migrations.MigrationSet = {
  namespace: "beta",
  idOffset: Migrations.idBlock,
  migrations: { "0001_initial": createTable("beta_rows") }
}

const provided = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.exit(effect.pipe(Effect.provide(TestDatabase.layer)))

const failureMessage = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.map(provided(effect), (exit) => {
    if (exit._tag !== "Failure") throw new Error("expected the migration to fail")
    return JSON.stringify(exit.cause)
  })

describe("composed migrations", () => {
  it.effect("applies migration id zero on a fresh database", () =>
    Effect.gen(function*() {
      const zero: Migrations.MigrationSet = {
        namespace: "zero",
        idOffset: 0,
        migrations: { "0000_initial": createTable("zero_rows") }
      }
      const exit = yield* provided(Migrations.run([zero]))

      expect(exit._tag).toBe("Success")
      expect(exit._tag === "Success" ? exit.value : []).toEqual([[0, "zero_initial"]])
    }))

  it.effect("records and persists the id-zero migration like any other", () =>
    Effect.gen(function*() {
      const zero: Migrations.MigrationSet = {
        namespace: "zero",
        idOffset: 0,
        migrations: {
          "0000_initial": createTable("zero_rows"),
          "0001_second": createTable("zero_more_rows")
        }
      }
      const result = yield* (
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const first = yield* Migrations.run([zero])
          const second = yield* Migrations.run([zero])
          const records = yield* sql<
            { readonly migration_id: number; readonly name: string }
          >`SELECT migration_id, name FROM ${sql(Migrations.table)} ORDER BY migration_id`
          return { first, records, second }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.first).toEqual([
        [0, "zero_initial"],
        [1, "zero_second"]
      ])
      expect(result.second).toEqual([])
      expect(result.records).toEqual([
        { migration_id: 0, name: "zero_initial" },
        { migration_id: 1, name: "zero_second" }
      ])
    }))

  it.effect("rolls back a failing id-zero migration with the whole run", () =>
    Effect.gen(function*() {
      const broken: Migrations.MigrationSet = {
        namespace: "zero",
        idOffset: 0,
        migrations: { "0000_initial": Effect.fail("zero migration failed") }
      }
      const result = yield* (
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const failed = yield* Effect.exit(Migrations.run([broken]))
          const records = yield* sql<
            { readonly migration_id: number }
          >`SELECT migration_id FROM ${sql(Migrations.table)}`
          return { failed, records }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(Exit.isFailure(result.failed)).toBe(true)
      if (Exit.isFailure(result.failed)) {
        const defect = Cause.findDefect(result.failed.cause)
        expect(Result.isSuccess(defect)).toBe(true)
        if (Result.isSuccess(defect)) {
          expect(defect.success).toBeInstanceOf(Migrator.MigrationError)
          expect(defect.success).toMatchObject({ kind: "Failed", message: `Migration "0_zero_initial" failed` })
        }
      }
      expect(result.records).toEqual([])
    }))

  it.effect("applies migration id zero through a hand-wired loader", () =>
    Effect.gen(function*() {
      const zero: Migrations.MigrationSet = {
        namespace: "zero",
        idOffset: 0,
        migrations: { "0000_initial": createTable("zero_rows") }
      }
      const result = yield* (
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          // Creates the migrations table the standalone loader reads.
          yield* Migrations.run([])
          const resolved = yield* Migrations.loader([zero])
          const records = yield* sql<
            { readonly migration_id: number; readonly name: string }
          >`SELECT migration_id, name FROM ${sql(Migrations.table)}`
          return { records, resolved: resolved.map(([id, name]) => [id, name]) }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.resolved).toEqual([[0, "zero_initial"]])
      expect(result.records).toEqual([{ migration_id: 0, name: "zero_initial" }])
    }))

  it.effect("lifts each package's local ids into the block it reserves", () =>
    Effect.gen(function*() {
      const exit = yield* provided(Migrations.run([alpha, beta]))
      expect(exit._tag).toBe("Success")
      expect(exit._tag === "Success" ? exit.value : []).toEqual([
        [1, "alpha_initial"],
        [1001, "beta_initial"]
      ])
    }))

  it.effect("runs migrations in id order however the sets are supplied", () =>
    Effect.gen(function*() {
      const exit = yield* provided(Migrations.run([beta, alpha]))
      expect(exit._tag === "Success" ? exit.value : []).toEqual([
        [1, "alpha_initial"],
        [1001, "beta_initial"]
      ])
    }))

  it.effect("installs every set's tables through the layer", () =>
    Effect.gen(function*() {
      const exit = yield* provided(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<
            { readonly name: string }
          >`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
        }).pipe(Effect.provide(Migrations.layer([alpha, beta])))
      )
      expect(exit._tag === "Success" ? exit.value.map((row) => row.name) : []).toEqual([
        "alpha_rows",
        "beta_rows",
        Migrations.table
      ].sort())
    }))

  it.effect("rejects a duplicate namespace", () =>
    Effect.gen(function*() {
      expect(yield* failureMessage(Migrations.run([alpha, { ...beta, namespace: "alpha" }])))
        .toContain("Duplicate migration namespace: alpha")
    }))

  it.effect("rejects a duplicate id offset", () =>
    Effect.gen(function*() {
      expect(yield* failureMessage(Migrations.run([alpha, { ...beta, idOffset: 0 }])))
        .toContain("Duplicate migration id offset 0 for namespace beta")
    }))

  it.effect("rejects an id collision the offsets failed to prevent", () =>
    Effect.gen(function*() {
      const overlapping: Migrations.MigrationSet = {
        namespace: "gamma",
        idOffset: 1,
        migrations: { "1000_initial": createTable("gamma_rows") }
      }
      expect(yield* failureMessage(Migrations.run([beta, overlapping])))
        .toContain("Migration id 1001 claimed by both beta and gamma")
    }))

  it.effect("rejects a set the migrator's high-water mark would silently skip", () =>
    Effect.gen(function*() {
      // `Migrator` runs only ids above the highest applied one, so migrating the
      // 1000 block first leaves `alpha`'s id 1 looking done. Failing here is the
      // whole point: the alternative is a missing table and a passing migration.
      const message = yield* failureMessage(Effect.flatMap(
        Migrations.run([beta]),
        () => Migrations.run([alpha, beta])
      ))
      expect(message).toContain("Migration 1_alpha_initial would be skipped")
      expect(message).toContain("already applied migration id 1001")
    }))

  it.effect("accepts a set every id of which is already applied", () =>
    Effect.gen(function*() {
      const exit = yield* provided(Effect.flatMap(
        Migrations.run([alpha, beta]),
        () => Migrations.run([alpha])
      ))
      expect(exit._tag === "Success" ? exit.value : "failed").toEqual([])
    }))

  it.effect("rolls back partial DDL and migration records when a later migration fails", () =>
    Effect.gen(function*() {
      const broken: Migrations.MigrationSet = {
        namespace: "rerun",
        idOffset: 0,
        migrations: {
          "0001_first": createTable("rerun_first"),
          "0002_second": Effect.fail("second migration failed")
        }
      }
      const corrected: Migrations.MigrationSet = {
        ...broken,
        migrations: {
          "0001_first": createTable("rerun_first"),
          "0002_second": createTable("rerun_second")
        }
      }

      const result = yield* (
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const failed = yield* Effect.exit(Migrations.run([broken]))
          const tablesAfterFailure = yield* sql<
            { readonly name: string }
          >`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
          const recordsAfterFailure = yield* sql<
            { readonly migration_id: number }
          >`SELECT migration_id FROM ${sql(Migrations.table)} ORDER BY migration_id`
          const completed = yield* Migrations.run([corrected])
          const tablesAfterRerun = yield* sql<
            { readonly name: string }
          >`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
          return { completed, failed, recordsAfterFailure, tablesAfterFailure, tablesAfterRerun }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(Exit.isFailure(result.failed)).toBe(true)
      if (Exit.isFailure(result.failed)) {
        const defect = Cause.findDefect(result.failed.cause)
        expect(Result.isSuccess(defect)).toBe(true)
        if (Result.isSuccess(defect)) {
          expect(defect.success).toBeInstanceOf(Migrator.MigrationError)
          expect(defect.success).toMatchObject({ kind: "Failed" })
        }
      }
      expect(result.tablesAfterFailure.map((row) => row.name)).toEqual([Migrations.table])
      expect(result.recordsAfterFailure).toEqual([])
      expect(result.completed).toEqual([
        [1, "rerun_first"],
        [2, "rerun_second"]
      ])
      expect(result.tablesAfterRerun.map((row) => row.name)).toEqual([
        Migrations.table,
        "rerun_first",
        "rerun_second"
      ].sort())
    }))

  it.effect("accepts an empty array of migration sets", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const completed = yield* Migrations.run([])
          const tables = yield* sql<
            { readonly name: string }
          >`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
          return { completed, tables }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.completed).toEqual([])
      expect(result.tables.map((row) => row.name)).toEqual([Migrations.table])
    }))

  it.effect("accepts a migration set with no migrations", () =>
    Effect.gen(function*() {
      const empty: Migrations.MigrationSet = {
        namespace: "empty",
        idOffset: 0,
        migrations: {}
      }
      const exit = yield* provided(Migrations.run([empty]))

      expect(exit._tag).toBe("Success")
      expect(exit._tag === "Success" ? exit.value : "failed").toEqual([])
    }))

  it.effect("rejects a negative idOffset as bad migration state", () =>
    Effect.gen(function*() {
      const invalid: Migrations.MigrationSet = {
        namespace: "negative",
        idOffset: -1,
        migrations: { "1000_initial": createTable("negative_rows") }
      }
      const exit = yield* provided(Migrations.run([invalid]))
      const failure = Exit.isFailure(exit) ? Result.getOrUndefined(Cause.findError(exit.cause)) : undefined

      expect(failure).toBeInstanceOf(Migrator.MigrationError)
      expect(failure).toMatchObject({ kind: "BadState" })
    }))

  it.effect("rejects a non-integer idOffset as bad migration state", () =>
    Effect.gen(function*() {
      const invalid: Migrations.MigrationSet = {
        namespace: "fractional",
        idOffset: 0.5,
        migrations: { "0001_initial": createTable("fractional_rows") }
      }
      const exit = yield* provided(Migrations.run([invalid]))
      const failure = Exit.isFailure(exit) ? Result.getOrUndefined(Cause.findError(exit.cause)) : undefined

      expect(failure).toBeInstanceOf(Migrator.MigrationError)
      expect(failure).toMatchObject({ kind: "BadState" })
    }))

  it.effect("reports a migrations table it cannot read", () =>
    Effect.gen(function*() {
      expect(yield* failureMessage(Migrations.loader([alpha])))
        .toContain(`Could not read ${Migrations.table}`)
    }))

  it.effect("rejects a malformed migration key", () =>
    Effect.gen(function*() {
      const malformed: Migrations.MigrationSet = {
        namespace: "delta",
        idOffset: 0,
        migrations: { initial: createTable("delta_rows") }
      }
      expect(yield* failureMessage(Migrations.run([malformed])))
        .toContain("Malformed migration key")
    }))
})
