/**
 * Node SQLite driver layer.
 *
 * Backend pattern:
 * `reference/effect/packages/sql/sqlite-node/src/SqliteClient.ts`.
 * The browser counterpart is tracked against Effect's
 * `sqlite-wasm/src/OpfsWorker.ts`.
 *
 * This layer provides only the SQL client — connection options and nothing
 * else. The write policy lives in `DurableWriter.layer`, composed on top.
 *
 * @since 0.1.0
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"

import { Duration, Effect, Layer, Schedule, Schema } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

/**
 * Configuration for a Node SQLite connection.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface NodeDatabaseOptions {
  /** SQLite database filename. */
  readonly filename: string
  /** Additional driver configuration. WAL remains enabled unless explicitly disabled. */
  readonly sqlite?: Omit<SqliteClient.SqliteClientConfig, "filename"> | undefined
}

/**
 * Stable codes for the two rc.0 exclusions this driver enforces.
 *
 * `unsupported_runtime` refuses the durable engine under Bun (rc-contract
 * §1 and §7 "Runtimes", exclusion X-18). `unsupported_database_file` refuses a
 * 0.x `smithers.db` (rc-contract §2 and §6, exclusion X-13).
 *
 * @category models
 * @since 1.0.0
 */
export const UnsupportedDatabaseCode = Schema.Literals([
  "unsupported_runtime",
  "unsupported_database_file"
])

/**
 * Stable code for an rc.0 refusal to open a durable database.
 *
 * @category models
 * @since 1.0.0
 */
export type UnsupportedDatabaseCode = typeof UnsupportedDatabaseCode.Type

/**
 * Refusal to open a durable database in 1.0.0-rc.0.
 *
 * Raised as a *defect* by `layer`, not as a typed failure, for the same
 * reason a non-lock open failure is a defect: `layer` is a leaf client layer
 * whose error channel every durable package composes against as `never`, and
 * neither refusal is recoverable at run time. Both are operator mistakes
 * fixed by pointing the runtime somewhere else or by running Node.js. The
 * value carried by the defect is still typed and matchable with
 * `isUnsupportedDatabase`.
 *
 * @category errors
 * @since 1.0.0
 */
export class UnsupportedDatabase extends Schema.TaggedError<UnsupportedDatabase>()(
  "@smthrs/database/UnsupportedDatabase",
  {
    code: UnsupportedDatabaseCode,
    message: Schema.String
  }
) {}

/**
 * Narrows an unknown defect to this driver's refusal.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isUnsupportedDatabase = (input: unknown): input is UnsupportedDatabase =>
  input instanceof UnsupportedDatabase

/** The one Node.js floor rc.0 states, repeated in the refusal message. */
const nodeFloor = ">=22.19.0"

/**
 * The ledger table every flows migration set records its progress in
 * (`Migrations.table`). Its absence from a database that already has tables
 * is what separates a 0.x `smithers.db` from a Smithers 1.0 file. Repeated
 * here rather than imported so the guard stays free of the migration module.
 */
const migrationLedgerTable = "flows_migrations"

const isLockedError = (error: unknown): boolean => {
  const text = String(error)
  return text.includes("database is locked") || text.includes("database is busy")
}

/**
 * Reads the tables of a file without joining the WAL or converting it.
 *
 * Returns `undefined` when the file cannot be inspected at all: a path that
 * does not exist, a directory, an in-memory name, or a file SQLite refuses to
 * read. None of those is a 0.x database, so the driver's own open behavior
 * decides what happens next and the guard says nothing.
 *
 * A file a peer holds locked is not one of those cases and is rethrown, so
 * `guardOpen` outwaits the lock on the same ladder the open uses. Answering
 * `undefined` there would wave the file through: the open ladder outwaits the
 * same peer, so a 0.x `smithers.db` whose 0.x writer held it for a moment
 * would be opened and migrated, which is the refusal rc-contract section 2
 * states without condition.
 */
const readTableNames = (filename: string): ReadonlyArray<string> | undefined => {
  let db: DatabaseSync | undefined
  try {
    if (!statSync(filename).isFile()) return undefined
    db = new DatabaseSync(filename, { readOnly: true })
    return db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => String((row as { readonly name: unknown }).name))
  } catch (error) {
    if (isLockedError(error)) throw error
    return undefined
  } finally {
    db?.close()
  }
}

/**
 * Refuses the open when rc.0 does not support it, and says nothing otherwise.
 *
 * Order matters: the runtime check runs before the file is touched, so a Bun
 * process is told it is the wrong runtime rather than told something about
 * the file it pointed at.
 */
