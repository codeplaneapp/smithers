import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import { main } from "../src/38-monitor-and-alert.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.effect("monitors a real parked run, heals it, and pages once about it", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "monitor.sqlite"))

    // A park is a wait, not a wedge: the run whose approval arrived came back
    // and finished with the value that resolved it.
    expect(summary.answered).toEqual({ approved: true })

    // The unanswered run is parked on the engine, and the control plane reads
    // the waiting reason the engine wrote on its row.
    expect(summary.parked).toBe("parked")
    expect(summary.waitingFor).toBe("event")

    // Three beats build the stall; the fourth classifies it. An attempt is
    // open — the wait point started and never settled — so it is a wedged
    // node rather than a bare stall.
    expect(summary.beats).toEqual(["healthy", "healthy", "healthy", "wedged-node"])
    expect(summary.healed).toBe("resume")

    // A production delay pages about nothing: the condition is seconds old.
    expect(summary.quiet).toBe(0)
    expect(summary.paged).toEqual(["wedged-node"])
    // The second tick suppresses: a delivered alert is not delivered again.
    expect(summary.repaged).toBe(0)
    // One coalesced system event is queued for the run, keyed on the run and
    // the condition, so a second wedge on the same run replaces it rather than
    // stacking behind it.
    expect(summary.pending).toEqual(["examples-supervised:wedged-node"])
  }))
