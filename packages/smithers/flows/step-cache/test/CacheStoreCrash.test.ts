/**
 * Process death inside a `put`, against a real file on disk.
 *
 * `CacheStoreDurable.test.ts` races two live connections, which is a different
 * property: it shows who wins, not what survives. A `put` writes two rows, the
 * append-only provenance record and the mutable head, and a replay reads the
 * ledger while an ordinary lookup reads the head. A crash that left one row
 * without the other would make those two answers disagree forever, so the
 * transaction is the contract and a killed process is how it is checked.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const fixture = fileURLToPath(new URL("./fixtures/crash-put.ts", import.meta.url))

const run = (filename: string, mode: "commit" | "crash") =>
  spawnSync(process.execPath, [fixture, filename, mode], { cwd: packageRoot, encoding: "utf8" })

/** Counts both durable tables through a cold connection to the file. */
const rowCounts = (filename: string) =>
  Effect.scoped(
    Effect.provide(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const head = yield* sql<{ readonly total: number }>`SELECT count(*) AS total FROM flows_step_cache`
        const ledger = yield* sql<{ readonly total: number }>`
          SELECT count(*) AS total FROM flows_step_cache_recorded
        `
        return { head: head[0]!.total, ledger: ledger[0]!.total }
      }),
      Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
    )
  ).pipe(Effect.orDie)

describe("a process killed inside a put", () => {
  it.effect(
    "leaves neither the head row nor its provenance, and the file still takes the write",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "flows-step-cache-crash-"))),
        (directory) =>
          Effect.gen(function*() {
            const filename = join(directory, "cache.sqlite")

            const killed = run(filename, "crash")
            // The kill is real: the fixture dies by signal rather than
            // returning, which is what makes the next assertion about crash
            // durability and not about a rolled-back error path.
            expect(killed.signal).toBe("SIGKILL")
            expect(killed.status).toBe(null)

            // The kill lands before the transaction commits, so a cold reopen
            // must find neither row. Either row alone, or both of them, would
            // mean the two inserts are not one transaction and that a crash
            // can leave a head a lookup serves without the provenance a replay
            // reads.
            expect(yield* rowCounts(filename)).toEqual({ head: 0, ledger: 0 })

            // The same fixture without the kill writes both rows, so the zeros
            // above are the crash and not a fixture that never wrote anything.
            const committed = run(filename, "commit")
            expect(committed.status).toBe(0)
            expect(committed.stdout.trim()).toBe("Inserted")
            expect(yield* rowCounts(filename)).toEqual({ head: 1, ledger: 1 })
          }),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
      ),
    120_000
  )
})
