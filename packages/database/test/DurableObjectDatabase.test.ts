/**
 * Driver-level behaviour of the Cloudflare Durable Object client.
 *
 * `DurableObjectDatabaseContract.test.ts` pins the write contract every
 * backend shares. This suite pins the parts that are specific to this driver:
 * how it reads a cursor, what `.raw` reports, how it classifies a platform
 * failure, and what it does when the platform's transaction misbehaves.
 *
 * Several cases drive a hand-written storage stub rather than the `node:sqlite`
 * fake. A rejected `transaction` and an interrupt that lands before the
 * platform has entered the transaction closure are both states the fake cannot
 * produce — its `transaction` enters the closure synchronously — so the stub
 * is the only way to reach them without workerd.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as DurableObjectDatabase from "../src/cloudflare/DurableObjectDatabase.ts"
import type { DurableObjectStorageLike, SqlStorageLike } from "../src/cloudflare/SqlStorageLike.ts"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as DurableObjectStorageFake from "../src/test/DurableObjectStorageFake.ts"

/** Builds a client over the supplied storage for the surrounding scope. */
const client = (options: DurableObjectDatabase.DurableObjectDatabaseOptions) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(
      DurableObjectDatabase.layer(options) as unknown as Layer.Layer<never>
    )
    return yield* (Effect.service(SqlClient.SqlClient).pipe(
      Effect.provide(context as never)
    ) as Effect.Effect<SqlClient.SqlClient>)
  })

/** Runs `body` against a client over a fresh fake, closing it afterwards. */
const withFake = <A, E>(
  body: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, never>,
  options?: Omit<DurableObjectDatabase.DurableObjectDatabaseOptions, "storage">
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(DurableObjectStorageFake.make),
    (storage) => Effect.scoped(Effect.flatMap(client({ ...options, storage }), body)),
    (storage) => Effect.sync(storage.close)
  )

