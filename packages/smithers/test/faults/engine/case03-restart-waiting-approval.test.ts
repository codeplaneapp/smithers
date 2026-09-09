/**
 * Case 3 — a run parked on an unanswered question survives the death of the
 * host that asked it.
 *
 * A human task is the wait that most obviously outlives its process: the
 * reviewer answers tomorrow. The first host asks, parks, and is `SIGKILL`ed
 * with the question still open. The replacement host answers the token a
 * control plane would compute from outside the run and drives the same
 * execution to a decision.
 */
import { isAlive, killProcess } from "@smthrs/testing/Faults"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { journalEventTypes, waitingRow } from "./harness/durableState.ts"
import { reapWaitChildren, spawnWaitChild } from "./harness/waitChild.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case03-"))
afterAll(async () => {
  // Reap first: a lingering host outlives an assertion that failed before its
  // kill, and must not be left running against a directory that is going away.
  await reapWaitChildren()
  rmSync(directory, { recursive: true, force: true })
})

describe("case03 restart while waiting for approval", () => {
  it("keeps the open question across a SIGKILL and settles on the answer", async () => {
    const filename = join(directory, "approval.sqlite")
    const counterFile = join(directory, "counter.log")
    writeFileSync(counterFile, "")
    const executionId = "case03-run"
    const shared = { filename, counterFile, hostId: "case03-host", executionId, mode: "approval" as const }

    const asking = spawnWaitChild({ ...shared, phase: "linger" })
    expect(await asking.parked).toBe(executionId)

    const parkedBefore = await waitingRow(filename, executionId)
    expect(parkedBefore?.reason).toBe("approval")
    expect(parkedBefore?.token).toEqual(expect.any(String))

    await killProcess(asking.process)
    expect(isAlive(asking.pid)).toBe(false)

    // The question, its reason, and its token are exactly where the dead host
    // left them.
    expect(await waitingRow(filename, executionId)).toEqual(parkedBefore)

    const answering = spawnWaitChild({ ...shared, phase: "resolve" })
    const settled = await answering.settled
    expect(await answering.exited).toBe(0)
    expect(settled).toBe(true)

    expect(await waitingRow(filename, executionId)).toBeUndefined()
    // The run's own history records the attempts, so the settlement is durable
    // rather than a value this process happened to read off a pipe.
    expect(await journalEventTypes(filename, executionId)).toContain("flows.engine.attempt-finished")
  })
})
