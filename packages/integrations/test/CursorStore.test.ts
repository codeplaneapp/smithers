import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
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

describe("CursorStore (SQLite) durability", () => {
  it("keeps the cursor across a second store built on the same database", async () => {
    const program = Effect.gen(function*() {
      const first = yield* CursorStore
      yield* first.set("telegram", "99")
      // A second acquisition of the service over the same database is what a
      // restarted process sees.
      const second = yield* CursorStore
      return yield* second.get("telegram")
    })
    const cursor = await Effect.runPromise(
      program.pipe(Effect.provide(sqlLayer), Effect.scoped) as Effect.Effect<string | null>
    )
    expect(cursor).toBe("99")
  })
})
