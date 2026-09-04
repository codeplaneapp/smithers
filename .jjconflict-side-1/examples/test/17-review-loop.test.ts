import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { declaredCalls, main, maxRounds } from "../src/17-review-loop.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("unrolls exactly the planned rounds, including the exhausted exit", () => {
  // Three reviews, two revisions between them, and four terminal steps: one
  // approval exit per round plus the exit taken when the budget is spent.
  expect(declaredCalls()).toEqual({
    "examples/Draft": 1,
    "examples/Review": maxRounds,
    "examples/Revise": maxRounds - 1,
    "examples/Publish": maxRounds + 1
  })
})

it.effect("stops the loop on the round the reviewer approves", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "approved.sqlite"), {
      approveOnRound: 3,
      executionId: "article-approved"
    })

    expect(summary.outcome.approved).toBe(true)
    expect(summary.outcome.rounds).toBe(3)
    // Two revisions carried the draft into the third review, and the approved
    // text is the one the third review saw.
    expect(summary.revisions).toHaveLength(2)
    expect(summary.outcome.text).toBe("draft of durable loops (tighten round 1) (tighten round 2)")
    expect(summary.reviews.map((entry) => entry.endsWith("true"))).toEqual([false, false, true])
  }))

it.effect("stops on the planned bound when the reviewer never approves", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "exhausted.sqlite"), {
      approveOnRound: 99,
      executionId: "article-exhausted"
    })

    expect(summary.outcome.approved).toBe(false)
    expect(summary.outcome.rounds).toBe(maxRounds)
    // The budget is topology: a fourth review was never planned, so a stubborn
    // reviewer cannot spend one.
    expect(summary.reviews).toHaveLength(maxRounds)
    expect(summary.revisions).toHaveLength(maxRounds - 1)
  }))
