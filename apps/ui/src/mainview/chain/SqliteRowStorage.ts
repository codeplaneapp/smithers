import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { StorageApi } from "@tanstack/db"
import { PERSISTED_KEY_PREFIX, SCHEMA_VERSION_STORAGE_KEY } from "./SchemaVersion"
import {
  openTransactionalStorage,
  type LegacyCollectionSpec
} from "./TransactionalStorage"

export const ROW_TABLE_NAME = "smithers_collection_rows"
export const METADATA_TABLE_NAME = "smithers_metadata"
export const QUARANTINE_TABLE_NAME = "smithers_row_quarantine"

export interface SqliteRowDatabase {
  readonly execute: <TRow = unknown>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<ReadonlyArray<TRow>>
  readonly close?: () => Promise<void> | void
}

export interface SqliteRowStorage {
  /** StorageApi compatibility for TanStack's collection sync adapter. */
  readonly storage: StorageApi
  readonly beginBatch: () => void
  readonly commitBatch: () => void
  readonly abortBatch: () => void
  readonly flush: () => Promise<void>
  readonly close: () => Promise<void>
}

export interface SqliteRowStorageOptions {
  readonly collections: ReadonlyArray<LegacyCollectionSpec>
  readonly schemaVersion: number
}

export class FutureSqliteSchemaError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`SQLite state schema ${found} is newer than this build's schema ${supported}.`)
  }
}

interface StoredItem {
  readonly versionKey: string
  readonly data: unknown
}

const SCHEMA_VERSION_KEY = "schema-version"
const LEGACY_IMPORT_KEY = "legacy-import-complete"

const collectionStorageKey = (id: string): string => `${PERSISTED_KEY_PREFIX}${id}`

const parseStoredCollection = (raw: string | null): Map<string, StoredItem> => {
  if (raw === null || raw === "") return new Map()
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Persisted collection must be an object.")
  }
  const rows = new Map<string, StoredItem>()
  for (const [key, value] of Object.entries(parsed)) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("versionKey" in value) ||
      typeof value.versionKey !== "string" ||
      !("data" in value)
    ) {
      throw new Error(`Persisted row ${key} has an invalid envelope.`)
    }
    rows.set(key, { versionKey: value.versionKey, data: value.data })
  }
  return rows
}

const serializeStoredCollection = (rows: ReadonlyMap<string, StoredItem>): string =>
  JSON.stringify(Object.fromEntries(rows))

const validates = async (schema: StandardSchemaV1, value: unknown): Promise<boolean> => {
  const result = schema["~standard"].validate(value)
  const settled = result instanceof Promise ? await result : result
  return settled.issues === undefined || settled.issues.length === 0
}

const tableExists = async (database: SqliteRowDatabase, name: string): Promise<boolean> =>
  (await database.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name]
  )).length > 0

const memoryStorage = (entries: ReadonlyMap<string, string>): StorageApi => {
  const values = new Map(entries)
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key)
  }
}

/**
 * Reads either legacy `smithers_kv` envelopes or the first TanStack SQLite
 * adapter's registry tables into the old StorageApi shape. Source tables are
 * retained byte-for-byte; this importer only copies validated rows forward.
 */
const readLegacyStorage = async (
  database: SqliteRowDatabase,
  collections: ReadonlyArray<LegacyCollectionSpec>
): Promise<StorageApi | undefined> => {
  const legacy = new Map<string, string>()
  if (await tableExists(database, "smithers_kv")) {
    const rows = await database.execute<{ readonly key?: unknown; readonly value?: unknown }>(
      "SELECT key, value FROM smithers_kv"
    )
    for (const row of rows) {
      if (typeof row.key === "string" && typeof row.value === "string") legacy.set(row.key, row.value)
    }
  }

  if (await tableExists(database, "collection_registry")) {
    const allowed = new Set(collections.map((collection) => collection.id))
    const registry = await database.execute<{
      readonly collection_id?: unknown
      readonly table_name?: unknown
    }>("SELECT collection_id, table_name FROM collection_registry")
    for (const entry of registry) {
      if (
        typeof entry.collection_id !== "string" ||
        !allowed.has(entry.collection_id) ||
        typeof entry.table_name !== "string" ||
        !/^[A-Za-z0-9_]+$/.test(entry.table_name)
      ) continue
      const storageKey = collectionStorageKey(entry.collection_id)
      if (legacy.has(storageKey)) continue
      const rows = await database.execute<{
        readonly key?: unknown
        readonly value?: unknown
        readonly row_version?: unknown
      }>(`SELECT key, value, row_version FROM "${entry.table_name}"`)
      const stored = new Map<string, StoredItem>()
      for (const row of rows) {
        if (typeof row.key !== "string" || typeof row.value !== "string") continue
        try {
          stored.set(row.key, {
            versionKey: `sqlite-${String(row.row_version ?? 0)}`,
            data: JSON.parse(row.value)
          })
        } catch {
          // The schema-decoded import below quarantines malformed rows only
          // when they carry data; unreadable JSON remains in the source table.
        }
      }
      legacy.set(storageKey, serializeStoredCollection(stored))
    }
  }
  return legacy.size === 0 ? undefined : memoryStorage(legacy)
}

