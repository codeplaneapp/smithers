import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as SuperviseRuntime from "../src/SuperviseRuntime.ts"
import * as TestSuperviseRuntime from "../src/test/TestSuperviseRuntime.ts"

const candidate = { _tag: "quota-due" } as SuperviseRuntime.Candidate
const lease = { runId: "run-1", candidate } as SuperviseRuntime.ResumeLease

describe("TestSuperviseRuntime", () => {
  it("records resumes and exposes mutable candidates and failures", async () => {
    const testRuntime = TestSuperviseRuntime.make({ candidates: [candidate] })
    expect(await Effect.runPromise(testRuntime.runtime.scan(0))).toEqual([candidate])

    await Effect.runPromise(testRuntime.runtime.resume(lease))
    expect(testRuntime.resumes).toEqual([lease])

    await Effect.runPromise(testRuntime.setCandidates([]))
    expect(await Effect.runPromise(testRuntime.runtime.scan(1))).toEqual([])

    const refusal = new SuperviseRuntime.ResumeError({
      code: "claim_lost",
      message: "another supervisor won",
      cause: undefined
    })
    await Effect.runPromise(testRuntime.setResumeError(refusal))
    expect(await Effect.runPromise(Effect.flip(testRuntime.runtime.resume(lease)))).toBe(refusal)

    await Effect.runPromise(testRuntime.setResumeError(undefined))
    await Effect.runPromise(testRuntime.runtime.resume(lease))
    expect(testRuntime.resumes).toEqual([lease, lease, lease])
  })

  it("provides the runtime as a layer and reports its controls", async () => {
    let controls: TestSuperviseRuntime.TestSuperviseRuntime | undefined
    const scanned = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* SuperviseRuntime.SuperviseRuntime
        return yield* runtime.scan(0)
      }).pipe(
        Effect.provide(TestSuperviseRuntime.layer({ candidates: [candidate] }, (ready) => {
          controls = ready
        }))
      )
    )

    expect(scanned).toEqual([candidate])
    expect(controls?.runtime).toBeDefined()

    const defaults = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* SuperviseRuntime.SuperviseRuntime
        return yield* runtime.scan(0)
      }).pipe(Effect.provide(TestSuperviseRuntime.layer()))
    )
    expect(defaults).toEqual([])
  })
})
