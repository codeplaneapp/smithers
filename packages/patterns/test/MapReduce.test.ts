import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as MapReduce from "../src/MapReduce.ts"
import { PatternError } from "../src/PatternError.ts"

const step = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

describe("MapReduce", () => {
  it("declares deterministic map and reduce phases", () => {
    const mapReduce = MapReduce.make({
      map: step,
      reduce: step,
      concurrency: 4,
      onEmpty: "reduce"
    })

    expect(Flow.isFlow(mapReduce)).toBe(true)
    expect(mapReduce.body?.({ shards: ["a", "b"] }).ast._tag).toBe("AndThen")
    const graph = Graph.build(mapReduce, { shards: ["a", "b", "c", "d", "e"] })
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(6)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(2)
  })

  it("rejects invalid concurrency", () => {
    expect(() => MapReduce.make({ map: step, reduce: step, concurrency: 0, onEmpty: "fail" })).toThrow(PatternError)
  })

  it.effect("runs every batch and reduces mapped values in shard order", () =>
    Effect.gen(function*() {
      const result = yield* MapReduce.run({ shards: [1, 2, 3, 4, 5] }, {
        concurrency: 2,
        onEmpty: "reduce",
        map: ({ index, shard }) => Effect.succeed(`${index}:${shard * 2}`),
        reduce: ({ mapped }) => Effect.succeed(mapped.join("|"))
      })

      expect(result).toBe("0:2|1:4|2:6|3:8|4:10")
    }))

  it.effect("applies every runtime empty-input policy and validates concurrency", () =>
    Effect.gen(function*() {
      const callbacks = {
        map: ({ shard }: { readonly shard: number }) => Effect.succeed(shard * 2),
        reduce: ({ mapped }: { readonly mapped: ReadonlyArray<number> }) => Effect.succeed(mapped.length)
      }
      const invalid = yield* MapReduce.run({ shards: [] as ReadonlyArray<number> }, {
        ...callbacks,
        concurrency: 0,
        onEmpty: "reduce"
      }).pipe(Effect.flip)
      const failed = yield* MapReduce.run({ shards: [] as ReadonlyArray<number> }, {
        ...callbacks,
        concurrency: 1,
        onEmpty: "fail"
      }).pipe(Effect.flip)
      const succeeded = yield* MapReduce.run({ shards: [] as ReadonlyArray<number> }, {
        ...callbacks,
        concurrency: 1,
        onEmpty: "succeed"
      })
      const reduced = yield* MapReduce.run({ shards: [] as ReadonlyArray<number> }, {
        ...callbacks,
        concurrency: 1,
        onEmpty: "reduce"
      })

      expect(invalid).toBeInstanceOf(PatternError)
      expect(failed).toBeInstanceOf(PatternError)
      expect(succeeded).toEqual([])
      expect(reduced).toBe(0)
    }))
})
