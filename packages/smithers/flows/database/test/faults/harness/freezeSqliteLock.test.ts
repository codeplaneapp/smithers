import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { freezeSqliteLock } from "./freezeSqliteLock.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-freeze-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** A second connection with a short busy timeout, so contention is visible fast. */
const write = (filename: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)`.raw
    yield* sql`INSERT INTO probe DEFAULT VALUES`.raw
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename, busyTimeout: "200 millis" })),
    Effect.scoped,
    Effect.exit
  )

describe("freezeSqliteLock", () => {
  it("holds the write lock a second connection needs, and hands it back on release", async () => {
    const filename = join(directory, "held.sqlite")
    // Create the file and the table first, so the contention below is about the
    // lock rather than about schema creation.
    const seeded = await Effect.runPromise(write(filename))
    expect(seeded._tag).toBe("Success")

    const lock = await freezeSqliteLock(filename)
    const blocked = await Effect.runPromise(write(filename))
    expect(blocked._tag).toBe("Failure")

    await lock.release()
    const admitted = await Effect.runPromise(write(filename))
    expect(admitted._tag).toBe("Success")
  })

  it("releases itself after the configured duration", async () => {
    const filename = join(directory, "timed.sqlite")
    await Effect.runPromise(write(filename))
    const lock = await freezeSqliteLock(filename, 150)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const admitted = await Effect.runPromise(write(filename))
    expect(admitted._tag).toBe("Success")
    // Releasing twice is a no-op, which is what makes it safe in a `finally`.
    await lock.release()
  })
})
