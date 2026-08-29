/**
 * Case 5 — a run parked on a timer survives the death of the host that armed
 * it, and fires exactly once when it comes due.
 *
 * The deadline is an absolute instant in the run's durable state, so a host
 * that dies before it arrives owes the run nothing: the replacement host reads
 * the same deadline and either waits out the remainder or finds it already
 * past. This case takes the second path — the timer comes due while nothing is
 * running at all — because that is the ordering a crash actually produces.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { journalEventTypes, waitingRow } from "../harness/durableState.ts"
import { isAlive, killProcess } from "../harness/killProcess.ts"
import { spawnWaitChild } from "../harness/waitChild.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case05-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const timerMs = 4_000

describe("case05 restart while waiting on a timer", () => {
  it("keeps the deadline across a SIGKILL and fires once, after nothing was running", async () => {
    const filename = join(directory, "timer.sqlite")
    const counterFile = join(directory, "counter.log")
    writeFileSync(counterFile, "")
    const executionId = "case05-run"
    const shared = { filename, counterFile, hostId: "case05-host", executionId, mode: "timer" as const }

    const arming = spawnWaitChild({ ...shared, phase: "linger", millis: timerMs })
    expect(await arming.parked).toBe(executionId)

    const parkedBefore = await waitingRow(filename, executionId)
    expect(parkedBefore?.reason).toBe("timer")

    await killProcess(arming.process)
    expect(isAlive(arming.pid)).toBe(false)
    expect(await waitingRow(filename, executionId)).toEqual(parkedBefore)

    // Let the deadline pass with no host alive at all. Whatever fires the timer
    // afterwards cannot have been holding an in-memory handle to it.
    await new Promise((resolve) => setTimeout(resolve, timerMs + 500))
    expect(await waitingRow(filename, executionId)).toEqual(parkedBefore)

    const resuming = spawnWaitChild({ ...shared, phase: "settle", millis: timerMs })
    await resuming.settled
    expect(await resuming.exited).toBe(0)

    expect(await waitingRow(filename, executionId)).toBeUndefined()
    const events = await journalEventTypes(filename, executionId)
    // One arming, one completion: a timer that fired twice would show two.
    expect(events.filter((type) => type === "flows.engine.clock-scheduled")).toHaveLength(1)
    expect(events.filter((type) => type === "flows.engine.deferred-completed")).toHaveLength(1)
  })
})
