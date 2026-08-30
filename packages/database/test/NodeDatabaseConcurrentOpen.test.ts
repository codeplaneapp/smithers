import { afterEach, describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer, Result } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"

/**
 * Gates the cases whose cost is a fixed real-time ladder rather than a
 * workload. Off by default so the package gate stays fast; on in any run that
 * wants the whole contract exercised.
 */
const slowTests = process.env.FLOWS_SLOW_TESTS === "1"

/**
 * The exhaustion case outlasts the suite's 30 s budget by design, so it
 * carries its own. Finite, and generous over the measured 238 s, so a genuine
 * hang still fails rather than parking the run.
 */
const openLadderTimeout = 600_000

const tempDirectories = new Set<string>()

const tempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "flows-db-open-"))
  tempDirectories.add(directory)
  return directory
}

const tempFile = (): string => join(tempDirectory(), "open.sqlite")

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true })
  }
  tempDirectories.clear()
})

/**
 * Creates the database in rollback journal mode, so opening it still has to
 * perform the WAL conversion — the step that needs an exclusive lock.
 *
 * The migration ledger is seeded beside the table under test because these
 * cases exercise the open ladder, not the 0.x refusal: a populated file with
 * no `flows_migrations` table is what `NodeDatabaseGuard.test.ts` pins as an
 * unsupported 0.x database.
 */
const seedRollbackMode = (filename: string): void => {
  const db = new DatabaseSync(filename)
  try {
    db.exec("PRAGMA journal_mode = DELETE")
    db.exec("CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    db.exec("CREATE TABLE seeded (id INTEGER PRIMARY KEY)")
  } finally {
    db.close()
  }
}

/** Takes the file's write lock, as a peer process mid-transaction would hold it. */
const holdWriteLock = (filename: string): { readonly release: () => void } => {
  const db = new DatabaseSync(filename)
  let released = false
  db.exec("PRAGMA busy_timeout = 0")
  db.exec("BEGIN EXCLUSIVE")
  return {
    release: () => {
      if (released) return
      released = true
      db.exec("COMMIT")
      db.close()
    }
  }
}

describe("NodeDatabase concurrent open", () => {
  // Real elapsed time: `it.effect`'s TestClock would stall this.
  it.live("waits for a peer holding the file lock instead of failing the open", () =>
    Effect.gen(function*() {
      const filename = tempFile()
      seedRollbackMode(filename)
      const lock = holdWriteLock(filename)
      // Release only after the open is already under way, so the open must
      // genuinely wait on the lock rather than never observing it.
      const timer = setTimeout(() => lock.release(), 150)

      try {
        const rows = yield* (
          Effect.scoped(Effect.gen(function*() {
            const context = yield* Layer.build(
              NodeDatabase.layer({ filename }) as unknown as Layer.Layer<never>
            )
            const sql = yield* (Effect.service(SqlClient.SqlClient).pipe(
              Effect.provide(context as never)
            ) as Effect.Effect<SqlClient.SqlClient>)
            return yield* sql<{ readonly id: number }>`SELECT id FROM seeded`
          }))
        )
        expect(rows).toEqual([])
      } finally {
        clearTimeout(timer)
        lock.release()
      }
    }))

  // Opt-in: this case spends the entire open ladder against a lock nobody
  // releases, and `openSchedule` is deliberately not configurable, so it costs
  // about four minutes of real time — measured at 220-240 s over two runs,
  // because each of the 40 attempts blocks inside SQLite's own WAL-conversion
  // wait before the jittered delay even applies. It is a known limitation of
  // the default gate, not a broken contract: it passes when it is run.
  // See docs/alpha-notes.md, "Known test pins".
  //   FLOWS_SLOW_TESTS=1 pnpm --filter @smthrs/database test
  it.live.runIf(slowTests)(
    "dies with the original lock defect after the fixed open-retry budget is exhausted",
    () =>
      Effect.gen(function*() {
        const filename = tempFile()
        seedRollbackMode(filename)
        const lock = holdWriteLock(filename)

        try {
          const exit = yield* Effect.exit(
            Effect.scoped(Layer.build(NodeDatabase.layer({ filename }) as unknown as Layer.Layer<never>))
          )
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            const defect = Cause.findDefect(exit.cause)
            expect(Result.isSuccess(defect)).toBe(true)
            if (Result.isSuccess(defect)) {
              expect(String(defect.success)).toMatch(/database is (?:locked|busy)/)
              expect(defect.success).not.toMatchObject({ defect: expect.anything() })
            }
          }
        } finally {
          lock.release()
        }
      }),
    openLadderTimeout
  )

  it.effect("does not retry an open failure that is not a lock", () =>
    Effect.gen(function*() {
      // A directory is not a database: the open fails with something other than
      // a lock, so it must surface immediately rather than burn the retry budget.
      const directory = tempDirectory()
      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(NodeDatabase.layer({ filename: directory }) as unknown as Layer.Layer<never>))
      )
      expect(exit._tag).toBe("Failure")
    }))

  it.effect.each([
    { label: "an in-memory database", options: () => ({ filename: ":memory:" }) },
    { label: "a shared in-memory database", options: () => ({ filename: "file::memory:?cache=shared" }) },
    { label: "WAL explicitly disabled", options: () => ({ filename: tempFile(), sqlite: { disableWAL: true } }) }
  ])("opens $label unaffected by the retry", ({ options }) =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(NodeDatabase.layer(options()) as unknown as Layer.Layer<never>))
      )
      expect(exit._tag).toBe("Success")
    }))

  it.effect("leaves the file in WAL, so a later open needs no mode change", () =>
    Effect.gen(function*() {
      const filename = tempFile()
      seedRollbackMode(filename)

      yield* (
        Effect.scoped(
          Layer.build(NodeDatabase.layer({ filename }) as unknown as Layer.Layer<never>)
        )
      )

      const db = new DatabaseSync(filename)
      try {
        expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
      } finally {
        db.close()
      }
    }))
})
