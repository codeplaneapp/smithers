import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { envelope, leafNodesFor, main, plan } from "../src/33-delegation-trellis.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("builds one leaf step per plan leaf, and none for a plan outside the envelope", () => {
  expect(leafNodesFor(plan)).toBe(3)
  expect(leafNodesFor({ agent: { goal: "solo" } })).toBe(1)
  // Five leaves overspend the envelope's fuel of four, so the round settles
  // with the refusal instead of building a single step.
  expect(
    leafNodesFor({
      parallel: [
        { agent: { goal: "a" } },
        { agent: { goal: "b" } },
        { agent: { goal: "c" } },
        { sequence: [{ agent: { goal: "d" } }, { agent: { goal: "e" } }] }
      ]
    })
  ).toBe(0)
  expect(envelope.fuel).toBe(4)
})

it.effect("runs the authored plan durably, one trampoline round per plan", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "delegation.sqlite"))

    // Round two's graph came from the plan round one authored.
    expect(summary.leafNodes).toBe(3)
    expect(summary.authored).toBe(1)
    // Every leaf dispatched exactly once, carrying its own plan path.
    expect(summary.dispatched).toEqual([
      "outline@root.sequence[0]",
      "draft@root.sequence[1].parallel[0]",
      "review@root.sequence[1].parallel[1]"
    ])
    // Outputs come back in plan order.
    expect(summary.result).toEqual(["OUTLINE", "DRAFT", "REVIEW"])
  }))
