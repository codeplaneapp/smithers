import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { isAlive, killGroup, killProcess, parentPid, waitFor, waitForReparent } from "./killProcess.ts"

const sleeper = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })

describe("killProcess", () => {
  it("kills a real process and waits for the operating system to reap it", async () => {
    const child = sleeper()
    const pid = child.pid as number
    expect(isAlive(pid)).toBe(true)
    await killProcess(child)
    expect(isAlive(pid)).toBe(false)
  })

  it("refuses a pid that is already dead, so a suite cannot claim a fault it never injected", async () => {
    const child = sleeper()
    const pid = child.pid as number
    await killProcess(child)
    await expect(killProcess({ pid })).rejects.toThrow(/already dead/)
  })

  it("rejects a handle with no pid", async () => {
    await expect(killProcess({ pid: undefined })).rejects.toThrow(/invalid pid/)
  })

  it("reads the parent of a live process and nothing for a dead one", async () => {
    const child = sleeper()
    const pid = child.pid as number
    expect(parentPid(pid)).toBe(process.pid)
    await killProcess(child)
    expect(parentPid(pid)).toBeUndefined()
  })

  it("observes the orphan a kill leaves: the grandchild is reparented away from its dead parent", async () => {
    // A process group whose leader is the killed child. Killing the child
    // orphans the group, which is the state every crash case then asserts on.
    const parent = spawn("sh", ["-c", "sh -c 'sleep 30' & echo $! && sleep 30"], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true
    })
    const parentPidValue = parent.pid as number
    const grandchild = await new Promise<number>((resolve) => {
      parent.stdout?.setEncoding("utf8")
      parent.stdout?.once("data", (chunk: string) => resolve(Number(chunk.trim())))
    })
    try {
      expect(parentPid(grandchild)).toBe(parentPidValue)
      await killProcess(parent)
      const reparented = await waitForReparent(grandchild, parentPidValue)
      expect(reparented).not.toBe(parentPidValue)
      expect(isAlive(grandchild)).toBe(true)
    } finally {
      killGroup(parentPidValue)
    }
  })

  it("times out with the label it was given", async () => {
    await expect(waitFor(() => false, "a condition that never holds", 100))
      .rejects.toThrow(/a condition that never holds/)
  })
})
