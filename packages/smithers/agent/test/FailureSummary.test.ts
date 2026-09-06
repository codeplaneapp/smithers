import { describe, expect, it } from "vitest"
import { failureSummary } from "../src/internal/FailureSummary.ts"

describe("failure summary", () => {
  it("keeps the provider's typed refusal under the harness wrapper", () => {
    expect(failureSummary({
      code: "model_failed",
      message: "The cell frame failed",
      cause: { code: "quota_exceeded", message: "Add credits to continue." }
    })).toBe("quota_exceeded: Add credits to continue.")
  })

  it("retains the last meaningful sentence when deeper causes carry no message", () => {
    for (const cause of [null, [], { message: 42 }, { message: "  " }]) {
      expect(failureSummary({ message: "Connection refused", cause })).toBe("Connection refused")
    }
    expect(failureSummary({ message: "Retry", code: "" })).toBe("Retry")
    expect(failureSummary({ message: "Retry", code: 5 })).toBe("Retry")
    for (const value of [undefined, null, "failure", 3, {}]) expect(failureSummary(value)).toBeUndefined()
  })

  it("bounds depth and field sizes and produces one line", () => {
    const nested: Record<string, unknown> = { message: "old" }
    let current = nested
    for (let depth = 1; depth <= 16; depth++) {
      current.cause = { message: String(depth) }
      current = current.cause as Record<string, unknown>
    }
    expect(failureSummary(nested)).toBe("15")
    expect(failureSummary({ message: " \nRetry\t later \r\n", code: "rate_limited" })).toBe("rate_limited: Retry later")
    expect(failureSummary({ code: "c".repeat(200), message: "x".repeat(2000) }))
      .toBe(`${"c".repeat(128)}: ${"x".repeat(1024)}`)
  })
})
