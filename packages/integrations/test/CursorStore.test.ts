import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { CursorStore, layerMemory, layerSql } from "../src/core/CursorStore.ts"
import * as Migrations from "../src/core/migrations/index.ts"

const sqlLayer = Layer.provideMerge(layerSql, Layer.provideMerge(Migrations.layer, TestDatabase.layer))

const contract = (name: string, layer: Layer.Layer<CursorStore, never, never>) => {
  const run = <A, E>(effect: Effect.Effect<A, E, CursorStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A, E>)

  describe(name, () => {
    it("reads null for a source that has never polled", async () => {
      const cursor = await run(Effect.flatMap(CursorStore, (store) => store.get("telegram")))
      expect(cursor).toBeNull()
    })

    it("round-trips a cursor and overwrites it on the next commit", async () => {
      const cursors = await run(Effect.gen(function*() {
        const store = yield* CursorStore
        yield* store.set("telegram", "42")
        const first = yield* store.get("telegram")
        yield* store.set("telegram", "43")
        return [first, yield* store.get("telegram")]
      }))
      expect(cursors).toEqual(["42", "43"])
    })

    it("keeps sources apart", async () => {
      const cursors = await run(Effect.gen(function*() {
        const store = yield* CursorStore
        yield* store.set("telegram", "42")
        yield* store.set("telegram-secondary", "7")
        return [yield* store.get("telegram"), yield* store.get("telegram-secondary")]
      }))
      expect(cursors).toEqual(["42", "7"])
    })

    it("stores a null cursor as a real value", async () => {
      const cursor = await run(Effect.gen(function*() {
        const store = yield* CursorStore
        yield* store.set("telegram", "42")
        yield* store.set("telegram", null)
        return yield* store.get("telegram")
      }))
      expect(cursor).toBeNull()
    })
  })
}

contract("CursorStore (memory)", layerMemory)
// The durable store runs against a real SQLite database with the real
// migration applied, because "survives a restart" is the only reason it
// exists.
contract("CursorStore (SQLite)", sqlLayer as Layer.Layer<CursorStore, never, never>)

// "Survives a restart" is the only reason the SQLite store exists, so the
// durability case uses a database on disk and builds the whole layer stack
// twice. Two `yield* CursorStore` inside one `Effect.provide` would resolve
// the same memoized service over the same open connection and would pass even
// if nothing were ever written to the file.
describe("CursorStore (SQLite) durability", () => {
  const directory = mkdtempSync(join(tmpdir(), "integrations-cursor-"))
  const filename = join(directory, "cursors.db")

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  /** One process's whole stack: its own connection, its own CursorStore. */
  const process = <A>(effect: Effect.Effect<A, unknown, CursorStore>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.provideMerge(
            layerSql,
            Layer.provideMerge(
              Migrations.layer,
              Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
            )
          )
        ),
        Effect.scoped,
        Effect.orDie
      ) as Effect.Effect<A>
    )

  it("keeps the cursor across a second store opened on the same file", async () => {
    await process(Effect.flatMap(CursorStore, (store) => store.set("telegram", "99")))
    // A second stack over the same file is what a restarted process sees.
    const cursor = await process(Effect.flatMap(CursorStore, (store) => store.get("telegram")))
    expect(cursor).toBe("99")
  })

  it("re-runs the migration against the existing file without losing the row", async () => {
    const cursor = await process(Effect.flatMap(CursorStore, (store) => store.get("telegram")))
    expect(cursor).toBe("99")
  })
})
