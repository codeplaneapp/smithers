import { describe, expect, test } from "bun:test"
import { APP_API_VERSION, AppBootstrapSchema, hasCapability } from "./AppBootstrap"

describe("app bootstrap contract", () => {
  test("validates a local offline host without inventing cloud services", () => {
    const bootstrap = AppBootstrapSchema.parse({
      apiVersion: APP_API_VERSION,
      host: "local",
      version: "1.0.0",
      buildSha: "abc",
      capabilities: ["local.repositories", "local.targets"],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    })
    expect(hasCapability(bootstrap, "local.targets")).toBe(true)
    expect(hasCapability(bootstrap, "agent")).toBe(false)
  })

  test("rejects an API version the client does not understand", () => {
    expect(AppBootstrapSchema.safeParse({ apiVersion: 2 }).success).toBe(false)
  })
})
