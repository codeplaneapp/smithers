import { inspect } from "node:util"
import { describe, expect, it } from "vitest"
import { redact } from "../src/core/Redact.ts"
import { redactedError } from "../src/core/RedactedError.ts"

describe("credential redaction", () => {
  it("replaces repeated literal matches, including regex metacharacters", () => {
    const secret = "a.*+?^${}()|[]\\z"
    expect(redact(`${secret} / ${secret}`, [secret])).toBe("[REDACTED] / [REDACTED]")
  })

  it("replaces a full authorization value before its token", () => {
    expect(redact("Bearer token token Bearer token", ["token", "Bearer token"]))
      .toBe("[REDACTED] [REDACTED] [REDACTED]")
  })

  it("does not reprocess the replacement marker or insert it for empty credentials", () => {
    expect(redact("SECRET REDACTED unchanged", ["SECRET", "REDACTED", undefined, ""]))
      .toBe("[REDACTED] [REDACTED] unchanged")
    expect(redact("unchanged", [undefined, ""])).toBe("unchanged")
  })

  it("sanitizes nested details, keys, and errors without mutating the input", () => {
    const upstream = new Error("secret", { cause: new Error("secret") })
    const details = {
      nested: [{ secret: "secret" }, "secret", { value: "secret" }, upstream],
      count: 1,
      nil: null,
      yes: true
    }
    const failure = redactedError(["secret"])("delivery-failed", "secret", details, { cause: upstream })
    expect(failure.summary).toBe("[REDACTED]")
    expect(failure.details).toMatchObject({
      nested: [{ "[REDACTED]": "[REDACTED]" }, "[REDACTED]", { value: "[REDACTED]" }, new Error("[REDACTED]")],
      count: 1,
      nil: null,
      yes: true
    })
    expect(inspect(failure, { depth: null })).not.toContain("secret")
    expect(failure.cause).not.toBe(upstream)
    expect((failure.cause as Error).cause).toBeUndefined()
    expect(upstream.message).toBe("secret")
    expect(details.nested[0]).toEqual({ secret: "secret" })
  })

  it("handles shared and cyclic details and preserves an own __proto__ key", () => {
    const details: Record<string, unknown> = JSON.parse("{\"__proto__\":\"secret\"}")
    details["self"] = details
    const failure = redactedError(["secret"])("delivery-failed", "failure", details)
    expect(failure.details?.["__proto__"]).toBe("[REDACTED]")
    const copy = failure.details?.["self"] as Record<string, unknown>
    expect(copy["self"]).toBe(copy)
    expect(copy).not.toBe(details)
  })

  it("preserves absent causes and redacts primitive causes", () => {
    const error = redactedError(["secret"])
    expect(error("delivery-failed", "failure")).not.toHaveProperty("cause")
    expect((error("delivery-failed", "failure", undefined, { cause: "secret" }).cause as Error).message)
      .toBe("[REDACTED]")
  })
})
