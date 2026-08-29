import type { StorageApi } from "@tanstack/db"

/** The single SQLite table backing the transactional envelope host. */
export const KEY_VALUE_TABLE_NAME = "smithers_kv"

/** Structural seam for wa-sqlite and an injected test database. */
export interface SqliteKeyValueDatabase {
  readonly execute: <TRow = unknown>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<ReadonlyArray<TRow>>
  readonly close?: () => Promise<void> | void
}

export interface SqliteKeyValueStorage {
  readonly storage: StorageApi
  /** Wait until every write accepted by the synchronous facade is durable. */
  readonly flush: () => Promise<void>
  /** Flush, then release the OPFS database and worker handles. */
  readonly close: () => Promise<void>
}

const UPSERT_SQL =
  `INSERT INTO ${KEY_VALUE_TABLE_NAME} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
const DELETE_SQL = `DELETE FROM ${KEY_VALUE_TABLE_NAME} WHERE key = ?`

/**
 * Expose an already-open wa-sqlite database as TanStack's synchronous
 * StorageApi. Reads use a mirror loaded at acquisition; writes are serialized
 * in call order and `flush` is the durability boundary. A single envelope
 * UPSERT is therefore one SQLite transaction and one atomic commit point.
 */
export const openSqliteKeyValueStorage = async (
  database: SqliteKeyValueDatabase
): Promise<SqliteKeyValueStorage> => {
  await database.execute(
    `CREATE TABLE IF NOT EXISTS ${KEY_VALUE_TABLE_NAME} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  )
  const rows = await database.execute<{ readonly key?: unknown; readonly value?: unknown }>(
    `SELECT key, value FROM ${KEY_VALUE_TABLE_NAME}`
  )
  const mirror = new Map<string, string>()
  for (const row of rows) {
    if (typeof row.key === "string" && typeof row.value === "string") {
      mirror.set(row.key, row.value)
    }
  }

  /*
   * Ordered migration step 0 for the former OPFS adapter. Its collection
   * tables are copied into the pre-envelope StorageApi shape, then
   * TransactionalStorage performs the schema-decoded 0→1 adoption. The old
   * tables are intentionally retained as a byte-for-byte fallback.
   */
  if (!mirror.has("smithers-mvp.store")) {
    const registryTable = await database.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collection_registry'"
    )
    if (registryTable.length > 0) {
      const collections = await database.execute<{
        readonly collection_id?: unknown
        readonly table_name?: unknown
      }>("SELECT collection_id, table_name FROM collection_registry")
      for (const collection of collections) {
        if (
          typeof collection.collection_id !== "string" ||
          typeof collection.table_name !== "string" ||
          !/^[A-Za-z0-9_]+$/.test(collection.table_name)
        ) continue
        const legacyKey = `smithers-mvp.${collection.collection_id}`
        if (mirror.has(legacyKey)) continue
        const legacyRows = await database.execute<{
          readonly key?: unknown
          readonly value?: unknown
          readonly row_version?: unknown
        }>(`SELECT key, value, row_version FROM "${collection.table_name}"`)
        const legacyEntries: Record<string, unknown> = {}
        for (const row of legacyRows) {
          if (typeof row.key !== "string" || typeof row.value !== "string") continue
          let data: unknown
          try {
            data = JSON.parse(row.value)
          } catch {
            data = undefined
          }
          legacyEntries[row.key] = {
            versionKey: `sqlite-${String(row.row_version ?? 0)}`,
            ...(data === undefined ? { rawValue: row.value } : { data })
          }
        }
        const value = JSON.stringify(legacyEntries)
        await database.execute(UPSERT_SQL, [legacyKey, value])
        mirror.set(legacyKey, value)
      }
    }
  }

  let tail: Promise<void> = Promise.resolve()
  let failure: unknown
  let closed = false

  const enqueue = (sql: string, params: ReadonlyArray<unknown>): void => {
    if (closed) throw new Error("SQLite key/value storage is closed")
    if (failure !== undefined) throw failure
    tail = tail.then(async () => {
      if (failure !== undefined) return
      try {
        await database.execute(sql, params)
      } catch (error) {
        failure = error
      }
    })
  }

  const storage: StorageApi = {
    getItem: (key) => mirror.get(key) ?? null,
    setItem: (key, value) => {
      enqueue(UPSERT_SQL, [key, value])
      mirror.set(key, value)
    },
    removeItem: (key) => {
      enqueue(DELETE_SQL, [key])
      mirror.delete(key)
    }
  }

  const flush = async (): Promise<void> => {
    await tail
    if (failure !== undefined) throw failure
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    try {
      await flush()
    } finally {
      await database.close?.()
    }
  }

  return { storage, flush, close }
}