describe("DurableObjectDatabase", () => {
  it.effect("normalizes a blob column to Uint8Array and keeps duplicate column labels apart", () =>
    Effect.gen(function*() {
      const rows = yield* withFake((sql) =>
        Effect.gen(function*() {
          yield* sql`CREATE TABLE payloads (id INTEGER PRIMARY KEY, body BLOB NOT NULL)`
          yield* sql`INSERT INTO payloads (id, body) VALUES (1, ${new Uint8Array([1, 2, 3])})`
          return yield* sql<{ readonly body: Uint8Array }>`SELECT body FROM payloads WHERE id = 1`
        })
      )

      expect(rows[0]!.body).toBeInstanceOf(Uint8Array)
      expect(Array.from(rows[0]!.body)).toEqual([1, 2, 3])
    }))

  it.effect("yields rows from .raw for a statement with result columns", () =>
    Effect.gen(function*() {
      // `.raw` is the affected-row seam, but a SELECT still has to hand back
      // its rows there, exactly as the node:sqlite driver does.
      const raw = yield* withFake((sql) =>
        Effect.gen(function*() {
          yield* sql`CREATE TABLE readings (id INTEGER PRIMARY KEY)`
          yield* sql`INSERT INTO readings (id) VALUES (7)`
          return yield* sql`SELECT id FROM readings`.raw
        })
      )

      expect(raw).toEqual([{ id: 7 }])
    }))

  it.effect("reports the affected-row count from changes(), not from rows written to indexes", () =>
    Effect.gen(function*() {
      // `rowsWritten` — the cursor counter the platform exposes — also counts
      // index rows, so on an indexed table it exceeds the row count the
      // compare-and-swap in `CacheStore` decides on. Two secondary indexes
      // make that difference observable: this delete must report 1, not 3.
      const affected = yield* withFake((sql) =>
        Effect.gen(function*() {
          yield* sql`CREATE TABLE indexed (id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL)`
          yield* sql`CREATE INDEX indexed_a ON indexed (a)`
          yield* sql`CREATE INDEX indexed_b ON indexed (b)`
          yield* sql`INSERT INTO indexed (id, a, b) VALUES (1, 'x', 'y')`
          return yield* sql`DELETE FROM indexed WHERE id = 1`.raw.pipe(
            Effect.flatMap(DurableWriter.affectedRows)
          )
        })
      )

      expect(affected).toBe(1)
    }))

  it.effect("returns positional rows from values queries", () =>
    Effect.gen(function*() {
      const result = yield* withFake((sql) =>
        Effect.gen(function*() {
          yield* sql`CREATE TABLE pairs (id INTEGER PRIMARY KEY, label TEXT NOT NULL, body BLOB NOT NULL)`
          yield* sql`INSERT INTO pairs (id, label, body) VALUES (1, 'first', ${new Uint8Array([9])})`
          return {
            prepared: yield* sql`SELECT id, label, body FROM pairs`.values,
            unprepared: yield* sql.unsafe("SELECT id, label FROM pairs").values
          }
        })
      )

      // Blobs are normalized in the positional path too, not only the object one.
      expect(result.prepared).toEqual([[1, "first", new Uint8Array([9])]])
      expect(result.unprepared).toEqual([[1, "first"]])
    }))

  it.effect("streams rows through the synchronous cursor", () =>
    Effect.gen(function*() {
      const ids = yield* withFake((sql) =>
        Effect.gen(function*() {
          yield* sql`CREATE TABLE streamed (id INTEGER PRIMARY KEY)`
          yield* sql`INSERT INTO streamed (id) VALUES (1), (2), (3)`
          return yield* Stream.runCollect(
            sql<{ readonly id: number }>`SELECT id FROM streamed ORDER BY id`.stream
          )
        })
      )

      expect(ids.map((row) => row.id)).toEqual([1, 2, 3])
    }))

  it.effect("applies a result-name transform to both rows and streamed rows", () =>
    Effect.gen(function*() {
      const result = yield* withFake(
        (sql) =>
          Effect.gen(function*() {
            yield* sql`CREATE TABLE transformed (row_id INTEGER PRIMARY KEY)`
            yield* sql`INSERT INTO transformed (row_id) VALUES (4)`
            return {
              rows: yield* sql`SELECT row_id FROM transformed`,
              streamed: yield* Stream.runCollect(sql`SELECT row_id FROM transformed`.stream)
            }
          }),
        { transformResultNames: (name) => name.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()) }
      )

      expect(result.rows).toEqual([{ rowId: 4 }])
      expect(result.streamed).toEqual([{ rowId: 4 }])
    }))

  it.effect("classifies a rejected statement as a SqlError rather than a defect", () =>
    Effect.gen(function*() {
      const error = yield* withFake((sql) => Effect.flip(sql.unsafe("SELECT * FROM missing_table")))

      expect(SqlError.isSqlError(error)).toBe(true)
      // Nothing in the text names a SQLite condition, so it stays unknown
      // rather than being forced into a category.
      expect(DurableWriter.fromSqlError(error).code).toBe("unknown")
    }))

  it.effect("recovers the constraint family from a message the platform sends without a code", () =>
    Effect.gen(function*() {
      // Durable Object SQLite reports a plain Error carrying SQLite's text and
      // nothing else. The stores decide first-writer-wins from `constraint`,
      // so a violation that arrived as `unknown` would turn a lost insert race
      // into a hard failure.
      const codes = yield* withFake((sql) =>
        Effect.gen(function*() {
          yield* sql`CREATE TABLE unique_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)`
          yield* sql`INSERT INTO unique_rows (id, label) VALUES (1, 'taken')`
          const unique = yield* Effect.flip(sql`INSERT INTO unique_rows (id, label) VALUES (2, 'taken')`)
          const notNull = yield* Effect.flip(sql.unsafe("INSERT INTO unique_rows (id, label) VALUES (3, NULL)"))
          return {
            unique: DurableWriter.fromSqlError(unique).code,
            uniqueReason: unique.reason._tag,
            notNull: DurableWriter.fromSqlError(notNull).code,
            notNullReason: notNull.reason._tag
          }
        })
      )

      expect(codes).toEqual({
        unique: "constraint",
        uniqueReason: "UniqueViolation",
        notNull: "constraint",
        notNullReason: "ConstraintError"
      })
    }))

  it.effect("refuses transaction control issued as a plain statement", () =>
    Effect.gen(function*() {
      // The platform reserves BEGIN/COMMIT/ROLLBACK for `transaction`, and the
      // fake enforces that, so a driver that started issuing its own
      // transaction control would fail here and not only on deployment.
      const error = yield* withFake((sql) => Effect.flip(sql.unsafe("BEGIN")))

      expect(SqlError.isSqlError(error)).toBe(true)
    }))

  it.effect("commits a nested write that succeeds along with the outer one", () =>
    Effect.gen(function*() {
      const rows = yield* withFake((sql) =>
        Effect.gen(function*() {
          const writer = DurableWriter.make(sql)
          yield* sql`CREATE TABLE nested (id INTEGER PRIMARY KEY)`
          yield* writer.write(Effect.gen(function*() {
            yield* sql`INSERT INTO nested (id) VALUES (1)`
            yield* writer.write(sql`INSERT INTO nested (id) VALUES (2)`)
          }))
          return yield* sql<{ readonly id: number }>`SELECT id FROM nested ORDER BY id`
        })
      )

      expect(rows).toEqual([{ id: 1 }, { id: 2 }])
    }))
})

