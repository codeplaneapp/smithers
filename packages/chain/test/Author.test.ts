import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Author from "../src/Author.ts"

const authorWith = (layer: ReturnType<typeof Author.layerMock>, input: Author.Input) =>
  Effect.runPromise(
    Effect.flatMap(Author.Author, (author) => author.author(input)).pipe(
      Effect.provide(layer)
    ) as Effect.Effect<string, never, never>
  )

const input: Author.Input = { context: ["goal"], prefix: "" }

describe("Author", () => {
  it("pops mocked outputs in order and then exhausts", async () => {
    const layer = Author.layerMock(["one", "two"])
    const program = Effect.gen(function*() {
      const author = yield* Author.Author
      const first = yield* author.author(input)
      const second = yield* author.author(input)
      const error = yield* Effect.flip(author.author(input))
      return { error, first, second }
    }).pipe(Effect.provide(layer))
    const { error, first, second } = await Effect.runPromise(
      program as Effect.Effect<
        { error: Author.AuthorError; first: string; second: string },
        never,
        never
      >
    )
    expect(first).toBe("one")
    expect(second).toBe("two")
    expect(error.code).toBe("exhausted")
    expect(error.message).toContain("2")
  })

  it("computes output from input with layerFn", async () => {
    const layer = Author.layerFn((seen) => `prefix=${seen.prefix} context=${seen.context.join(",")}`)
    const output = await authorWith(layer, { context: ["a", "b"], prefix: "P" })
    expect(output).toBe("prefix=P context=a,b")
  })

  it("fails as noop with a typed error", async () => {
    const error = await Effect.runPromise(Effect.flip(Author.makeNoop().author(input)))
    expect(error.code).toBe("author_unavailable")
  })

  it("accepts noop overrides and provides the noop layer", async () => {
    const overridden = Author.makeNoop({ author: () => Effect.succeed("canned") })
    expect(await Effect.runPromise(overridden.author(input))).toBe("canned")
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(Author.Author, (author) => author.author(input))).pipe(
        Effect.provide(Author.layerNoop())
      ) as Effect.Effect<Author.AuthorError, never, never>
    )
    expect(error.code).toBe("author_unavailable")
  })

  it("normalizes author payloads to context lines", () => {
    expect(Author.contextOf({ context: ["a", 1, true] })).toEqual(["a", "1", "true"])
    expect(Author.contextOf({ context: "not an array" })).toEqual([])
    expect(Author.contextOf({ other: 1 })).toEqual([])
    expect(Author.contextOf(null)).toEqual([])
    expect(Author.contextOf("garbage")).toEqual([])
  })
})