const insertQuarantine = async (
  database: SqliteRowDatabase,
  collectionId: string,
  rowKey: string,
  raw: string,
  reason: string
): Promise<void> => {
  await database.execute(
    `INSERT INTO ${QUARANTINE_TABLE_NAME} (id, collection_id, row_key, value, reason, quarantined_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [`${collectionId}:${rowKey}`, collectionId, rowKey, raw, reason, Date.now()]
  )
}

/**
 * A normalized SQLite host with one physical row per TanStack entity.
 * `beginBatch`/`commitBatch` turn every logical AppStore transition into one
 * SQLite transaction across all collections; localStorage keeps its WAL
 * envelope fallback, but OPFS no longer serializes the entire app into one
 * value.
 */
export const openSqliteRowStorage = async (
  database: SqliteRowDatabase,
  options: SqliteRowStorageOptions
): Promise<SqliteRowStorage> => {
  await database.execute(
    `CREATE TABLE IF NOT EXISTS ${ROW_TABLE_NAME} (
      collection_id TEXT NOT NULL,
      row_key TEXT NOT NULL,
      version_key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (collection_id, row_key)
    )`
  )
  await database.execute(
    `CREATE TABLE IF NOT EXISTS ${METADATA_TABLE_NAME} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  )
  await database.execute(
    `CREATE TABLE IF NOT EXISTS ${QUARANTINE_TABLE_NAME} (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      row_key TEXT NOT NULL,
      value TEXT NOT NULL,
      reason TEXT NOT NULL,
      quarantined_at INTEGER NOT NULL
    )`
  )

  const specs = new Map(options.collections.map((collection) => [collection.id, collection]))
  const metadataRows = await database.execute<{ readonly key?: unknown; readonly value?: unknown }>(
    `SELECT key, value FROM ${METADATA_TABLE_NAME}`
  )
  const metadata = new Map<string, string>()
  for (const row of metadataRows) {
    if (typeof row.key === "string" && typeof row.value === "string") metadata.set(row.key, row.value)
  }

  if (metadata.get(LEGACY_IMPORT_KEY) !== "1") {
    const host = await readLegacyStorage(database, options.collections)
    if (host !== undefined) {
      const migrated = await openTransactionalStorage(host, { collections: options.collections })
      await database.execute("BEGIN IMMEDIATE")
      try {
        for (const [collectionId, spec] of specs) {
          const raw = migrated.storage.getItem(collectionStorageKey(collectionId))
          for (const [rowKey, row] of parseStoredCollection(raw)) {
            const encoded = JSON.stringify(row.data)
            if (!(await validates(spec.schema, row.data))) {
              await insertQuarantine(database, collectionId, rowKey, encoded, "legacy-schema-validation")
              continue
            }
            await database.execute(
              `INSERT INTO ${ROW_TABLE_NAME} (collection_id, row_key, version_key, value)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(collection_id, row_key) DO NOTHING`,
              [collectionId, rowKey, row.versionKey, encoded]
            )
          }
        }
        await database.execute(
          `INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [LEGACY_IMPORT_KEY, "1"]
        )
        await database.execute("COMMIT")
      } catch (error) {
        await database.execute("ROLLBACK")
        throw error
      }
    } else {
      await database.execute(
        `INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?)`,
        [LEGACY_IMPORT_KEY, "1"]
      )
    }
    metadata.set(LEGACY_IMPORT_KEY, "1")
  }

  const recordedVersion = Number(metadata.get(SCHEMA_VERSION_KEY) ?? options.schemaVersion)
  if (Number.isFinite(recordedVersion) && recordedVersion > options.schemaVersion) {
    throw new FutureSqliteSchemaError(recordedVersion, options.schemaVersion)
  }

  const persistedRows = await database.execute<{
    readonly collection_id?: unknown
    readonly row_key?: unknown
    readonly version_key?: unknown
    readonly value?: unknown
  }>(`SELECT collection_id, row_key, version_key, value FROM ${ROW_TABLE_NAME}`)
  const byCollection = new Map<string, Map<string, StoredItem>>()
  const invalid: Array<{ readonly collectionId: string; readonly rowKey: string; readonly raw: string }> = []
  for (const row of persistedRows) {
    if (
      typeof row.collection_id !== "string" ||
      typeof row.row_key !== "string" ||
      typeof row.version_key !== "string" ||
      typeof row.value !== "string"
    ) continue
    const spec = specs.get(row.collection_id)
    if (spec === undefined) continue
    try {
      const data: unknown = JSON.parse(row.value)
      if (!(await validates(spec.schema, data))) {
        invalid.push({ collectionId: row.collection_id, rowKey: row.row_key, raw: row.value })
        continue
      }
      const rows = byCollection.get(row.collection_id) ?? new Map<string, StoredItem>()
      rows.set(row.row_key, { versionKey: row.version_key, data })
      byCollection.set(row.collection_id, rows)
    } catch {
      invalid.push({ collectionId: row.collection_id, rowKey: row.row_key, raw: row.value })
    }
  }

  await database.execute("BEGIN IMMEDIATE")
  try {
    for (const row of invalid) {
      await insertQuarantine(database, row.collectionId, row.rowKey, row.raw, "schema-validation")
      await database.execute(
        `DELETE FROM ${ROW_TABLE_NAME} WHERE collection_id = ? AND row_key = ?`,
        [row.collectionId, row.rowKey]
      )
    }
    await database.execute(
      `INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [SCHEMA_VERSION_KEY, String(options.schemaVersion)]
    )
    await database.execute("COMMIT")
  } catch (error) {
    await database.execute("ROLLBACK")
    throw error
  }

  let scheduled = new Map<string, string>()
  for (const collection of options.collections) {
    scheduled.set(
      collectionStorageKey(collection.id),
      serializeStoredCollection(byCollection.get(collection.id) ?? new Map())
    )
  }
  // Preserve legacy schema bookkeeping for callers that inspect StorageApi;
  // the physical SQLite schema version remains authoritative.
  scheduled.set(SCHEMA_VERSION_STORAGE_KEY, String(options.schemaVersion))

  let pending: Map<string, string | null> | undefined
  let batchDepth = 0
  let tail: Promise<void> = Promise.resolve()
  let failure: unknown
  let closed = false

  const storageKeyToCollection = new Map(
    options.collections.map((collection) => [collectionStorageKey(collection.id), collection.id])
  )

  const persistChanges = async (
    before: ReadonlyMap<string, string>,
    after: ReadonlyMap<string, string>,
    changedKeys: ReadonlyArray<string>
  ): Promise<void> => {
    await database.execute("BEGIN IMMEDIATE")
    try {
      for (const storageKey of changedKeys) {
        const collectionId = storageKeyToCollection.get(storageKey)
        if (collectionId === undefined) {
          const value = after.get(storageKey)
          if (value === undefined) {
            await database.execute(`DELETE FROM ${METADATA_TABLE_NAME} WHERE key = ?`, [storageKey])
          } else {
            await database.execute(
              `INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
              [storageKey, value]
            )
          }
          continue
        }
        const oldRows = parseStoredCollection(before.get(storageKey) ?? null)
        const nextRows = parseStoredCollection(after.get(storageKey) ?? null)
        for (const rowKey of oldRows.keys()) {
          if (!nextRows.has(rowKey)) {
            await database.execute(
              `DELETE FROM ${ROW_TABLE_NAME} WHERE collection_id = ? AND row_key = ?`,
              [collectionId, rowKey]
            )
          }
        }
        for (const [rowKey, row] of nextRows) {
          const prior = oldRows.get(rowKey)
          if (prior?.versionKey === row.versionKey) continue
          await database.execute(
            `INSERT INTO ${ROW_TABLE_NAME} (collection_id, row_key, version_key, value)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(collection_id, row_key) DO UPDATE SET
               version_key = excluded.version_key,
               value = excluded.value`,
            [collectionId, rowKey, row.versionKey, JSON.stringify(row.data)]
          )
        }
      }
      await database.execute("COMMIT")
    } catch (error) {
      await database.execute("ROLLBACK")
      throw error
    }
  }

  const enqueue = (changes: ReadonlyMap<string, string | null>): void => {
    if (closed) throw new Error("SQLite row storage is closed.")
    if (failure !== undefined) throw failure
    const before = scheduled
    const after = new Map(before)
    for (const [key, value] of changes) {
      if (value === null) after.delete(key)
      else after.set(key, value)
    }
    const changedKeys = [...changes.keys()].filter((key) => before.get(key) !== after.get(key))
    scheduled = after
    if (changedKeys.length === 0) return
    tail = tail.then(() => persistChanges(before, after, changedKeys)).catch((error) => {
      failure = error
    })
  }

  const storage: StorageApi = {
    getItem: (key) => {
      if (pending?.has(key)) return pending.get(key) ?? null
      return scheduled.get(key) ?? null
    },
    setItem: (key, value) => {
      // Parse eagerly so malformed adapter output cannot poison the async queue.
      if (storageKeyToCollection.has(key)) parseStoredCollection(value)
      if (pending !== undefined) pending.set(key, value)
      else enqueue(new Map([[key, value]]))
    },
    removeItem: (key) => {
      if (pending !== undefined) pending.set(key, null)
      else enqueue(new Map([[key, null]]))
    }
  }

  const beginBatch = (): void => {
    if (batchDepth === 0) pending = new Map()
    batchDepth += 1
  }
  const commitBatch = (): void => {
    if (batchDepth === 0) throw new Error("No SQLite persistence batch is open.")
    batchDepth -= 1
    if (batchDepth !== 0) return
    const changes = pending ?? new Map()
    pending = undefined
    enqueue(changes)
  }
  const abortBatch = (): void => {
    batchDepth = 0
    pending = undefined
  }
  const flush = async (): Promise<void> => {
    await tail
    if (failure !== undefined) throw failure
  }
  const close = async (): Promise<void> => {
    if (closed) return
    await flush()
    closed = true
    await database.close?.()
  }

  return { storage, beginBatch, commitBatch, abortBatch, flush, close }
}
