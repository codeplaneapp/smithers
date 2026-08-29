import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Recall from "../src/Recall.ts"

describe("Recall", () => {
  it("caps whole results and truncates only the first overflowing result", () => {
    const results = [
      { bank: "a", key: "one", text: "short", score: 1 },
      { bank: "b", key: "two", text: "a long result that must be truncated", score: 0.5 },
      { bank: "c", key: "three", text: "never reached", score: 0.1 }
    ]
    const capped = Recall.capRecallResults(results, 105)
    expect(capped).toHaveLength(2)
    expect(capped[0]).toEqual(results[0])
    const overflowing = results[1]
    expect(overflowing).toBeDefined()
    if (overflowing === undefined) return
    expect(capped[1]?.text.length).toBeLessThan(overflowing.text.length)
  })

  it.each([
    [0, 0],
    [-1, 0],
    [Number.NaN, 0]
  ])("uses a non-negative byte budget (%s)", (budget, expected) => {
    expect(Recall.capRecallResults([{ bank: "a", key: "k", text: "text", score: 1 }], budget)).toHaveLength(expected)
  })

  it("keeps a result that fits exactly and drops one that overflows by a single byte", () => {
    const single = [{ bank: "a", key: "k", text: "text", score: 1 }]
    const exact = new TextEncoder().encode(JSON.stringify(single)).byteLength
    expect(Recall.capRecallResults(single, exact)).toEqual(single)
    expect(Recall.capRecallResults(single, exact - 1)?.[0]?.text).toBe("tex")
  })

  it("drops empty-text rows and accepts an empty result set", () => {
    expect(Recall.capRecallResults([{ bank: "a", key: "k", text: "", score: 1 }], 2048)).toEqual([])
    expect(Recall.capRecallResults([], 2048)).toEqual([])
    expect(Recall.capRecallResults([{ bank: "a", key: "k", text: "kept", score: 1 }])).toHaveLength(1)
  })

  it("returns no rows from the empty recall implementation and its layer", async () => {
    const direct = await Effect.runPromise(Recall.makeNoop().recall({ banks: ["a"], query: "q" }))
    const layered = await Effect.runPromise(
      Effect.service(Recall.Recall).pipe(
        Effect.flatMap((recall) => recall.recall({ banks: ["a"], query: "q" })),
        Effect.provide(Recall.layerNoop)
      )
    )
    expect([direct, layered]).toEqual([[], []])
  })

  it("preserves an explicit bank lifetime and treats every other bank as flow-local", () => {
    expect([
      Recall.namespaceForBank("flow-one"),
      Recall.namespaceForBank("agent-fleet"),
      Recall.namespaceForBank("user-will"),
      Recall.namespaceForBank("global-history"),
      Recall.namespaceForBank("unprefixed"),
      Recall.namespaceForBank("global-"),
      Recall.namespaceForBank("")
    ]).toEqual([
      { kind: "flow", id: "one" },
      { kind: "agent", id: "fleet" },
      { kind: "user", id: "will" },
      { kind: "global", id: "history" },
      { kind: "flow", id: "unprefixed" },
      { kind: "flow", id: "global-" },
      { kind: "flow", id: "" }
    ])
  })
})
