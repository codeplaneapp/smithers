/**
 * Stable source-parity failures:
 * `packages/testing/test/support/ParityManifest.ts`.
 */
import { describe, expect, it } from "vitest"
import * as TestingError from "../src/TestingError.ts"

describe("TestingError", () => {
  it("represents approval fail timeouts as task_timeout failures", () => {
    const error = new TestingError.TaskTimeoutError({
      requestId: "approval-1",
      policy: "fail",
      requestedAtLogicalTimeMillis: 10,
      timedOutAtLogicalTimeMillis: 20
    })

    expect(error.code).toBe("task_timeout")
    expect(error.policy).toBe("fail")
  })

  it("represents exhausted loop bounds as ralph_max_reached failures", () => {
    const error = new TestingError.RalphMaxReachedError({
      loopId: "loop-1",
      maxIterations: 8
    })

    expect(error.code).toBe("ralph_max_reached")
    expect(error.maxIterations).toBe(8)
  })
})
