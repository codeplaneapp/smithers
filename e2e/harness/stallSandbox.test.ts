import { SandboxHealth } from "@smthrs/sandbox"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { afterEach, describe, expect, it } from "vitest"
import { isAlive, parentPid } from "./killProcess.ts"
import { startStallableSandbox, type StallableSandbox } from "./stallSandbox.ts"

let sandbox: StallableSandbox | undefined
afterEach(() => {
  sandbox?.dispose()
  sandbox = undefined
})

const check = (target: StallableSandbox, deadline: Duration.Input) =>
  Effect.runPromise(SandboxHealth.make(target.provider, { deadline }).check)

describe("stallSandbox", () => {
  it("starts a real sandbox process that answers a ping", async () => {
    sandbox = await startStallableSandbox()
    expect(isAlive(sandbox.pid)).toBe(true)
    expect(parentPid(sandbox.pid)).toBe(process.pid)
    expect(await check(sandbox, "2 seconds")).toMatchObject({ _tag: "Healthy" })
  })

  it("reports unresponsive while the sandbox process is stopped, and healthy again after", async () => {
    sandbox = await startStallableSandbox()
    sandbox.stall()
    expect(await check(sandbox, "300 millis")).toMatchObject({
      _tag: "Unhealthy",
      component: "sandbox",
      reason: "unresponsive"
    })
    sandbox.resume()
    expect(await check(sandbox, "2 seconds")).toMatchObject({ _tag: "Healthy" })
  })

  it("reports ping_failed once the sandbox process is gone", async () => {
    sandbox = await startStallableSandbox()
    await sandbox.kill()
    expect(isAlive(sandbox.pid)).toBe(false)
    expect(await check(sandbox, "2 seconds")).toMatchObject({
      _tag: "Unhealthy",
      component: "sandbox",
      reason: "ping_failed"
    })
  })
})
