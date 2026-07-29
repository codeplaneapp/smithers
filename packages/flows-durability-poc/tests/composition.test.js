import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database as BunSqliteDatabase } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Database } from "@flows/database"
import { Migrations } from "@flows/journal"
import { createFlowsBoundary } from "../src/index.js"

const openSmithersSqlite = (path) => {
  const sqlite = new BunSqliteDatabase(path)
  sqlite.run("PRAGMA journal_mode = WAL")
  sqlite.run("PRAGMA busy_timeout = 30000")
  sqlite.run("PRAGMA synchronous = NORMAL")
  sqlite.run("PRAGMA foreign_keys = ON")
  return sqlite
}

const tableNames = (sqlite) =>
  (sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).map((r) => r.name)

let dir
let sqlite
let boundary

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "flows-poc-compose-"))
  sqlite = openSmithersSqlite(join(dir, "smithers.db"))
  boundary = await createFlowsBoundary({ sqlite })
})

afterEach(async () => {
  await boundary.dispose()
  sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("step 1: composition", () => {
  test("flows migrations apply alongside smithers tables in the same database file", async () => {
    sqlite.run(`CREATE TABLE IF NOT EXISTS _smithers_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`)
    const names = tableNames(sqlite)
    expect(names).toContain("_smithers_runs")
    expect(names).toContain("flows_journal_events")
    expect(names).toContain("flows_runs")
    expect(names).toContain("flows_attempts")
    expect(names).toContain("flows_step_cache")
    expect(names).toContain("flows_migrations")
  })

  test("flows migration is idempotent against an already-migrated shared file", async () => {
    await boundary.run(Migrations.run)
    const count = sqlite.query("SELECT COUNT(*) AS n FROM flows_migrations").get()
    expect(count.n).toBe(1)
  })

  test("one smithers-side transaction spans flows_* and smithers_* tables (commit)", async () => {
    sqlite.run(`CREATE TABLE IF NOT EXISTS _smithers_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`)
    sqlite.exec("BEGIN IMMEDIATE")
    try {
      sqlite.run("INSERT INTO _smithers_runs (run_id, status, created_at_ms) VALUES (?, ?, ?)", [
        "run-shared-commit",
        "running",
        1
      ])
      await boundary.run(
        Effect.gen(function*() {
          const db = yield* Database.Database
          yield* db.write(
            db.sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('run-shared-commit', 'pending', 1, '{}')`
          )
        })
      )
      sqlite.exec("COMMIT")
    } catch (cause) {
      sqlite.exec("ROLLBACK")
      throw cause
    }
    expect(sqlite.query("SELECT COUNT(*) AS n FROM _smithers_runs").get().n).toBe(1)
    expect(sqlite.query("SELECT COUNT(*) AS n FROM flows_runs").get().n).toBe(1)
  })

  test("one smithers-side transaction spans flows_* and smithers_* tables (rollback discards both)", async () => {
    sqlite.run(`CREATE TABLE IF NOT EXISTS _smithers_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`)
    sqlite.exec("BEGIN IMMEDIATE")
    try {
      sqlite.run("INSERT INTO _smithers_runs (run_id, status, created_at_ms) VALUES (?, ?, ?)", [
        "run-shared-rollback",
        "running",
        1
      ])
      await boundary.run(
        Effect.gen(function*() {
          const db = yield* Database.Database
          yield* db.write(
            db.sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('run-shared-rollback', 'running', 1, '{}')`
          )
        })
      )
      throw new Error("simulated smithers-side failure after flows write")
    } catch {
      sqlite.exec("ROLLBACK")
    }
    expect(sqlite.query("SELECT COUNT(*) AS n FROM _smithers_runs").get().n).toBe(0)
    expect(sqlite.query("SELECT COUNT(*) AS n FROM flows_runs").get().n).toBe(0)
  })

  test("a flows-side failure inside a smithers transaction triggers rollback of the smithers write too", async () => {
    sqlite.run(`CREATE TABLE IF NOT EXISTS _smithers_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`)
    sqlite.exec("BEGIN IMMEDIATE")
    let flowsError
    try {
      sqlite.run("INSERT INTO _smithers_runs (run_id, status, created_at_ms) VALUES (?, ?, ?)", [
        "run-flows-fails",
        "running",
        1
      ])
      await boundary.run(
        Effect.gen(function*() {
          const db = yield* Database.Database
          yield* db.write(
            db.sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('run-flows-fails', 'bogus-status', 1, '{}')`
          )
        })
      )
      sqlite.exec("COMMIT")
    } catch (cause) {
      flowsError = cause
      sqlite.exec("ROLLBACK")
    }
    expect(flowsError).toBeDefined()
    expect(sqlite.query("SELECT COUNT(*) AS n FROM _smithers_runs").get().n).toBe(0)
    expect(sqlite.query("SELECT COUNT(*) AS n FROM flows_runs").get().n).toBe(0)
  })

  test("outside an ambient transaction, flows db.write opens and commits its own transaction", async () => {
    await boundary.run(
      Effect.gen(function*() {
        const db = yield* Database.Database
        yield* db.write(
          db.sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('run-standalone', 'pending', 2, '{}')`
        )
      })
    )
    const row = sqlite.query("SELECT status FROM flows_runs WHERE run_id = 'run-standalone'").get()
    expect(row.status).toBe("pending")
  })
})
