/**
 * The wait harness owns the hosts it spawns.
 *
 * A `linger` host is a process built never to exit, so between spawning one
 * and killing it a case is the only thing standing between a failed assertion
 * and a stray host running against a directory `afterAll` has already deleted.
 * These cases pin the harness half of that contract: a host nobody killed is
 * still reaped, and a host that announces nothing refuses its waits on a
 * deadline instead of hanging until the tier's own timeout.
 */
import { isAlive } from "@smthrs/testing/Faults"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { reapWaitChildren, spawnWaitChild } from "./waitChild.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-wait-ownership-"))
afterAll(async () => {
  await reapWaitChildren()
  rmSync(directory, { recursive: true, force: true })
})

const linger = (executionId: string, deadlineMs?: number) => {
  const counterFile = join(directory, `${executionId}-counter.log`)
  writeFileSync(counterFile, "")
  return spawnWaitChild({
    filename: join(directory, `${executionId}.sqlite`),
    counterFile,
    hostId: `${executionId}-host`,
    executionId,
    mode: "approval",
    phase: "linger",
    deadlineMs
  })
}

describe("the wait harness", () => {
  it("reaps a lingering host that no case ever killed", async () => {
    const child = linger("ownership-run")
    expect(await child.parked).toBe("ownership-run")
    // The fixture holds a real libuv handle open, so nothing short of a signal
    // ends this process: if the harness does not own it, it survives the file.
    expect(isAlive(child.pid)).toBe(true)

    await reapWaitChildren()

    expect(isAlive(child.pid)).toBe(false)
    // Reaped, not merely signalled: the exit was observed here, which is what
    // makes it safe to delete the host's directory next.
    expect(await child.exited).toBeNull()
  })

  it("refuses a wait whose host announced nothing before its deadline", async () => {
    const child = linger("deadline-run", 1)

    await expect(child.parked).rejects.toThrow(/announced nothing within 1ms/)
    await expect(child.settled).rejects.toThrow(/announced nothing within 1ms/)
    // A deadline is not a death. The host is still running, and still owned.
    expect(isAlive(child.pid)).toBe(true)

    await reapWaitChildren()

    expect(isAlive(child.pid)).toBe(false)
  })
})
