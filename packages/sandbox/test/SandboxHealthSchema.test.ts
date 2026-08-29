import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ProviderError } from "../src/RemoteChildProcessSpawner/index.ts"
import * as SandboxHealth from "../src/SandboxHealth/index.ts"

describe("SandboxHealth durable schemas", () => {
  it("round-trips every HealthState variant with its durable tag", () => {
    const states = [
      new SandboxHealth.Healthy(),
      new SandboxHealth.Unhealthy({
        component: "sandbox",
        reason: "ping_failed",
        message: "provider declined ping"
      }),
      new SandboxHealth.Unhealthy({ component: "sandbox", reason: "unresponsive" })
    ]

    const roundTripped = states.map((state) =>
      Schema.decodeSync(SandboxHealth.HealthState)(Schema.encodeSync(SandboxHealth.HealthState)(state))
    )

    expect(roundTripped.map((state) => state._tag)).toEqual(["Healthy", "Unhealthy", "Unhealthy"])
    expect(roundTripped).toEqual(states)
  })

  it("round-trips Healthy through its own schema with the exact durable _tag", () => {
    const encoded = Schema.encodeSync(SandboxHealth.Healthy)(new SandboxHealth.Healthy())
    const decoded = Schema.decodeSync(SandboxHealth.Healthy)(encoded)

    expect(encoded).toEqual({ _tag: "Healthy" })
    expect(decoded._tag).toBe("Healthy")
  })

  it("round-trips Unhealthy with both optional message shapes", () => {
    const withMessage = new SandboxHealth.Unhealthy({
      component: "sandbox",
      reason: "ping_failed",
      message: "network disconnected"
    })
    const withoutMessage = new SandboxHealth.Unhealthy({ component: "sandbox", reason: "unresponsive" })
    const encodedWithMessage = Schema.encodeSync(SandboxHealth.Unhealthy)(withMessage)
    const encodedWithoutMessage = Schema.encodeSync(SandboxHealth.Unhealthy)(withoutMessage)
    const decodedWithMessage = Schema.decodeSync(SandboxHealth.Unhealthy)(encodedWithMessage)
    const decodedWithoutMessage = Schema.decodeSync(SandboxHealth.Unhealthy)(encodedWithoutMessage)

    expect(encodedWithMessage).toEqual({
      _tag: "Unhealthy",
      component: "sandbox",
      reason: "ping_failed",
      message: "network disconnected"
    })
    expect(encodedWithoutMessage).toEqual({
      _tag: "Unhealthy",
      component: "sandbox",
      reason: "unresponsive"
    })
    expect(Object.hasOwn(decodedWithMessage, "message")).toBe(true)
    expect(Object.hasOwn(decodedWithoutMessage, "message")).toBe(false)
    expect(decodedWithMessage._tag).toBe("Unhealthy")
    expect(decodedWithoutMessage._tag).toBe("Unhealthy")
  })

  it("round-trips ProviderError with both optional cause shapes", () => {
    const withCause = new ProviderError({
      code: "unavailable",
      message: "remote session disappeared",
      cause: { retryable: false }
    })
    const withoutCause = new ProviderError({ code: "unknown", message: "unclassified provider error" })
    const encodedWithCause = Schema.encodeSync(ProviderError)(withCause)
    const encodedWithoutCause = Schema.encodeSync(ProviderError)(withoutCause)
    const decodedWithCause = Schema.decodeSync(ProviderError)(encodedWithCause)
    const decodedWithoutCause = Schema.decodeSync(ProviderError)(encodedWithoutCause)

    expect(encodedWithCause).toEqual({
      _tag: "@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError",
      code: "unavailable",
      message: "remote session disappeared",
      cause: { retryable: false }
    })
    expect(encodedWithoutCause).toEqual({
      _tag: "@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError",
      code: "unknown",
      message: "unclassified provider error"
    })
    expect(Object.hasOwn(decodedWithCause, "cause")).toBe(true)
    expect(Object.hasOwn(decodedWithoutCause, "cause")).toBe(false)
    expect(decodedWithCause._tag).toBe("@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError")
    expect(decodedWithoutCause._tag).toBe("@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError")
  })

  it("decodes a journal-shaped health payload while discarding an unknown future field", () => {
    const decoded = Schema.decodeUnknownSync(SandboxHealth.HealthState)({
      _tag: "Unhealthy",
      component: "sandbox",
      reason: "ping_failed",
      message: "journal replay ping failed",
      recordedAt: "2030-01-02T03:04:05.000Z"
    })

    expect(decoded).toEqual(
      new SandboxHealth.Unhealthy({
        component: "sandbox",
        reason: "ping_failed",
        message: "journal replay ping failed"
      })
    )
    expect(Object.hasOwn(decoded, "recordedAt")).toBe(false)
    expect(decoded._tag).toBe("Unhealthy")
  })
})
