/**
 * Case 4 — a run parked on a durable deferred survives the death of the host
 * that parked it, and the signal that arrives afterwards still lands.
 *
 * The park is real: the first host suspends the run at `DurableDeferred.await`,
 * releases its claim, and then sits there until it is `SIGKILL`ed. Nothing
 * about the wait lived in that process, which is what the assertions check —
 * the waiting row is read back over a fresh connection, and the replacement
 * host completes the deferred and drives the same execution to a result.
 */
import { isAlive, killProcess } from "@smthrs/testing/Faults"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { waitingRow } from "./harness/durableState.ts"
import { reapWaitChildren, spawnWaitChild } from "./harness/waitChild.ts"
import { preparedStep } from "./harness/waitFlows.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case04-"))
afterAll(async () => {
  // Reap first: a lingering host outlives an assertion that failed before its
  // kill, and must not be left running against a directory that is going away.
  await reapWaitChildren()
  rmSync(directory, { recursive: true, force: true })
})

const counterLines = (path: string): ReadonlyArray<string> =>
  readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0)

describe("case04 restart while waiting on an event", () => {
  it("keeps the durable wait across a SIGKILL and completes on the signal", async () => {
    const filename = join(directory, "event.sqlite")
    const counterFile = join(directory, "counter.log")
    writeFileSync(counterFile, "")
    const executionId = "case04-run"

    const parking = spawnWaitChild({
      filename,
      counterFile,
      hostId: "case04-host",
      executionId,
      mode: "event",
      phase: "linger"
    })
    expect(await parking.parked).toBe(executionId)

    // The run is parked in durable state, and the step ran exactly once.
    const parkedBefore = await waitingRow(filename, executionId)
    expect(parkedBefore?.reason).toBe("event")
    expect(counterLines(counterFile)).toEqual([preparedStep])

    // The host dies without running a finalizer.
    await killProcess(parking.process)
    expect(isAlive(parking.pid)).toBe(false)

    // The wait outlived it, byte for byte.
    const parkedAfter = await waitingRow(filename, executionId)
    expect(parkedAfter).toEqual(parkedBefore)

    // A replacement host completes the deferred and finishes the run.
    const resuming = spawnWaitChild({
      filename,
      counterFile,
      hostId: "case04-host",
      executionId,
      mode: "event",
      phase: "resolve"
    })
    const settled = await resuming.settled
    expect(await resuming.exited).toBe(0)
    expect(settled).toBe("wait:signalled")

    // Nothing is left parked, and the interrupted step re-dispatched once.
    expect(await waitingRow(filename, executionId)).toBeUndefined()
    expect(counterLines(counterFile)).toEqual([preparedStep, preparedStep])
  })
})
