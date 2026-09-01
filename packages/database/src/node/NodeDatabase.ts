/**
 * Node SQLite driver layer.
 *
 * Public contract: `docs/pages/api/database.md`.
 *
 * This layer provides only the SQL client — connection options and nothing
 * else. The write policy lives in `DurableWriter.layer`, composed on top.
 *
 * @since 0.1.0
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"

import { Duration, Effect, Layer, Schedule, Schema, Scope } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

/**
 * Configuration for a Node SQLite connection.
 *
 * @category models
 * @since 0.1.0
 */
export interface NodeDatabaseOptions {
  /** SQLite database filename. */
  readonly filename: string
  /** Additional driver configuration. WAL remains enabled unless explicitly disabled. */
  readonly sqlite?: Omit<SqliteClient.SqliteClientConfig, "filename"> | undefined
}

/**
 * The three stable codes covering the two rc.0 exclusions this driver enforces.
 *
 * `unsupported_runtime` refuses the durable engine under Bun (rc-contract
 * §1 and §7 "Runtimes", exclusion X-18). `unsupported_database_file` refuses a
 * 0.x `smithers.db`, and `database_locked` refuses a file the guard could not
 * read because a peer held it for longer than the open ladder waits
 * (rc-contract §2 and §6, exclusion X-13).
 *
 * @category models
 * @since 1.0.0
 */
