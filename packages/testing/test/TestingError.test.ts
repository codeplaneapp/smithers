/**
 * Stable source-parity failures:
 * `packages/testing/src/internal/ParityManifest.ts`.
 */
import { describe, expect, it } from "vitest"
import * as TestingError from "../src/TestingError.ts"

describe("TestingError", () => {
  it("represents approval fail timeouts as TASK_TIMEOUT failures", () => {
    const error = new TestingError.TaskTimeoutError({
      requestId: "approval-1",
      policy: "fail",
      requestedAtLogicalTimeMillis: 10,
      timedOutAtLogicalTimeMillis: 20
    })

    expect(error.code).toBe("TASK_TIMEOUT")
    expect(error.policy).toBe("fail")
  })

  it("represents exhausted loop bounds as RALPH_MAX_REACHED failures", () => {
    const error = new TestingError.RalphMaxReachedError({
      loopId: "loop-1",
      maxIterations: 8
    })

    expect(error.code).toBe("RALPH_MAX_REACHED")
    expect(error.maxIterations).toBe(8)
  })
})
