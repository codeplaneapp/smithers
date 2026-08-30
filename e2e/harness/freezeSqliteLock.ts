/**
 * Wedging the SQLite file a durable runtime writes through.
 *
 * The lock is taken with `@effect/sql-sqlite-node`, the driver
 * `@smthrs/database/node/NodeDatabase` opens the engine's database with, so the
 * contention a fault suite injects is the contention the product meets:
 * `BEGIN IMMEDIATE` takes the write lock and leaves readers alone, which is the
 * degraded-not-dead state a wedged database actually produces.
 *
 * The transaction is held open by a fiber parked on a latch rather than by a
 * detached connection object, because the client is scoped: closing its scope
 * is what closes the connection, and only a fiber can hold a scope open across
 * the `await` a test does in between.
 *
 * @since 1.0.0
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * A held write lock.
 *
 * @since 1.0.0
 * @category models
 */
export interface FrozenLock {
  /** Commits and closes, letting writers through again. Idempotent. */
  readonly release: () => Promise<void>
}

/**
 * Holds the write lock on `filename` until the returned handle is released.
 *
 * `durationMs`, when given, releases the lock on its own so a test that throws
 * before its `finally` cannot leave the file wedged for the rest of the suite.
 *
 * @since 1.0.0
 * @category constructors
 */
export const freezeSqliteLock = async (
  filename: string,
  durationMs?: number
): Promise<FrozenLock> => {
  let signalHeld: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    signalHeld = resolve
  })
  let signalAcquired: () => void = () => {}
  let signalFailed: (cause: unknown) => void = () => {}
  const acquired = new Promise<void>((resolve, reject) => {
    signalAcquired = resolve
    signalFailed = reject
  })

  const program = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`BEGIN IMMEDIATE`.raw
    yield* Effect.sync(signalAcquired)
    yield* Effect.promise(() => held)
    yield* sql`COMMIT`.raw
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename })),
    Effect.scoped,
    Effect.tapCause((cause) => Effect.sync(() => signalFailed(cause)))
  )

  const fiber = Effect.runFork(program)
  await acquired

  let released = false
  let timer: NodeJS.Timeout | undefined
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    if (timer !== undefined) clearTimeout(timer)
    signalHeld()
    await Effect.runPromise(Fiber.await(fiber))
  }
  if (durationMs !== undefined && durationMs > 0) {
    timer = setTimeout(() => void release(), durationMs)
    timer.unref()
  }
  return { release }
}
