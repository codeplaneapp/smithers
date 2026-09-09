/**
 * The measurement a fan-out budget depends on: growth inside another process,
 * not inside this one.
 *
 * The case that broke this sampled its own resident set while the gateway ran
 * elsewhere, so a server that retained everything still passed. These cases pin
 * the distinction the harness has to keep making.
 */
import { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { residentBytes } from "./residentBytes.ts"

const retained = 160 * 1024 * 1024

/** A child that touches `retained` bytes and then waits to be measured. */
const allocatingChild = async () => {
  const child = spawn(
    process.execPath,
    ["-e", `globalThis.held = Buffer.alloc(${retained}, 1); console.log("ready"); setInterval(() => {}, 1000)`],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", () => reject(new Error("the child exited before it was ready")))
    child.stdout?.once("data", () => resolve())
  })
  return child
}

describe("residentBytes", () => {
  it("reads this process's own resident set", async () => {
    const measured = await residentBytes(process.pid)
    expect(measured).toBeGreaterThan(0)
    // `ps` samples on its own schedule, so this is a sanity band, not equality.
    expect(measured).toBeGreaterThan(process.memoryUsage().rss / 4)
  })

  it("sees growth in another process that this process's own usage misses", async () => {
    const ownBefore = process.memoryUsage().rss
    const child = await allocatingChild()
    try {
      const childRss = await residentBytes(child.pid!)
      const ownGrowth = process.memoryUsage().rss - ownBefore
      // The whole point: the child holds more than the fan-out budget while the
      // measuring process barely moves.
      expect(childRss).toBeGreaterThan(retained / 2)
      expect(ownGrowth).toBeLessThan(retained / 2)
    } finally {
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
      child.kill("SIGKILL")
      await exited
    }
  })

  it("refuses a pid that is not running", async () => {
    const child = await allocatingChild()
    const pid = child.pid!
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
    child.kill("SIGKILL")
    await exited
    await expect(residentBytes(pid)).rejects.toThrow()
  })
})
