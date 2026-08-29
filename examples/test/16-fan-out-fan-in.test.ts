import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { declaredBatches, declaredPriorities, main } from "../src/16-fan-out-fan-in.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("declares three batches of at most two, urgent checks first", () => {
  expect(declaredBatches).toEqual([
    ["audit", "licence"],
    ["lint", "types"],
    ["unit"]
  ])
})

it("carries each check's priority into the built plan", () => {
  expect(declaredPriorities()).toEqual({
    lint: 0,
    types: 0,
    unit: 0,
    audit: 9,
    licence: 5
  })
})

// `it.live` rather than `it.effect`: the checks overlap on the real clock, and
// a test clock nobody advances would leave the first batch asleep forever.
it.live("runs at most two checks at a time and joins every verdict", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "gate.sqlite"))

    expect(summary.report).toBe("lint:clean types:clean unit:clean audit:clean licence:clean")
    // The bound is topology, so it holds at run time as well as in the plan.
    expect(summary.maxInFlight).toBe(2)
    // The release blocker and the licence check share the first batch.
    expect(summary.started.slice(0, 2).sort()).toEqual(["audit", "licence"])
    expect(summary.started.slice(2, 4).sort()).toEqual(["lint", "types"])
    expect(summary.started[4]).toBe("unit")
    // Every check ran exactly once: a fan-out is five steps, not one step five
    // times.
    expect(summary.dispatches).toEqual({ lint: 1, types: 1, unit: 1, audit: 1, licence: 1 })
    expect(summary.eventTypes).toContain("flows.engine.attempt-started")
  }), { timeout: 60_000 })
