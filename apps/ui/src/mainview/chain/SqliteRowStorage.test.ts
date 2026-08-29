import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { z } from "zod"
import {
  FutureSqliteSchemaError,
  METADATA_TABLE_NAME,
  openSqliteRowStorage,
  QUARANTINE_TABLE_NAME,
  ROW_TABLE_NAME,
  type SqliteRowDatabase
} from "./SqliteRowStorage"

const WidgetSchema = z.object({ id: z.string(), label: z.string() })
const NoteSchema = z.object({ id: z.string(), body: z.string() })
const collections = [
  { id: "widgets", schema: WidgetSchema },
  { id: "notes", schema: NoteSchema }
]

const database = (): { readonly sqlite: Database; readonly host: SqliteRowDatabase } => {
  const sqlite = new Database(":memory:")
  const host: SqliteRowDatabase = {
    execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []) => {
      const statement = sqlite.query(sql)
      if (/^\s*(?:SELECT|PRAGMA)/i.test(sql)) {
        return statement.all(...params as []) as ReadonlyArray<TRow>
      }
      statement.run(...params as [])
      return []
    },
    close: () => sqlite.close()
  }
  return { sqlite, host }
}

const wire = (rows: Record<string, { readonly versionKey: string; readonly data: unknown }>): string =>
  JSON.stringify(rows)

describe("normalized SQLite row storage", () => {
  test("persists entities as rows and commits a multi-collection batch atomically", async () => {
    const db = database()
    const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    storage.beginBatch()
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v1", data: { id: "a", label: "A" } },
      "s:b": { versionKey: "v1", data: { id: "b", label: "B" } }
    }))
    storage.storage.setItem("smithers-mvp.notes", wire({
      "s:n": { versionKey: "v1", data: { id: "n", body: "note" } }
    }))
    storage.commitBatch()
    await storage.flush()

    const rows = db.sqlite.query(
      `SELECT collection_id, row_key, value FROM ${ROW_TABLE_NAME} ORDER BY collection_id, row_key`
    ).all() as Array<{ collection_id: string; row_key: string; value: string }>
    expect(rows.map((row) => [row.collection_id, row.row_key])).toEqual([
      ["notes", "s:n"],
      ["widgets", "s:a"],
      ["widgets", "s:b"]
    ])
    expect(JSON.parse(rows[1]!.value)).toEqual({ id: "a", label: "A" })

    storage.beginBatch()
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v2", data: { id: "a", label: "updated" } }
    }))
    storage.storage.removeItem("smithers-mvp.notes")
    storage.commitBatch()
    await storage.flush()
    expect(db.sqlite.query(`SELECT collection_id, row_key FROM ${ROW_TABLE_NAME}`).all()).toEqual([
      { collection_id: "widgets", row_key: "s:a" }
    ])
    await storage.close()
  })

  test("a failed statement rolls every collection in the batch back", async () => {
    const db = database()
    const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v1", data: { id: "a", label: "before" } }
    }))
    await storage.flush()
    db.sqlite.run(
      `CREATE TRIGGER refuse_note BEFORE INSERT ON ${ROW_TABLE_NAME}
       WHEN NEW.collection_id = 'notes' BEGIN SELECT RAISE(ABORT, 'refused'); END`
    )
    storage.beginBatch()
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v2", data: { id: "a", label: "after" } }
    }))
    storage.storage.setItem("smithers-mvp.notes", wire({
      "s:n": { versionKey: "v1", data: { id: "n", body: "boom" } }
    }))
    storage.commitBatch()
    await expect(storage.flush()).rejects.toThrow("refused")
    const rows = db.sqlite.query(`SELECT collection_id, value FROM ${ROW_TABLE_NAME}`).all() as Array<{
      collection_id: string
      value: string
    }>
    expect(rows).toEqual([{ collection_id: "widgets", value: JSON.stringify({ id: "a", label: "before" }) }])
    db.sqlite.close()
  })

  test("imports the legacy envelope once and retains its source bytes", async () => {
    const db = database()
    db.sqlite.run("CREATE TABLE smithers_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    const envelope = JSON.stringify({
      version: 1,
      entries: {
        "smithers-mvp.widgets": wire({
          "s:legacy": { versionKey: "old", data: { id: "legacy", label: "kept" } }
        })
      }
    })
    db.sqlite.query("INSERT INTO smithers_kv (key, value) VALUES (?, ?)").run("smithers-mvp.store", envelope)
    const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(JSON.parse(storage.storage.getItem("smithers-mvp.widgets") ?? "{}")).toEqual({
      "s:legacy": { versionKey: "old", data: { id: "legacy", label: "kept" } }
    })
    expect((db.sqlite.query("SELECT value FROM smithers_kv WHERE key = ?").get("smithers-mvp.store") as { value: string }).value).toBe(envelope)
    expect(db.sqlite.query(`SELECT count(*) AS count FROM ${ROW_TABLE_NAME}`).get()).toEqual({ count: 1 })
    await storage.close()
  })

  test("quarantines invalid older rows and refuses newer schemas without mutation", async () => {
    const old = database()
    old.sqlite.run(`CREATE TABLE ${ROW_TABLE_NAME} (collection_id TEXT NOT NULL, row_key TEXT NOT NULL, version_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection_id, row_key))`)
    old.sqlite.run(`CREATE TABLE ${METADATA_TABLE_NAME} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    old.sqlite.query(`INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?), (?, ?)`).run(
      "legacy-import-complete", "1", "schema-version", "8"
    )
    old.sqlite.query(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`).run(
      "widgets", "s:bad", "v1", JSON.stringify({ id: "bad", label: 42 })
    )
    const migrated = await openSqliteRowStorage(old.host, { collections, schemaVersion: 9 })
    expect(old.sqlite.query(`SELECT count(*) AS count FROM ${ROW_TABLE_NAME}`).get()).toEqual({ count: 0 })
    expect(old.sqlite.query(`SELECT reason FROM ${QUARANTINE_TABLE_NAME}`).get()).toEqual({ reason: "schema-validation" })
    await migrated.close()

    const future = database()
    future.sqlite.run(`CREATE TABLE ${METADATA_TABLE_NAME} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    future.sqlite.query(`INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?), (?, ?)`).run(
      "legacy-import-complete", "1", "schema-version", "99"
    )
    await expect(openSqliteRowStorage(future.host, { collections, schemaVersion: 9 }))
      .rejects.toBeInstanceOf(FutureSqliteSchemaError)
    expect(future.sqlite.query(`SELECT value FROM ${METADATA_TABLE_NAME} WHERE key = 'schema-version'`).get())
      .toEqual({ value: "99" })
    future.sqlite.close()
  })
})