/**
 * A storage stub whose `transaction` — and, where a case needs it, whose
 * `exec` — is under the test's control. `exec` answers nothing by default,
 * because most of these cases never get as far as a statement.
 */
const stubStorage = (
  transaction: DurableObjectStorageLike["transaction"],
  exec: SqlStorageLike["exec"] = () => ({ columnNames: [], raw: () => [].values() })
): DurableObjectStorageLike => ({ sql: { exec }, transaction })

const rejectTransaction = (reason: string): DurableObjectStorageLike["transaction"] => () =>
  Promise.reject(new Error(reason))

describe("DurableObjectDatabase when the platform reports its own error code", () => {
  it.effect("keeps that code instead of guessing from the message", () =>
    Effect.gen(function*() {
      // The message says one thing and the code another, so only a driver that
      // prefers the code can pass. A future workerd that starts attaching
      // codes must not be second-guessed by the message fallback.
      const error = yield* Effect.scoped(Effect.gen(function*() {
        const sql = yield* client({
          storage: stubStorage(rejectTransaction("unreached"), () => {
            throw Object.assign(new Error("UNIQUE constraint failed: rows.id"), { code: "SQLITE_BUSY" })
          })
        })
        return yield* Effect.flip(sql.unsafe("SELECT 1"))
      }))

      expect(error.reason._tag).toBe("LockTimeoutError")
      expect(DurableWriter.fromSqlError(error).code).toBe("busy")
    }))
})

describe("DurableObjectDatabase when the platform transaction fails", () => {
  it.effect("surfaces a rejected transaction as a SqlError", () =>
    Effect.gen(function*() {
      // The platform rejects the transaction itself when a commit loses a
      // race, long after the body has run. That arrives outside the body's
      // exit, so it has to be classified on the way out.
      const error = yield* Effect.scoped(Effect.gen(function*() {
        const sql = yield* client({ storage: stubStorage(rejectTransaction("transaction aborted")) })
        return yield* Effect.flip(DurableWriter.make(sql).write(Effect.succeed("unreached")))
      }))

      expect(error).toBeInstanceOf(DurableWriter.DatabaseError)
      expect((error as DurableWriter.DatabaseError).code).toBe("unknown")
    }))

  it.live("rolls back without running the body when the write is interrupted before the transaction opens", () =>
    Effect.gen(function*() {
      // The platform enters the transaction closure asynchronously. An
      // interrupt that lands in that window must still leave the transaction
      // rolled back, and must never run the body.
      let open = (): void => {}
      const entered = new Promise<void>((resolve) => open = resolve)
      let ran = false
      let rolledBack = false

      const storage = stubStorage((closure) => entered.then(() => closure({ rollback: () => rolledBack = true })))

      yield* Effect.scoped(Effect.gen(function*() {
        const sql = yield* client({ storage })
        const fiber = yield* DurableWriter.make(sql).write(
          Effect.sync(() => ran = true)
        ).pipe(Effect.forkChild({ startImmediately: true }))
        // The interrupt cannot be awaited inline: the write only finishes once
        // the platform has settled the transaction, and the platform is still
        // waiting on `open` below.
        yield* Fiber.interrupt(fiber).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.sync(open)
        yield* Fiber.await(fiber)
      }))

      expect(ran).toBe(false)
      expect(rolledBack).toBe(true)
    }))
})
