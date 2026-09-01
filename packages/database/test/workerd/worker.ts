/**
 * The Durable Object the workerd harness drives.
 *
 * This module runs inside workerd, so it holds the assertions the
 * `node:sqlite` fake cannot make on its own: every one of them is a claim
 * about the *platform*, not about the driver's logic. Two in particular are
 * why the harness exists at all.
 *
 * - `exec` must refuse `BEGIN`. The driver is built around that restriction —
 *   it reaches for `ctx.storage.transaction` instead of SQL — and the fake
 *   only mirrors what this check confirms.
 * - `SAVEPOINT` and `ROLLBACK TO` must pass through `exec`. Nested
 *   `DurableWriter.write` is a savepoint, which the package's README states as
 *   a contract, and savepoints are the one piece of that contract the platform
 *   could plausibly reserve alongside `BEGIN`.
 *
 * Two more are claims about the platform's cursor that the fake can only
 * mirror: a statement read through `.raw` runs once rather than twice, and a
 * duplicate column label leaves the last value in a row object while `.values`
 * keeps both.
 *
 * The class is written in the plain Durable Object form — a constructor taking
 * the object's state and a `fetch` method — rather than by extending
 * `DurableObject` from `cloudflare:workers`, and its state is typed against
 * this package's own structural `DurableObjectStorageLike`. That keeps the
 * file inside `tsc -p tsconfig.test.json` without `@cloudflare/workers-types`,
 * and it doubles as a check that a real `ctx.storage` satisfies the interface
 * the driver declares.
 */
