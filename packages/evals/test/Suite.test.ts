import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Suite from "../src/Suite.ts"

describe("Suite", () => {
  it("rejects duplicate and empty cases", async () => {
    const duplicate = await Effect.runPromiseExit(
      Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: 1 }, { name: "a", input: 2 }] })
    )
    const empty = await Effect.runPromiseExit(Suite.make({ name: "x", concurrency: 1, cases: [] }))
    expect(duplicate._tag).toBe("Failure")
    expect(empty._tag).toBe("Failure")
  })

  it("loads JSON Lines in declaration order", async () => {
    const suite = await Effect.runPromise(
      Suite.fromJsonLines("{\"name\":\"first\",\"input\":1}\n\n{\"name\":\"second\",\"input\":2}", {
        name: "fixture",
        concurrency: 2
      })
    )
    expect(suite.cases.map((suiteCase) => suiteCase.name)).toEqual(["first", "second"])
  })
})
