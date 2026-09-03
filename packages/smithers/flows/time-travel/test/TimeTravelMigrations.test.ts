import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

const database = (filename: string) => Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))

const withDatabase = <A>(
  filename: string,
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient | DurableWriter.DurableWriter>
) => Effect.scoped(effect.pipe(Effect.provide(database(filename))))

describe("time-travel migrations", () => {
  it.effect("widens a legacy snapshots table that predates plan_digest", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-legacy-")))
      const filename = join(directory, "legacy.sqlite")
      try {
        const columns = yield* withDatabase(
          filename,
          Effect.gen(function*() {
            yield* EngineMigrations.run
            const sql = yield* Effect.service(SqlClient.SqlClient)
            yield* sql`
            CREATE TABLE flows_time_travel_snapshots (
              run_id TEXT NOT NULL,
              lineage_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              change_id TEXT NOT NULL,
              PRIMARY KEY (run_id, lineage_id, seq)
            )
          `
            yield* SqlTimeTravelStore.migrate
            return yield* sql<{ readonly name: string }>`PRAGMA table_info(flows_time_travel_snapshots)`
          })
        )

        expect(columns.map((column) => column.name)).toContain("plan_digest")
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))

  it.effect("applies the full ladder repeatedly across persistent database lifetimes", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-migrations-")))
      const filename = join(directory, "migrations.sqlite")
      try {
        yield* withDatabase(filename, Migrations.run.pipe(Effect.andThen(Migrations.run)))
        const rows = yield* withDatabase(
          filename,
          Migrations.run.pipe(
            Effect.andThen(Effect.service(SqlClient.SqlClient)),
            Effect.flatMap((sql) =>
              sql<{ readonly migration_id: number }>`
              SELECT migration_id FROM flows_migrations
              WHERE migration_id = 5001
            `
            )
          )
        )

        expect(rows).toEqual([{ migration_id: 5001 }])
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))

  it.effect("surfaces a non-duplicate ALTER TABLE failure", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-alter-")))
      const filename = join(directory, "alter.sqlite")
      try {
        const exit = yield* withDatabase(
          filename,
          Effect.gen(function*() {
            yield* EngineMigrations.run
            const sql = yield* Effect.service(SqlClient.SqlClient)
            yield* sql`CREATE VIEW flows_time_travel_snapshots AS SELECT 1 AS run_id`
            return yield* Effect.exit(SqlTimeTravelStore.migrate)
          })
        )

        expect(Exit.isFailure(exit)).toBe(true)
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))
})
