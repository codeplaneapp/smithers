/**
 * Case 31 — a killed host leaves a real orphan, and the next incarnation reaps
 * it.
 *
 * `SIGKILL` runs no finalizer, so the process an action started keeps running
 * with nobody left to signal it: the operating system reparents it to init, and
 * that reparenting is what this case reads rather than assumes. The engine's
 * answer is the durable process ledger — every contained spawn is recorded
 * under the host's id, and the next host with that id kills what its
 * predecessor left behind before it drives anything.
 *
 * The §5.2 advisory shape lives here too: an orphan whose parent is pid 1 is
 * the observable form of "process and child-agent containment", so the case
 * fails if either the orphan never appears (the fault was not injected) or it
 * survives the reaper (the containment claim is false).
 */
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { probeEngineChild, spawnEngineChild } from "../harness/engineChild.ts"
import { isAlive, isGroupAlive, killGroup, killProcess, parentPid, waitFor, waitForReparent } from "../harness/killProcess.ts"
import { killResumeFixture } from "../harness/killResumeCase.ts"
import { firstStep, markers, secondStep } from "../harness/killResumeFlow.ts"
import { journalEventTypes } from "../harness/durableState.ts"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"

const fixture = killResumeFixture("case31", 60_000)
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }))

describe("case31 real engine kill and resume", () => {
  it("reparents the orphan to init and lets the next host reap it", async () => {
    await probeEngineChild({ ...fixture })

    const engine = spawnEngineChild({ ...fixture, mode: "execute" })
    await engine.handshake
    await waitFor(() => fixture.marker(markers.spawnedPid) !== undefined, "the contained spawn", 60_000)

    const orphan = Number(fixture.marker(markers.spawnedPid))
    expect(Number.isFinite(orphan)).toBe(true)
    expect(parentPid(orphan)).toBe(engine.pid)

    try {
      await killProcess(engine.process)
      expect(isAlive(engine.pid)).toBe(false)

      // The fault was really injected: the spawned tree outlived its host and
      // now belongs to init.
      const reparented = await waitForReparent(orphan, engine.pid, 15_000)
      expect(reparented).toBe(1)
      expect(isGroupAlive(orphan)).toBe(true)

      // The next incarnation of the same host reads the ledger, kills the group,
      // and journals the decision.
      const resumed = spawnEngineChild({ ...fixture, mode: "execute", secondSleepMs: 10 })
      expect(await resumed.exited).toBe(0)
      expect(resumed.stdout()).toContain("RESULT_STATUS=succeeded")

      await waitFor(() => !isGroupAlive(orphan), "the orphaned process group to be reaped", 30_000)
    } finally {
      killGroup(orphan)
    }

    // The durability claim, from the append-only counter the killed process
    // could not rewrite: the committed action was replayed, the interrupted one
    // re-ran.
    expect(fixture.counter()).toEqual([firstStep, secondStep, secondStep])
    expect(fixture.marker(markers.secondDone)).toBeDefined()

    // The host's own run records the spawn and the reap, in that order.
    const hostEvents = await journalEventTypes(fixture.filename, ProcessLedger.hostRunId(fixture.hostId), 64)
    expect(hostEvents).toContain("flows.host.process-spawned.v1")
    expect(hostEvents).toContain("flows.host.process-reaped.v1")
  }, 300_000)
})
