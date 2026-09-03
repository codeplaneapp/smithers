import { readFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const migration = (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url).href), "utf8")

const insert = `INSERT INTO smithers_build_cache_entry (
  key_digest,
  entry_json,
  result_json,
  created_at_ms,
  recorded_run_id,
  recorded_event_seq
) VALUES (?, ?, ?, ?, ?, ?)`

describe("hosted cache migrations", () => {
  let database: DatabaseSync

  beforeEach(async () => {
    database = new DatabaseSync(":memory:")
    database.exec(await migration("0001_initial.sql"))
    database.exec(await migration("0002_bound_cache_rows.sql"))
  })

  afterEach(() => {
    database.close()
  })

  it("accepts a row inside every protocol bound", () => {
    expect(() => database.prepare(insert).run("key", "{}", "{}", 0, "run", 0)).not.toThrow()
  })

  it("rejects oversized keys and documents at the storage boundary", () => {
    expect(() => database.prepare(insert).run("é".repeat(257), "{}", "{}", 0, "run", 0)).toThrow(
      "cache entry violates protocol bounds"
    )
    expect(() => database.prepare(insert).run("key", `"${"x".repeat(1024 * 1024)}"`, "{}", 0, "run", 0)).toThrow(
      "cache entry violates protocol bounds"
    )
  })

  it("requires provenance columns to be paired and bounded", () => {
    expect(() => database.prepare(insert).run("key", "{}", "{}", 0, "run", null)).toThrow(
      "cache entry violates protocol bounds"
    )
    expect(() => database.prepare(insert).run("key", "{}", "{}", 0, "é".repeat(257), 0)).toThrow(
      "cache entry violates protocol bounds"
    )
  })

  it("applies the same constraints to direct updates", () => {
    database.prepare(insert).run("key", "{}", "{}", 0, "run", 0)
    expect(() =>
      database
        .prepare("UPDATE smithers_build_cache_entry SET recorded_run_id = NULL WHERE key_digest = 'key'")
        .run()
    ).toThrow("cache entry violates protocol bounds")
  })
})
