/**
 * Case 6 — two hosts reach for the same abandoned run at once, and only one of
 * them drives it.
 *
 * This is the shape a stale-run sweep and an operator's resume produce together:
 * the run's owner is gone, its claim is free, and two processes decide
 * independently that they should pick it up. The engine's answer is
 * join-or-claim — one takes the claim and the other either joins the result or
 * loses the fence — and the invariant underneath it is that the step runs once
 * more, not twice.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { journalEventTypes, waitingRow } from "../harness/durableState.ts"
import { killProcess } from "../harness/killProcess.ts"
import { spawnWaitChild } from "../harness/waitChild.ts"
import { preparedStep } from "../harness/waitFlows.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case06-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const counterLines = (path: string): ReadonlyArray<string> =>
  readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0)

describe("case06 concurrent resume against a sweep", () => {
  it("admits exactly one driver and never re-runs the step twice", async () => {
    const filename = join(directory, "race.sqlite")
    const counterFile = join(directory, "counter.log")
    writeFileSync(counterFile, "")
    const executionId = "case06-run"
    const shared = { filename, counterFile, executionId, mode: "event" as const }

    const parking = spawnWaitChild({ ...shared, hostId: "case06-owner", phase: "linger" })
    expect(await parking.parked).toBe(executionId)
    expect(counterLines(counterFile)).toEqual([preparedStep])
    await killProcess(parking.process)
    expect((await waitingRow(filename, executionId))?.reason).toBe("event")

    // The wait is satisfied once, by a host that drives nothing, so the two
    // hosts below race for the claim rather than for the signal.
    const notifier = spawnWaitChild({ ...shared, hostId: "case06-notifier", phase: "notify" })
    expect(await notifier.exited).toBe(0)

    // Two independent hosts, started together, each believing the run is theirs
    // to pick up.
    const left = spawnWaitChild({ ...shared, hostId: "case06-resume", phase: "settle" })
    const right = spawnWaitChild({ ...shared, hostId: "case06-sweep", phase: "settle" })

    const [leftCode, rightCode] = await Promise.all([left.exited, right.exited])
    const settlements = [
      leftCode === 0 ? await left.settled.catch(() => undefined) : undefined,
      rightCode === 0 ? await right.settled.catch(() => undefined) : undefined
    ].filter((value) => value !== undefined)

    // At least one host drove the run to a result, and every host that reported
    // one reported the same result.
    expect(settlements.length).toBeGreaterThanOrEqual(1)
    for (const settlement of settlements) expect(settlement).toBe("wait:signalled")

    // The invariant: the parked step ran once before the crash and at most once
    // after it. Two concurrent drivers must not both dispatch it.
    expect(counterLines(counterFile)).toEqual([preparedStep, preparedStep])
    expect(await waitingRow(filename, executionId)).toBeUndefined()

    const events = await journalEventTypes(filename, executionId)
    expect(events.filter((type) => type === "flows.engine.deferred-completed")).toHaveLength(1)
  }, 180_000)
})
