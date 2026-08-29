/**
 * In-process fake of the Cloudflare Durable Object storage API.
 *
 * **Node only.** The fake runs `node:sqlite` behind the same synchronous
 * `exec` surface `ctx.storage.sql` exposes, so `DurableObjectDatabase` and
 * everything composed over it can be exercised by an ordinary vitest run.
 * `test/workerd/` runs the same contract against real workerd; this is what
 * makes the contract runnable everywhere else.
 *
 * The fake is deliberately strict about the one platform rule the driver is
 * built around: `exec` refuses `BEGIN`, `COMMIT`, `END`, and bare `ROLLBACK`,
 * exactly as Durable Object SQLite does, so a driver that quietly started
 * issuing its own transaction control would fail here rather than only on
 * deployment. `SAVEPOINT` and `ROLLBACK TO` are ordinary statements and pass
 * through.
 *
 * Two fidelity notes. Blob columns come back as `ArrayBuffer`, which is what
 * the platform returns and what the driver normalizes to `Uint8Array`. And
 * `exec` runs exactly one statement per call, where the platform accepts
 * several separated by semicolons; the driver only ever sends one.
 *
 * @since 0.1.0
 */
import { DatabaseSync } from "node:sqlite"
import type { DurableObjectStorageLike, SqlStorageCursorLike, SqlStorageValue } from "../cloudflare/SqlStorageLike.ts"

/**
 * A fake storage handle over a private in-memory SQLite database.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface DurableObjectStorageFake extends DurableObjectStorageLike {
  /** Closes the underlying database. */
  readonly close: () => void
}

/** The statements Durable Object SQLite reserves for `transaction`. */
const reserved = /^\s*(?:begin|commit|end|rollback(?!\s+to\b))\b/i

const emptyCursor: SqlStorageCursorLike = {
  columnNames: [],
  raw: () => [].values()
}

const toStorageValue = (value: unknown): SqlStorageValue =>
  value instanceof Uint8Array
    ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
    : value as SqlStorageValue

/**
 * Builds a fake storage handle. Each call gets its own database, the way each
 * Durable Object id gets its own.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (): DurableObjectStorageFake => {
  const database = new DatabaseSync(":memory:")

  const run = (query: string, bindings: ReadonlyArray<unknown>): SqlStorageCursorLike => {
    if (reserved.test(query)) {
      throw new Error(`SQL transactions are not allowed here; use transaction(): ${query}`)
    }
    const statement = database.prepare(query)
    const columns = statement.columns()
    if (columns.length === 0) {
      statement.run(...bindings as Array<never>)
      return emptyCursor
    }
    statement.setReturnArrays(true)
    const rows = statement.all(...bindings as Array<never>) as unknown as Array<Array<unknown>>
    return {
      columnNames: columns.map((column) => column.name),
      raw: () => rows.map((row) => row.map(toStorageValue)).values()
    }
  }

  /**
   * The platform reports a failure as a plain `Error` carrying SQLite's own
   * text and nothing else, where `node:sqlite` attaches `code` and `errcode`.
   * Rethrowing the bare message is the fidelity that matters: it is what makes
   * the driver's message-based classification the code path under test, rather
   * than a Node-only field the platform never sends. `node:sqlite` throws
   * `Error` and nothing else, so the message is read without a guard.
   */
  const exec = (query: string, ...bindings: ReadonlyArray<unknown>): SqlStorageCursorLike => {
    try {
      return run(query, bindings)
    } catch (cause) {
      throw new Error((cause as Error).message, { cause })
    }
  }

  return {
    sql: { exec },
    transaction: async (closure) => {
      let rolledBack = false
      database.exec("BEGIN")
      try {
        // The platform lets a rolled-back closure keep running and still
        // returns its value, so `rollback` only records the decision.
        const result = await closure({ rollback: () => rolledBack = true })
        database.exec(rolledBack ? "ROLLBACK" : "COMMIT")
        return result
      } catch (cause) {
        database.exec("ROLLBACK")
        throw cause
      }
    },
    close: () => database.close()
  }
}