import { Deferred, Duration, Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableObjectDatabase from "../../src/cloudflare/DurableObjectDatabase.ts"
import type { DurableObjectStorageLike } from "../../src/cloudflare/SqlStorageLike.ts"
import * as DurableWriter from "../../src/DurableWriter.ts"

/** One assertion's outcome, reported back to the vitest process as JSON. */
export interface CheckResult {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

const check = (
  name: string,
  body: Effect.Effect<boolean, unknown>
): Effect.Effect<CheckResult> =>
  Effect.match(body, {
    onSuccess: (ok) => ({ name, ok, detail: ok ? "" : "assertion returned false" }),
    onFailure: (cause) => ({ name, ok: false, detail: String(cause) })
  })

const checks = (
  sql: SqlClient.SqlClient,
  write: DurableWriter.Service["write"]
): ReadonlyArray<Effect.Effect<CheckResult>> => [
  check(
    "exec refuses BEGIN, so transaction control belongs to ctx.storage.transaction",
    Effect.map(Effect.flip(sql.unsafe("BEGIN")), () => true)
  ),
  check(
    "exec accepts SAVEPOINT and ROLLBACK TO inside a platform transaction",
    Effect.gen(function*() {
      yield* sql`CREATE TABLE savepoints (id INTEGER PRIMARY KEY)`
      yield* write(Effect.gen(function*() {
        yield* sql`INSERT INTO savepoints (id) VALUES (1)`
        yield* sql.unsafe("SAVEPOINT probe")
        yield* sql`INSERT INTO savepoints (id) VALUES (2)`
        yield* sql.unsafe("ROLLBACK TO probe")
      }))
      const rows = yield* sql<{ readonly id: number }>`SELECT id FROM savepoints ORDER BY id`
      return rows.length === 1 && rows[0]!.id === 1
    })
  ),
  // The driver builds `.raw`'s rows from the cursor it already holds, because
  // asking the platform for the same statement twice ran an INSERT twice. The
  // fake counts executions; only workerd can say what its own cursor does, and
  // a doubled INSERT is visible in the table either way.
  check(
    "a result-returning statement through .raw executes exactly once",
    Effect.gen(function*() {
      yield* sql`CREATE TABLE returned (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`
      const raw = yield* write(sql`INSERT INTO returned (id, label) VALUES (1, 'once') RETURNING id`.raw)
      const rows = yield* sql<{ readonly total: number }>`SELECT count(*) AS total FROM returned`
      return Array.isArray(raw) && raw.length === 1 &&
        (raw[0] as { readonly id: number }).id === 1 &&
        rows[0]!.total === 1
    })
  ),
  // The driver rebuilds rows positionally against `columnNames`, and the
  // package documents what that means for a duplicate label: the last column
  // wins in a row object, and `.values` still carries both. That is a claim
  // about the platform's cursor, so it belongs here rather than only against
  // the fake.
  check(
    "a duplicate column label keeps the last value in a row and both in .values",
    Effect.gen(function*() {
      const rows = yield* sql<{ readonly v: string }>`SELECT 'A' AS v, 'B' AS v`
      const values = yield* sql`SELECT 'A' AS v, 'B' AS v`.values
      return rows.length === 1 && rows[0]!.v === "B" &&
        values.length === 1 && values[0]!.length === 2 &&
        values[0]![0] === "A" && values[0]![1] === "B"
    })
  ),
  check(
    "a failed write rolls the whole transaction back",
    Effect.gen(function*() {
      yield* sql`CREATE TABLE rollback_rows (id INTEGER PRIMARY KEY)`
      yield* Effect.flip(write(Effect.gen(function*() {
        yield* sql`INSERT INTO rollback_rows (id) VALUES (1)`
        yield* sql`INSERT INTO rollback_rows (id) VALUES (2)`
        return yield* Effect.fail("abandoned" as const)
      })))
      const rows = yield* sql`SELECT id FROM rollback_rows`
      return rows.length === 0
    })
  ),
  check(
    "a failed nested write rolls back to its savepoint while the outer write commits",
    Effect.gen(function*() {
      yield* sql`CREATE TABLE nested_rows (id INTEGER PRIMARY KEY)`
      yield* write(Effect.gen(function*() {
        yield* sql`INSERT INTO nested_rows (id) VALUES (1)`
        yield* Effect.flip(write(Effect.gen(function*() {
          yield* sql`INSERT INTO nested_rows (id) VALUES (2)`
          return yield* Effect.fail("inner-abandoned" as const)
        })))
        yield* sql`INSERT INTO nested_rows (id) VALUES (3)`
      }))
      const rows = yield* sql<{ readonly id: number }>`SELECT id FROM nested_rows ORDER BY id`
      return rows.length === 2 && rows[0]!.id === 1 && rows[1]!.id === 3
    })
  ),
  check(
    "changes() reports the exact affected-row count on an indexed table",
    Effect.gen(function*() {
      yield* sql`CREATE TABLE affected (id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL)`
      yield* sql`CREATE INDEX affected_a ON affected (a)`
      yield* sql`CREATE INDEX affected_b ON affected (b)`
      yield* write(sql`INSERT INTO affected (id, a, b) VALUES (1, 'x', 'y')`)
      const matched = yield* write(
        sql`DELETE FROM affected WHERE id = 1`.raw.pipe(Effect.flatMap(DurableWriter.affectedRows))
      )
      const unmatched = yield* write(
        sql`DELETE FROM affected WHERE id = 1`.raw.pipe(Effect.flatMap(DurableWriter.affectedRows))
      )
      return matched === 1 && unmatched === 0
    })
  ),
  check(
    "a blob round trips as Uint8Array",
    Effect.gen(function*() {
      const payload = new Uint8Array(1024).fill(0xa5)
      yield* sql`CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)`
      yield* write(sql`INSERT INTO blobs (id, payload) VALUES (1, ${payload})`)
      const rows = yield* sql<{ readonly payload: Uint8Array }>`SELECT payload FROM blobs WHERE id = 1`
      const stored = rows[0]!.payload
      return stored instanceof Uint8Array && stored.length === 1024 && stored[0] === 0xa5
    })
  ),
  check(
    "two concurrent read-modify-write transactions do not lose an update",
    Effect.gen(function*() {
      yield* sql`CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`
      yield* write(sql`INSERT INTO counter (id, value) VALUES (1, 0)`)
      const readA = yield* Deferred.make<void>()
      const readB = yield* Deferred.make<void>()
      const increment = (self: Deferred.Deferred<void>, peer: Deferred.Deferred<void>) =>
        write(Effect.gen(function*() {
          const rows = yield* sql<{ readonly value: number }>`SELECT value FROM counter WHERE id = 1`
          yield* Deferred.succeed(self, undefined)
          yield* Effect.raceFirst(Deferred.await(peer), Effect.sleep(Duration.millis(250)))
          yield* sql`UPDATE counter SET value = ${rows[0]!.value + 1} WHERE id = 1`
        }))
      yield* Effect.all([increment(readA, readB), increment(readB, readA)], { concurrency: "unbounded" })
      const rows = yield* sql<{ readonly value: number }>`SELECT value FROM counter WHERE id = 1`
      return rows[0]!.value === 2
    })
  )
]

const run = (storage: DurableObjectStorageLike): Effect.Effect<ReadonlyArray<CheckResult>> =>
  Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(
      DurableObjectDatabase.layer({ storage }) as unknown as Layer.Layer<never>
    )
    const sql = yield* (Effect.service(SqlClient.SqlClient).pipe(
      Effect.provide(context as never)
    ) as Effect.Effect<SqlClient.SqlClient>)
    // Sequential, because every check shares the object's one database.
    return yield* Effect.all(checks(sql, DurableWriter.make(sql).write))
  }))

/** The minimum of a Durable Object's state that the harness touches. */
interface ObjectState {
  readonly storage: DurableObjectStorageLike
}

/** The Durable Object the worker below forwards every request to. */
export class ContractObject {
  readonly #storage: DurableObjectStorageLike

  constructor(state: ObjectState) {
    this.#storage = state.storage
  }

  async fetch(): Promise<Response> {
    const results = await Effect.runPromise(run(this.#storage))
    return new Response(JSON.stringify(results), { headers: { "content-type": "application/json" } })
  }
}

/** The namespace binding declared in the generated workerd config. */
interface Environment {
  readonly CONTRACT: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(request: Request): Promise<Response> }
  }
}

export default {
  fetch: (request: Request, environment: Environment): Promise<Response> =>
    environment.CONTRACT.get(environment.CONTRACT.idFromName("contract")).fetch(request)
}
