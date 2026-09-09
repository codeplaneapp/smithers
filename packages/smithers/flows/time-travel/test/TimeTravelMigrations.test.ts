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
  for (const door of ["ladder", "store"] as const) {
    it.effect(`adds run-scoped journal indexes to an existing database through the ${door}`, () =>
      Effect.gen(function*() {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-indexes-")))
        try {
          const indexes = yield* withDatabase(
            join(directory, "indexes.sqlite"),
            Effect.gen(function*() {
              yield* EngineMigrations.run
              yield* SqlTimeTravelStore.migrate
              const sql = yield* SqlClient.SqlClient
              // Simulate the schema before the lineage-probe indexes existed.
              yield* sql`DROP INDEX IF EXISTS flows_journal_events_child_spawn_idx`
              yield* sql`DROP INDEX IF EXISTS flows_journal_events_handoff_idx`
              yield* sql`INSERT INTO flows_migrations (migration_id, created_at, name)
              VALUES (5001, datetime('now'), 'time-travel_initial'),
                     (5002, datetime('now'), 'time-travel_archive_generation')`
              if (door === "ladder") yield* Migrations.run
              else yield* SqlTimeTravelStore.make
              return yield* sql<{ readonly name: string; readonly sql: string }>`
              SELECT name, sql FROM sqlite_master WHERE type = 'index'
              AND name IN ('flows_journal_events_child_spawn_idx', 'flows_journal_events_handoff_idx')
              ORDER BY name`
            })
          )
          expect(indexes.map((index) => index.name)).toEqual([
            "flows_journal_events_child_spawn_idx",
            "flows_journal_events_handoff_idx"
          ])
          for (const index of indexes) {
            expect(index.sql).toContain("(run_id, seq)")
            expect(index.sql).toContain("WHERE event_type =")
            expect(index.sql).toContain("json_extract(payload_json,")
          }
        } finally {
          yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
        }
      }))
  }

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

  it.effect("rekeys a legacy archive that predates the journal generation", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-archive-")))
      const filename = join(directory, "archive.sqlite")
      try {
        const { columns, rows, generations } = yield* withDatabase(
          filename,
          Effect.gen(function*() {
            yield* EngineMigrations.run
            const sql = yield* Effect.service(SqlClient.SqlClient)
            yield* sql`
            CREATE TABLE flows_time_travel_archive (
              run_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              event_id TEXT NOT NULL,
              source_id TEXT NOT NULL,
              source_seq INTEGER NOT NULL,
              emitted_at_ms INTEGER NOT NULL,
              event_type TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              meta_json TEXT NOT NULL,
              archived_at_ms INTEGER NOT NULL,
              PRIMARY KEY (run_id, seq)
            )
          `
            yield* sql`
            INSERT INTO flows_time_travel_archive
            VALUES ('legacy', 1, 'legacy-1', 'source', 1, 0, 'type', '{}', '{}', 0)
          `
            yield* sql`INSERT INTO flows_migrations (migration_id, created_at, name)
              VALUES (5001, datetime('now'), 'time-travel_initial')`
            yield* Migrations.run
            // A rerun must find the rebuilt table and leave it alone.
            yield* SqlTimeTravelStore.migrate
            return {
              generations: yield* sql`SELECT run_id, generation FROM flows_journal_generations`,
              columns: yield* sql<{ readonly name: string }>`PRAGMA table_info(flows_time_travel_archive)`,
              rows: yield* sql<{ readonly generation: number; readonly event_id: string }>`
              SELECT generation, event_id FROM flows_time_travel_archive
            `
            }
          })
        )

        expect(columns.map((column) => column.name)).toContain("generation")
        expect(rows).toEqual([{ generation: 0, event_id: "legacy-1" }])
        expect(generations).toEqual([{ run_id: "legacy", generation: 1 }])
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
