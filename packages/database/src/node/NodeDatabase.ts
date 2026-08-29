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

import { Duration, Effect, Layer, Schedule } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

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

/** Bounds how long a connection keeps retrying a peer that holds the database. */
const openAttempts = 40
const openBaseDelayMs = 5
const openMaxDelayMs = 250

const isLockedError = (error: unknown): boolean => {
  const text = String(error)
  return text.includes("database is locked") || text.includes("database is busy")
}

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
    Effect.flatMap(Layer.makeMemoMap, (memoMap) => Layer.buildWithMemoMap(self, memoMap, scope)).pipe(
      Effect.catchDefect((defect) => Effect.fail<OpenFailure>({ defect })),
      Effect.retry({ schedule: openSchedule, while: (error) => isLockedError(error.defect) }),
      Effect.catch((error) => Effect.die(error.defect))
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
  retryLockedOpen(SqliteClient.layer({
    ...options.sqlite,
    filename: options.filename
  }))
