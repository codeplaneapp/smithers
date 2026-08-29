import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Catalog from "../src/Catalog.ts"

const entry: Catalog.Entry = {
  description: "search the tree",
  handler: () => Effect.succeed({ files: [] }),
  name: "grep"
}

describe("Catalog", () => {
  it("looks entries up by name", () => {
    const catalog = Catalog.make([entry])
    expect(catalog.entries).toEqual([entry])
    expect(catalog.lookup("grep")).toBe(entry)
    expect(catalog.lookup("missing")).toBeUndefined()
  })

  it("digests an entry's declaration, not its handler", () => {
    const same = Catalog.entryDigest({ ...entry, handler: () => Effect.succeed("other") })
    expect(Catalog.entryDigest(entry)).toBe(same)
    expect(Catalog.entryDigest({ ...entry, name: "grep2" })).not.toBe(Catalog.entryDigest(entry))
  })

  it("is empty as noop", () => {
    expect(Catalog.makeNoop().lookup("grep")).toBeUndefined()
  })

  it("provides layers", async () => {
    const fromLayer = await Effect.runPromise(
      Effect.map(Catalog.Catalog, (catalog) => catalog.lookup("grep")).pipe(
        Effect.provide(Catalog.layer([entry]))
      ) as Effect.Effect<Catalog.Entry | undefined, never, never>
    )
    expect(fromLayer).toBe(entry)
    const fromNoop = await Effect.runPromise(
      Effect.map(Catalog.Catalog, (catalog) => catalog.entries).pipe(
        Effect.provide(Catalog.layerNoop)
      ) as Effect.Effect<ReadonlyArray<Catalog.Entry>, never, never>
    )
    expect(fromNoop).toEqual([])
  })

  it("carries name and message on call errors", () => {
    const error = new Catalog.CallError({ message: "exploded", name: "boom" })
    expect(error.name).toBe("boom")
    expect(error.message).toBe("exploded")
  })
})
