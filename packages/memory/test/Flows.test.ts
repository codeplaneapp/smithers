import * as Flow from "@smthrs/core/Flow"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Flows from "../src/Flows.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

describe("Flows", () => {
  it("declares remember and recall as unsealed flows without bodies", () => {
    expect(Flows.remember.name).toBe("remember")
    expect(Flows.recall.name).toBe("recall")
    expect(Flows.remember.body).toBeUndefined()
    expect(Flows.recall.body).toBeUndefined()
    expect(Flows.remember.effects?.tier).not.toBe("sealed")
    expect(Flows.recall.effects?.tier).not.toBe("sealed")
  })

  it("exposes a bindable recall slot and concrete runtime handlers", () => {
    const binding = Flow.make({
      input: Flows.RecallInput,
      output: Flows.RecallOutput
    })
    expect(Flows.bindRecall(binding)).toBe(binding)
    expect(Flows.handlers).toMatchObject({
      remember: expect.any(Function),
      recall: expect.any(Function)
    })
  })

  it("persists a remembered fact in the bank's namespace, with and without tags", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const tagged = yield* Flows.handlers.remember({
          bank: "global-history",
          key: "release",
          text: "cut 0.1.0",
          tags: ["scope:project"]
        })
        const untagged = yield* Flows.runRemember({ bank: "project", key: "plain", text: "no tags" })
        const prefixed = yield* store.getFact({ namespace: { kind: "global", id: "history" }, key: "release" })
        const local = yield* store.getFact({ namespace: { kind: "flow", id: "project" }, key: "plain" })
        return { tagged, untagged, prefixed, local }
      }).pipe(Effect.provide(TestMemory.layer))
    )

    expect(result.tagged).toEqual({ key: "release" })
    expect(result.untagged).toEqual({ key: "plain" })
    expect(result.prefixed?.value).toEqual({ content: "cut 0.1.0", tags: ["scope:project"] })
    expect(result.local?.value).toEqual({ content: "no tags", tags: [] })
  })

  it("delegates the recall handler to the installed recall service", async () => {
    const rows = await Effect.runPromise(
      Flows.handlers.recall({ banks: ["flow-one", "flow-two"], query: "durable" }).pipe(
        Effect.provide(Recall.layer({
          recall: (input) =>
            Effect.succeed(input.banks.map((bank) => ({ bank, key: input.query, text: "row", score: 1 })))
        }))
      )
    )

    expect(rows).toEqual([
      { bank: "flow-one", key: "durable", text: "row", score: 1 },
      { bank: "flow-two", key: "durable", text: "row", score: 1 }
    ])
  })
})
