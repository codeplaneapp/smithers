import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/18-approval-and-signal.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.effect("gates a launch on a plan approval and ends a durable wait with a signal", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "ship.sqlite"))

    // A pending plan parks the launch rather than starting it.
    expect(summary.plan.beforeApproval).toBe("Parked")
    expect(summary.plan.beforeApprovalStatus).toBe("waiting-approval")
    // The same call launches once the reviewed digest is approved.
    expect(summary.plan.afterApproval).toBe("Accepted")
    expect(summary.plan.decision).toBe("approved")
    expect(summary.plan.launches).toBe(1)
    // A denied plan refuses the launch instead of parking it.
    expect(summary.plan.deniedDecision).toBe("denied")
    expect(summary.plan.deniedLaunch).toBe("/control/ClaimLost")

    // The first drive parked INSIDE the run, on the token the clearance step
    // registered for itself. `approval` rather than `event`: the run is waiting
    // for a person, not for a fact to arrive.
    expect(summary.run.firstPark).toBe("parked")
    expect(summary.run.firstWaitingFor).toBe("approval")

    // The step ran twice and read the token both times: unresolved on the
    // drive that parked, resolved on the drive after an operator decided. It
    // did not run a third time, because by then its result was recorded.
    expect(summary.run.clearanceReads).toEqual([false, true])

    // The run parked again after the gate opened, this time on its signal.
    expect(summary.run.parked).toBe("parked")
    expect(summary.run.waitingFor).toBe("event")

    // The in-run approval resolved exactly once and is durable.
    expect(summary.run.approvalReceipt).toBe("Accepted")
    expect(summary.run.approvalResolved).toBe(true)
    expect(summary.run.approvals).toEqual(["Node"])

    // The signal is a recorded fact; the host is what turned it into a
    // completed wait point.
    expect(summary.run.signals).toEqual(["ship"])
    expect(summary.run.delivered).toEqual(["ship"])
    expect(summary.run.result).toEqual({ approved: true, by: "release-manager" })
  }), { timeout: 60_000 })