const unsupportedOpen = (filename: string): UnsupportedDatabase | undefined => {
  if (process.versions.bun !== undefined) {
    return new UnsupportedDatabase({
      code: "unsupported_runtime",
      message: `1.0.0-rc.0 runs the durable engine on Node.js ${nodeFloor} only`
    })
  }
  const tables = readTableNames(filename)
  if (tables === undefined || tables.length === 0) return undefined
  if (tables.includes(migrationLedgerTable)) return undefined
  return new UnsupportedDatabase({
    code: "unsupported_database_file",
    message: `${filename} is not a Smithers 1.0 database (1.0.0-rc.0 does not load a 0.x smithers.db)`
  })
}

/**
 * The rc.0 open guard, evaluated once per layer build.
 *
 * A `smithers.db` opened through this ladder would gain `flows_*` tables
 * beside its `_smithers_*` ones and silently mix two schemas; a durable
 * database opened under Bun would fail later, deeper, and less legibly. Both
 * are refused here, before the connection exists.
 */
const guardOpen = (filename: string): Effect.Effect<void> =>
  retryWhileLocked(Effect.suspend(() => {
    const refusal = unsupportedOpen(filename)
    return refusal === undefined ? Effect.void : Effect.die(refusal)
  }))

/** Bounds how long a connection keeps retrying a peer that holds the database. */
const openAttempts = 40
const openBaseDelayMs = 5
const openMaxDelayMs = 250

/** Carries an open-time defect through a retry as a typed failure. */
interface OpenFailure {
  readonly defect: unknown
}

/**
 * Deliberately not an option. Unlike the write-retry policy — which callers
 * tune through `WriteRetryOptions` — this ladder bounds a driver-internal
 * race during layer construction, before any service exists to configure. Its
 * bounds are dictated by SQLite's WAL conversion behavior described below,
 * not by workload, so a caller has nothing to say about them.
 */
const openSchedule = Schedule.exponential(Duration.millis(openBaseDelayMs)).pipe(
  // Jitter before the cap, as `WriteRetry` does, so `openMaxDelayMs` bounds
  // the delay that is actually slept.
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.millis(Math.min(openMaxDelayMs, Duration.toMillis(duration))))
  ),
  Schedule.upTo({ times: openAttempts - 1 })
)

/**
 * Retries `self` on the fixed ladder while SQLite reports the file as locked,
 * then re-raises the original defect unchanged.
 *
 * One ladder serves the guard's probe and the open itself, so the guard is
 * never the first to give up on a peer the open would have waited out.
 */
const retryWhileLocked = <A>(self: Effect.Effect<A>): Effect.Effect<A> =>
  self.pipe(
    Effect.catchDefect((defect) => Effect.fail<OpenFailure>({ defect })),
    Effect.retry({ schedule: openSchedule, while: (error) => isLockedError(error.defect) }),
    Effect.catch((error) => Effect.die(error.defect))
  )

/**
 * Retries opening a connection while SQLite reports the database as locked.
 *
 * `SqliteClient` opens the file and issues `PRAGMA journal_mode = WAL` inside
 * its constructor, with no busy timeout set. Two processes opening one file
 * concurrently collide there in two distinct ways, and neither is reachable by
 * `WriteRetry` — the failure is a raw throw during layer construction, so it
 * arrives as a *defect* rather than as the `SqlError` the retry policy
 * classifies:
 *
 * - `SQLITE_BUSY` on the conversion itself. SQLite refuses to move a database
 *   into or out of WAL while another connection has it open, and refuses
 *   immediately — it does not consult the busy handler, so no `busy_timeout`
 *   would help.
 * - `SQLITE_BUSY_RECOVERY` when opening a WAL database whose log needs
 *   recovery while a peer is already recovering it.
 *
 * Both clear on their own as soon as the peer finishes, so the open is retried
 * on the same transient vocabulary `WriteRetry` uses. This is what made
 * `DurableWaitingRestart` flake: a child process lost the race and died during
 * startup. Each attempt builds into its own scope, which `Layer.fromBuild`
 * closes on failure, so a failed open leaves no connection behind. A defect
 * that is not a lock is re-raised unchanged on the first attempt.
 */
const retryLockedOpen = <A>(self: Layer.Layer<A>): Layer.Layer<A> =>
  Layer.fromBuild((_memoMap, scope) =>
    // A fresh memo map per attempt: reusing the caller's would hand every
    // retry the first attempt's memoized (failed) build instead of opening
    // again. `self` is a leaf client layer, so there is nothing to share.
    retryWhileLocked(
      Effect.flatMap(Layer.makeMemoMap, (memoMap) => Layer.buildWithMemoMap(self, memoMap, scope))
    )
  )

/**
 * Provides the node:sqlite SQL client. WAL is enabled by the underlying
 * client by default.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (options: NodeDatabaseOptions): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(Effect.as(
    guardOpen(options.filename),
    retryLockedOpen(SqliteClient.layer({
      ...options.sqlite,
      filename: options.filename
    }))
  ))