export const UnsupportedDatabaseCode = Schema.Literals([
  "unsupported_runtime",
  "unsupported_database_file",
  "database_locked"
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
 * A defect SQLite raised because a peer holds the file, and not one this driver
 * raised about the file itself.
 *
 * Reading the text is the only test a raw driver throw allows, and the text
 * carries a path the caller chose: a 0.x database at
 * `.../database is locked.db` makes this driver's own refusal read as a lock.
 * Excluding the refusal keeps the ladder from retrying a decision the guard has
 * already made, and keeps the code it reports the code the guard chose.
 */
const isLockedDefect = (defect: unknown): boolean => !isUnsupportedDatabase(defect) && isLockedError(defect)

/**
 * Reads the tables of a file without joining the WAL or converting it.
 *
 * SQLite `file:` URIs bypass the filesystem stat because the URI itself is not
 * a pathname; `DatabaseSync` receives it directly. Returns `undefined` when
 * the file cannot be inspected at all: a path that does not exist, a
 * directory, an in-memory name, or a file SQLite refuses to read. None of
 * those is a 0.x database, so the driver's own open behavior decides what
 * happens next and the guard says nothing.
 *
 * A file a peer holds locked is not one of those cases and is rethrown, so
 * `guardOpen` outwaits the lock on the same ladder the open uses. Answering
 * `undefined` there would wave the file through: the open ladder outwaits the
 * same peer, so a 0.x `smithers.db` whose 0.x writer held it for a moment
 * would be opened and migrated, which is the refusal rc-contract section 2
 * states without condition.
 */
/**
 * The database a SQLite `file:` URI names, without the query that says how to
 * open it.
 *
 * The probe opens read-only, and SQLite refuses that outright when the URI
 * itself asks for write access: `file:/path/smithers.db?mode=rw` fails with
 * `access mode not allowed: rw` before a single table is read. Reporting
 * "cannot inspect" there would wave a 0.x database straight through, because
 * the client that follows opens read-write and succeeds — the exact bypass of
 * the refusal rc-contract section 2 states without condition. Query parameters
 * only tell SQLite how to open the file, never which tables it holds, so the
 * probe drops them (and the fragment SQLite ignores) and asks its one question
 * about the file itself.
 */
const probeTarget = (filename: string): string => {
  if (!filename.startsWith("file:")) return filename
  const query = filename.search(/[?#]/)
  return query === -1 ? filename : filename.slice(0, query)
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
  const tables = readTableNames(probeTarget(filename))
  if (tables === undefined || tables.length === 0) return undefined
  if (tables.includes(migrationLedgerTable)) return undefined
  return new UnsupportedDatabase({
    code: "unsupported_database_file",
    message: `${filename} is not a Smithers 1.0 database (1.0.0-rc.0 does not load a 0.x smithers.db)`
  })
}

/**
 * Names the one defect the guard's ladder can end on that is not already a
 * refusal: a peer held the file for longer than the ladder waits, so rc.0
 * never learned whether it was a 0.x database.
 *
 * It is refused rather than passed on. The open ladder waits the same peer out
 * on the same schedule, so handing SQLite's raw lock error to the caller would
 * report a database rc.0 declined to open as a transient driver failure, and
 * `isUnsupportedDatabase` would answer `false` about a refusal this driver made.
 * That refinement is the one narrowing every caller matches on.
 */
const guardDefect = (filename: string) => (defect: unknown): unknown =>
  isLockedDefect(defect)
    ? new UnsupportedDatabase({
      code: "database_locked",
      message: `${filename} could not be inspected because another process holds it`
    })
    : defect

/**
 * The rc.0 open guard, evaluated once per layer build.
 *
 * A `smithers.db` opened through this ladder would gain `flows_*` tables
 * beside its `_smithers_*` ones and silently mix two schemas; a durable
 * database opened under Bun would fail later, deeper, and less legibly. Both
 * are refused here, before the connection exists, and so is a file the guard
 * could not read at all.
 */
const guardOpen = (filename: string): Effect.Effect<void> =>
  retryWhileLocked(Effect.suspend(() => {
    const refusal = unsupportedOpen(filename)
    return refusal === undefined ? Effect.void : Effect.die(refusal)
  })).pipe(Effect.catchDefect((defect) => Effect.die(guardDefect(filename)(defect))))

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
    Effect.retry({ schedule: openSchedule, while: (error) => isLockedDefect(error.defect) }),
    Effect.catch((error) => Effect.die(error.defect))
  )

/**
 * Retries opening a connection while SQLite reports the database as locked.
 *
 * `SqliteClient` opens the file, sets `PRAGMA busy_timeout`, and then issues
 * `PRAGMA journal_mode = WAL` inside its constructor. Two processes opening one
 * file concurrently collide there in two distinct ways, and neither is
 * reachable by `WriteRetry` — the failure is a raw throw during layer
 * construction, so it arrives as a *defect* rather than as the `SqlError` the
 * retry policy classifies:
 *
 * - `SQLITE_BUSY` on the conversion itself. SQLite moves a database into or out
 *   of WAL only with the file to itself, and a peer connection holding a lock
 *   defeats that. The mode change does consult the busy handler — measured on
 *   node:sqlite against a peer holding a shared read lock, it waits the whole
 *   `busy_timeout` and then reports `database is locked` — so the client's
 *   timeout sets the pace of a contended attempt, and a lock that outlasts it
 *   still fails.
 * - `SQLITE_BUSY_RECOVERY` when opening a WAL database whose log needs
 *   recovery while a peer is already recovering it.
 *
 * Both clear on their own as soon as the peer finishes, so the open is retried
 * on the same transient vocabulary `WriteRetry` uses. This is what made
 * `DurableWaitingRestart` flake: a child process lost the race and died during
 * startup. Because a contended attempt can spend up to the client's
 * `busy_timeout` inside SQLite before the ladder's own delay, the wall-clock
 * cost of exhausting the ladder is bounded by the timeout the caller
 * configured, not by the delays below. Each attempt builds into its own scope,
 * which this closes on failure, so a failed open leaves no connection behind. A
 * defect that is not a lock is re-raised unchanged on the first attempt.
 */
const retryLockedOpen = <A>(self: Layer.Layer<A>): Layer.Layer<A> =>
  Layer.fromBuild((_memoMap, scope) =>
    retryWhileLocked(Effect.suspend(() => {
      // Exactly what `Layer.fromBuild` does with a build that fails, done once
      // per attempt. `Layer.fromBuild` cannot do it here: the retry lives
      // INSIDE one build, so nothing above this closes anything until every
      // attempt has been spent. Without the per-attempt fork, a failed attempt
      // that registered a connection finalizer registers it in a scope that
      // survives, and the connection it holds is one more peer for the next
      // attempt to lose to.
      const attempt = Scope.forkUnsafe(scope)
      return Effect.onExit(
        // A fresh memo map per attempt: reusing the caller's would hand every
        // retry the first attempt's memoized (failed) build instead of opening
        // again. `self` is a leaf client layer, so there is nothing to share.
        Effect.flatMap(Layer.makeMemoMap, (memoMap) => Layer.buildWithMemoMap(self, memoMap, attempt)),
        (exit) => exit._tag === "Failure" ? Scope.close(attempt, exit) : Effect.void
      )
    }))
  )

/**
 * Provides the node:sqlite SQL client. WAL is enabled by the underlying
 * client by default.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: NodeDatabaseOptions): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(Effect.as(
    guardOpen(options.filename),
    retryLockedOpen(SqliteClient.layer({
      ...options.sqlite,
      filename: options.filename
    }))
  ))
