import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as PlanMigrations from "@smthrs/plan/Migrations"
import * as RunStoreMigrations from "@smthrs/run-store/Migrations"
import * as StepCacheMigrations from "@smthrs/step-cache/Migrations"
import * as TimeTravelMigrations from "@smthrs/time-travel/Migrations"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"

const tableNames = [
  "control_credentials",
  "control_grants",
  "control_mutations",
  "control_plan_keys",
  "control_plans",
  "control_run_messages",
  "control_run_resumes",
  "control_runs",
  "control_sequences",
  "control_tokens"
] as const

const siblingOffsets = [
  JournalMigrations.set.idOffset,
  RunStoreMigrations.set.idOffset,
  StepCacheMigrations.set.idOffset,
  EngineMigrations.set.idOffset,
  PlanMigrations.set.idOffset,
  TimeTravelMigrations.set.idOffset
]

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(TestDatabase.layer))

describe("control migrations", () => {
  it("reserves the next migration block without colliding with a sibling", () => {
    expect(Migrations.set.idOffset % DatabaseMigrations.idBlock).toBe(0)
    expect(Migrations.set.idOffset).toBe(Math.max(...siblingOffsets) + DatabaseMigrations.idBlock)
    expect(siblingOffsets).not.toContain(Migrations.set.idOffset)

    for (const key of Object.keys(Migrations.set.migrations)) {
      const localId = Number.parseInt(key, 10)
      expect(localId).toBeGreaterThanOrEqual(0)
      expect(localId).toBeLessThan(DatabaseMigrations.idBlock)
    }
  })

  it.effect("creates every control table and reruns idempotently", () =>
    withDatabase(Effect.gen(function*() {
      yield* Migrations.run
      yield* Migrations.run
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'control_%'
        ORDER BY name
      `

      expect(rows.map((row) => row.name)).toEqual(tableNames)
    })))

  it.effect("records the migration after the standalone runtime bootstrap", () =>
    withDatabase(Effect.gen(function*() {
      yield* SqlControlRuntime.migrate
      const completed = yield* Migrations.run
      expect(completed).toHaveLength(1)
      expect(completed[0]?.[0]).toBe(Migrations.set.idOffset + 1)
    })))
})
