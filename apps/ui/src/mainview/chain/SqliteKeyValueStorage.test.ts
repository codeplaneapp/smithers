import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { openSqliteKeyValueStorage, type SqliteKeyValueDatabase } from "./SqliteKeyValueStorage"
import {
  ENVELOPE_QUARANTINE_PREFIX,
  ENVELOPE_STORAGE_KEY,
  ENVELOPE_VERSION,
  openTransactionalStorage,
  STAGED_ENVELOPE_STORAGE_KEY
} from "./TransactionalStorage"

const fakeDatabase = (
  legacy?: {
    readonly collectionId: string
    readonly tableName: string
    readonly rows: ReadonlyArray<{ readonly key: string; readonly value: string; readonly row_version: number }>
  }
) => {
  const rows = new Map<string, string>()
  const statements: string[] = []
  let closes = 0
  const database: SqliteKeyValueDatabase = {
    execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []) => {
      statements.push(sql)
      if (sql.includes("sqlite_master")) {
        return (legacy === undefined ? [] : [{ name: "collection_registry" }]) as unknown as ReadonlyArray<TRow>
      }
      if (sql === "SELECT collection_id, table_name FROM collection_registry") {
        return (legacy === undefined
          ? []
          : [{ collection_id: legacy.collectionId, table_name: legacy.tableName }]) as unknown as ReadonlyArray<TRow>
      }
      if (sql.startsWith("SELECT key, value, row_version")) {
        return (legacy?.rows ?? []) as unknown as ReadonlyArray<TRow>
      }
      if (sql.startsWith("SELECT key, value")) {
        return [...rows].map(([key, value]) => ({ key, value })) as unknown as ReadonlyArray<TRow>
      }
      if (sql.startsWith("INSERT INTO")) {
        rows.set(String(params[0]), String(params[1]))
      }
      if (sql.startsWith("DELETE FROM")) rows.delete(String(params[0]))
      return []
    },
    close: async () => {
      closes += 1
    }
  }
  return { database, rows, statements, closes: () => closes }
}

const WidgetSchema = z.object({ id: z.string(), label: z.string() })
const collections = [{ id: "widgets", schema: WidgetSchema }]

describe("the OPFS SQLite StorageApi host", () => {
  test("the adapter durably orders writes and releases its database scope", async () => {
    const fake = fakeDatabase()
    const first = await openSqliteKeyValueStorage(fake.database)
    first.storage.setItem("one", "1")
    first.storage.setItem("two", "2")
    first.storage.removeItem("one")
    await first.flush()
    expect(fake.rows).toEqual(new Map([["two", "2"]]))
    await first.close()
    expect(fake.closes()).toBe(1)

    const reopened = await openSqliteKeyValueStorage(fake.database)
    expect(reopened.storage.getItem("one")).toBe(null)
    expect(reopened.storage.getItem("two")).toBe("2")
    expect(fake.statements.filter((sql) => sql.startsWith("INSERT INTO")).length).toBe(2)
  })

  test("the OPFS envelope recovers both rollback and completion directions", async () => {
    const fake = fakeDatabase()
    const first = await openSqliteKeyValueStorage(fake.database)
    const store = await openTransactionalStorage(first.storage, { collections })
    store.storage.setItem("keep", "before")
    await first.flush()

    const rollbackBytes = JSON.stringify({
      version: ENVELOPE_VERSION,
      entries: { keep: "not-committed" }
    })
    first.storage.setItem(STAGED_ENVELOPE_STORAGE_KEY, rollbackBytes)
    await first.flush()
    const rollbackHost = await openSqliteKeyValueStorage(fake.database)
    const rolledBack = await openTransactionalStorage(rollbackHost.storage, { collections })
    expect(rolledBack.recovery).toBe("rollback")
    expect(rolledBack.storage.getItem("keep")).toBe("before")
    await rollbackHost.flush()

    const completeBytes = JSON.stringify({
      version: ENVELOPE_VERSION,
      entries: { keep: "committed" }
    })
    rollbackHost.storage.setItem(STAGED_ENVELOPE_STORAGE_KEY, completeBytes)
    rollbackHost.storage.setItem(ENVELOPE_STORAGE_KEY, completeBytes)
    await rollbackHost.flush()
    const completeHost = await openSqliteKeyValueStorage(fake.database)
    const completed = await openTransactionalStorage(completeHost.storage, { collections })
    expect(completed.recovery).toBe("complete")
    expect(completed.storage.getItem("keep")).toBe("committed")
    expect(completed.storage.getItem(STAGED_ENVELOPE_STORAGE_KEY)).toBe(null)
  })

  test("future-version OPFS bytes survive quarantine unchanged", async () => {
    const fake = fakeDatabase()
    const host = await openSqliteKeyValueStorage(fake.database)
    const future = JSON.stringify({
      version: ENVELOPE_VERSION + 7,
      entries: { future: "opaque bytes" }
    })
    host.storage.setItem(ENVELOPE_STORAGE_KEY, future)
    await host.flush()
    const store = await openTransactionalStorage(host.storage, { collections })
    await host.flush()
    expect(store.quarantinedKeys).toEqual([
      `${ENVELOPE_QUARANTINE_PREFIX}future.${ENVELOPE_VERSION + 7}`
    ])
    expect(
      host.storage.getItem(`${ENVELOPE_QUARANTINE_PREFIX}future.${ENVELOPE_VERSION + 7}`)
    ).toBe(future)
  })

  test("legacy OPFS rows cross the ordered schema-decoded migration", async () => {
    const fake = fakeDatabase({
      collectionId: "widgets",
      tableName: "legacy_widgets",
      rows: [
        { key: "s:good", value: JSON.stringify({ id: "good", label: "adopted" }), row_version: 2 },
        { key: "s:bad", value: JSON.stringify({ id: "bad", label: 42 }), row_version: 3 }
      ]
    })
    const host = await openSqliteKeyValueStorage(fake.database)
    const store = await openTransactionalStorage(host.storage, { collections })
    await host.flush()
    const migrated = JSON.parse(store.storage.getItem("smithers-mvp.widgets") ?? "{}") as Record<
      string,
      unknown
    >
    expect(Object.keys(migrated)).toEqual(["s:good"])
    expect(store.quarantinedKeys).toContain("smithers-mvp-quarantine.row.widgets.s:bad")
    // The former adapter's table is copied, never dropped or cleared.
    expect(fake.statements.some((sql) => /DROP|DELETE FROM "legacy_widgets"/.test(sql))).toBe(false)
  })
})
