/** Node SQLite driver. Domain stores depend on Effect SqlClient, not this module.
 * @since 1.0.0
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Effect, Layer } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import * as SqliteOpen from "../internal/SqliteOpen.ts"

export { isUnsupportedDatabase, UnsupportedDatabase, UnsupportedDatabaseCode } from "../internal/SqliteOpen.ts"

/** Connection settings; write policy is supplied separately by DurableWriter.
 * @since 1.0.0
 * @category models
 */
export interface NodeDatabaseOptions {
  readonly filename: string
  readonly sqlite?: Omit<SqliteClient.SqliteClientConfig, "filename"> | undefined
}

const readTableNames = (filename: string): ReadonlyArray<string> | undefined => {
  let db: DatabaseSync | undefined
  try {
    if (!filename.startsWith("file:") && !statSync(filename).isFile()) return undefined
    db = new DatabaseSync(filename, { readOnly: true })
    return db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => String((row as { readonly name: unknown }).name))
  } catch (error) {
    if (String(error).includes("database is locked") || String(error).includes("database is busy")) throw error
    return undefined
  } finally {
    db?.close()
  }
}

/** Provides the Node SQLite client with the shared schema guard and open retries.
 * @since 1.0.0
 * @category layers
 */
export const layer = (options: NodeDatabaseOptions): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(Effect.sync(() => {
    if (process.versions.bun !== undefined) {
      throw new SqliteOpen.UnsupportedDatabase({
        code: "unsupported_runtime",
        message: "Use @smthrs/database/bun/BunDatabase under Bun; NodeDatabase requires Node.js >=22.19.0"
      })
    }
    return SqliteOpen.layer(
      options.filename,
      readTableNames,
      SqliteClient.layer({ ...options.sqlite, filename: options.filename }),
      options.sqlite?.spanAttributes
    )
  }))
