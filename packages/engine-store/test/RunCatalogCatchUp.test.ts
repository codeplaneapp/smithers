/**
 * The catch-up read behind a workspace follower's run catalog.
 *
 * `@smthrs/sync` serves a workspace subscription over whatever `RunCatalog`
 * the composition supplies, and every implementation of it was static or
 * in-process: a follower learned about the runs its own process registered and
 * about nothing a second engine wrote to the same workspace. This module is
 * the durable half of the fix: the read that says which runs the workspace
 * has right now. These cases drive it across two independent compositions
 * over one database file, which is what a second engine actually looks like.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as RunCatalogOps from "../src/internal/RunCatalogOps.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const runState = JSON.stringify({ version: 1, flowName: "RunCatalog/Test", payload: {} })

type Services = SqlClient.SqlClient | RunStore.RunStore

/** Opens an independent composition over one database file. */
const onFile = (filename: string) => <A, E>(body: Effect.Effect<A, E, Services | Scope.Scope>) =>
  withCrypto(
    Effect.scoped(body).pipe(Effect.provide(TestStores.layerAt(filename))) as Effect.Effect<A, E, Crypto.Crypto>
  )

const temporaryFile = Effect.gen(function*() {
  const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "run-catalog-")))
  return join(directory, "engine.db")
})

const create = (runId: string) => Effect.flatMap(RunStore.RunStore, (runs) => runs.create(runId, runState))

describe("run catalog catch-up", () => {
  it.effect("catches up to runs a second engine created over the same database", () =>
    Effect.gen(function*() {
      const filename = yield* temporaryFile
      const engine = onFile(filename)

      // The follower's composition, opened first and kept open across the
      // whole case: whatever it reads, it reads from disk.
      const seen = yield* engine(Effect.gen(function*() {
        const catalog = yield* RunCatalogOps.make()

        // A run the follower's own composition wrote, so an empty read here
        // would be a broken read rather than a missed announcement.
        yield* create("run-local")
        const start = yield* catalog.listRunIds()

        // A second engine, sharing nothing but the file, starts two runs.
        yield* onFile(filename)(Effect.andThen(create("run-remote-1"), create("run-remote-2")))
        const caughtUp = yield* catalog.listRunIds()

        return { start, caughtUp }
      }))

      expect(seen.start).toEqual(["run-local"])
      // Oldest first, so a follower opening streams in list order follows the
      // workspace in the order it happened.
      expect(seen.caughtUp).toEqual(["run-local", "run-remote-1", "run-remote-2"])
    }))

  it.effect("keeps the newest runs when the workspace is larger than the bound", () =>
    Effect.gen(function*() {
      const filename = yield* temporaryFile

      const listed = yield* onFile(filename)(Effect.gen(function*() {
        const catalog = yield* RunCatalogOps.make()
        for (const index of [0, 1, 2, 3]) yield* create(`run-${index}`)
        return {
          bounded: yield* catalog.listRunIds({ limit: 2 }),
          whole: yield* catalog.listRunIds()
        }
      }))

      // A bounded read is the tail of the whole one: a workspace past the
      // bound follows its most recent runs, not an arbitrary window of them.
      expect(listed.bounded).toEqual(["run-2", "run-3"])
      expect(listed.whole).toEqual(["run-0", "run-1", "run-2", "run-3"])
    }))

  it.effect("fails typed when the run table is not there", () =>
    Effect.gen(function*() {
      const filename = yield* temporaryFile

      const exit = yield* onFile(filename)(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const catalog = yield* RunCatalogOps.make()
        yield* sql`DROP TABLE flows_runs`.pipe(Effect.orDie)
        return yield* Effect.exit(catalog.listRunIds())
      }))

      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      expect(exit.cause.reasons[0]).toMatchObject({ error: { code: "list_failed" } })
    }))

  it.effect("provides the read as a layer", () =>
    Effect.gen(function*() {
      const filename = yield* temporaryFile

      const listed = yield* onFile(filename)(
        Effect.gen(function*() {
          yield* create("run-layered")
          const catalog = yield* RunCatalogOps.RunCatalogRead
          return yield* catalog.listRunIds()
        }).pipe(Effect.provide(RunCatalogOps.layer))
      )

      expect(listed).toEqual(["run-layered"])
    }))
})
