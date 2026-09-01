import { describe, it } from "@effect/vitest"
import { expect } from "vitest"

const difference = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): ReadonlyArray<string> =>
  left.filter((name) => !right.includes(name)).sort()

describe("team pattern make/run option parity", () => {
  it("keeps Kanban option names aligned across declaration and runtime", () => {
    const make = ["columns", "items", "concurrency", "onComplete"]
    const run = ["columns", "concurrency", "onComplete", "until", "maxIterations"]

    // `items` is the first argument to run. `until` and `maxIterations` are
    // runtime-only because a static declaration cannot branch between passes.
    expect(difference(make, run)).toEqual(["items"])
    expect(difference(run, make)).toEqual(["maxIterations", "until"])
  })

  it("keeps MergeQueue option names aligned across declaration and runtime", () => {
    const make = ["concurrency", "priority", "failurePolicy"]
    const run = ["members", "concurrency", "priority", "failurePolicy"]

    // `members` is the first argument to make and lives in runtime options only.
    expect(difference(make, run)).toEqual([])
    expect(difference(run, make)).toEqual(["members"])
  })

  it("keeps CheckSuite option names identical across declaration and runtime", () => {
    const make = ["checks", "strategy", "concurrency", "continueOnFail"]
    const run = ["checks", "strategy", "concurrency", "continueOnFail"]

    expect(difference(make, run)).toEqual([])
    expect(difference(run, make)).toEqual([])
  })
})
