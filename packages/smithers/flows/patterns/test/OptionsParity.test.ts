import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import type * as CheckSuite from "../src/CheckSuite.ts"
import type * as Kanban from "../src/Kanban.ts"
import type * as MergeQueue from "../src/MergeQueue.ts"

type KeysOf<T> = { readonly [K in keyof T]-?: true }

// `satisfies KeysOf<...>` is the contract: adding, removing, or renaming an
// interface field makes this file fail typechecking. Object.keys then lets the
// runtime assertions document the intentional asymmetries without duplicating
// an unchecked list.
const kanbanMake = {
  columns: true,
  items: true,
  concurrency: true,
  onComplete: true
} satisfies KeysOf<Kanban.MakeOptions>

const kanbanRun = {
  columns: true,
  concurrency: true,
  onComplete: true,
  until: true,
  maxIterations: true
} satisfies KeysOf<Kanban.RuntimeOptions<Kanban.Item, unknown, never, never>>

const mergeQueueMake = {
  concurrency: true,
  priority: true,
  failurePolicy: true
} satisfies KeysOf<MergeQueue.MakeOptions>

const mergeQueueRun = {
  members: true,
  concurrency: true,
  priority: true,
  failurePolicy: true
} satisfies KeysOf<MergeQueue.RuntimeOptions<unknown, unknown, never, never>>

const checkSuiteMake = {
  checks: true,
  strategy: true,
  concurrency: true,
  continueOnFail: true
} satisfies KeysOf<CheckSuite.MakeOptions>

const checkSuiteRun = {
  checks: true,
  strategy: true,
  concurrency: true,
  continueOnFail: true
} satisfies KeysOf<CheckSuite.RuntimeOptions<unknown, unknown, never, never>>

const difference = (left: object, right: object): ReadonlyArray<string> =>
  Object.keys(left).filter((name) => !Object.hasOwn(right, name)).sort()

describe("team pattern make/run option parity", () => {
  it("keeps Kanban option names aligned across declaration and runtime", () => {
    // `items` is the first argument to run. `until` and `maxIterations` are
    // runtime-only because a static declaration cannot branch between passes.
    expect(difference(kanbanMake, kanbanRun)).toEqual(["items"])
    expect(difference(kanbanRun, kanbanMake)).toEqual(["maxIterations", "until"])
  })

  it("keeps MergeQueue option names aligned across declaration and runtime", () => {
    // `members` is the first argument to make and lives in runtime options only.
    expect(difference(mergeQueueMake, mergeQueueRun)).toEqual([])
    expect(difference(mergeQueueRun, mergeQueueMake)).toEqual(["members"])
  })

  it("keeps CheckSuite option names identical across declaration and runtime", () => {
    expect(difference(checkSuiteMake, checkSuiteRun)).toEqual([])
    expect(difference(checkSuiteRun, checkSuiteMake)).toEqual([])
  })
})
