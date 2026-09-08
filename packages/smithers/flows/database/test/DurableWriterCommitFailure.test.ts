import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Result } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { expectTypeOf } from "vitest"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"

const deferredCommit = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = DurableWriter.make(sql)
  let published = false
  yield* sql`PRAGMA foreign_keys = ON`
  yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
  yield* sql`CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
  const failed = yield* Effect.exit(writer.write(Effect.gen(function*() {
    yield* sql`INSERT INTO child VALUES (999)`
    yield* DurableWriter.afterCommit(
      Effect.sync(() => {
        published = true
      }),
      sql
    )
  })))
  const rows = yield* sql`SELECT * FROM child`
  const next = yield* Effect.exit(writer.write(sql`INSERT INTO parent VALUES (1)`))
  const parents = yield* sql`SELECT * FROM parent`
  return { failed, rows, next, parents, published }
}).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" })))

describe("DurableWriter COMMIT failures", () => {
  it.effect("rolls back rejected rows before reusing the connection", () =>
    Effect.gen(function*() {
      const result = yield* deferredCommit
      expect(result.rows).toEqual([])
      expect(Exit.isSuccess(result.next)).toBe(true)
      expect(result.parents).toEqual([{ id: 1 }])
      expect(result.published).toBe(false)
    }))

  it.effect("normalizes a deferred foreign-key COMMIT failure into a typed DatabaseError", () =>
    Effect.gen(function*() {
      const { failed } = yield* deferredCommit
      expect(Exit.isFailure(failed)).toBe(true)
      if (!Exit.isFailure(failed)) return
      expect(Result.isFailure(Cause.findDefect(failed.cause))).toBe(true)
      const error = Result.getOrUndefined(Cause.findError(failed.cause))
      expect(error).toBeInstanceOf(DurableWriter.DatabaseError)
      expect(error).toMatchObject({ code: "constraint" })
    }))

  it.effect("discards the database connection when COMMIT recovery cannot roll back", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      yield* sql`PRAGMA foreign_keys = ON`
      yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
      yield* sql`CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
      const rollbackError = new SqlError.SqlError({
        reason: SqlError.classifySqliteError(Object.assign(new Error("rollback failed"), { code: "SQLITE_IOERR" }))
      })
      let rollbacks = 0
      yield* Effect.scoped(Effect.map(sql.reserve, (conn) => {
        const execute = conn.executeUnprepared.bind(conn)
        Object.assign(conn, {
          executeUnprepared: (...args: Parameters<typeof execute>) => {
            if (args[0] === "ROLLBACK") {
              rollbacks += 1
              return Effect.fail(rollbackError)
            }
            return execute(...args)
          }
        })
      }))
      const failed = yield* Effect.exit(writer.write(sql`INSERT INTO child VALUES (999)`))
      expect(Exit.isFailure(failed)).toBe(true)
      if (!Exit.isFailure(failed)) return
      const errors = failed.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
      expect(errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "constraint" }),
        expect.objectContaining({ code: "io" })
      ]))
      expect(rollbacks).toBe(1)
      // A fresh statement must fail because the native database was closed,
      // rather than expose the rejected transaction or wait on a leaked lease.
      const read = yield* Effect.exit(sql`SELECT * FROM child`)
      expect(Exit.isFailure(read)).toBe(true)
      if (Exit.isFailure(read)) expect(Cause.pretty(read.cause)).toContain("database is not open")
      let ran = false
      const next = yield* Effect.exit(writer.write(Effect.sync(() => {
        ran = true
      })))
      expect(Exit.isFailure(next)).toBe(true)
      expect(ran).toBe(false)
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("rolls back a defective COMMIT while preserving its defect", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      const defect = new Error("driver COMMIT defect")
      yield* sql`CREATE TABLE values_table (value INTEGER)`
      let commits = 0
      yield* Effect.scoped(Effect.map(sql.reserve, (conn) => {
        const execute = conn.executeUnprepared.bind(conn)
        Object.assign(conn, {
          executeUnprepared: (...args: Parameters<typeof execute>) =>
            args[0] === "COMMIT" && commits++ === 0 ? Effect.die(defect) : execute(...args)
        })
      }))
      const failed = yield* Effect.exit(writer.write(sql`INSERT INTO values_table VALUES (1)`))
      expect(Exit.isFailure(failed)).toBe(true)
      if (!Exit.isFailure(failed)) return
      expect(Result.getOrUndefined(Cause.findDefect(failed.cause))).toBe(defect)
      expect(yield* sql`SELECT * FROM values_table`).toEqual([])
      yield* writer.write(sql`INSERT INTO values_table VALUES (2)`)
      expect(yield* sql`SELECT * FROM values_table`).toEqual([{ value: 2 }])
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("releases a failed connection acquisition before returning its error", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      const reserve = sql.reserve
      const failure = new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause: "acquisition failed" }) })
      let released = false
      Object.assign(sql, {
        reserve: Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            released = true
          })).pipe(
            Effect.andThen(Effect.fail(failure))
          )
      })
      const error = yield* Effect.flip(writer.write(Effect.void))
      expect(error).toBeInstanceOf(DurableWriter.DatabaseError)
      expect(error.cause).toBe(failure)
      expect(released).toBe(true)
      Object.assign(sql, { reserve })
      yield* writer.write(Effect.void)
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("preserves intentional SqlError defects in the write body", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const defect = new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause: "body defect" }) })
      const exit = yield* Effect.exit(DurableWriter.make(sql).write(Effect.die(defect)))
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Result.getOrUndefined(Cause.findDefect(exit.cause))).toBe(defect)
      expect(Result.isFailure(Cause.findError(exit.cause))).toBe(true)
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("removes SqlError from the typed channel and preserves application failures", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      const sqlError = new SqlError.SqlError({
        reason: SqlError.classifySqliteError(Object.assign(new Error("constraint"), { code: "SQLITE_CONSTRAINT" }))
      })
      const applicationError = { _tag: "ApplicationError" } as const
      const body: Effect.Effect<number, SqlError.SqlError | typeof applicationError> = Effect.fail(sqlError)
      const written = writer.write(body)
      expectTypeOf<Effect.Error<typeof written>>()
        .toEqualTypeOf<DurableWriter.DatabaseError | typeof applicationError>()
      expect(yield* Effect.flip(written)).toBeInstanceOf(DurableWriter.DatabaseError)
      expect(yield* Effect.flip(writer.write(Effect.fail(applicationError)))).toBe(applicationError)
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))
})
