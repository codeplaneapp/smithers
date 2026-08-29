import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/10-telemetry-export.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** An OTLP collector stand-in: accepts every export without a network. */
const acceptingFetch: typeof globalThis.fetch = () => Promise.resolve(new Response("{}", { status: 200 }))

it.effect("exports granular spans and metrics from one added layer", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "telemetry.sqlite"), acceptingFetch)

    expect(summary.result).toBe("dist/server.tar")

    // The export is granular: flow lifecycle, engine dispatch, store
    // operations, and individual SQL statements all arrive as spans.
    expect(summary.spanNames).toContain("examples/Ship.execute")
    expect(summary.spanNames).toContain("FlowEngine.actionExecute")
    expect(summary.spanNames).toContain("ActionPersistence.execute")
    expect(summary.spanNames).toContain("RunStore.claim")
    expect(summary.spanNames).toContain("Journal.emitDurable")
    expect(summary.spanNames).toContain("sql.execute")

    expect(summary.metricNames).toContain("flows_engine_dispatches")
    expect(summary.metricNames).toContain("flows_engine_dispatch_duration")

    // The journal and the tagged metric view read the same run without the
    // collector.
    expect(summary.journalEventTypes).toContain("flows.engine.attempt-finished")
    expect(summary.successfulDispatches).toBe(1)
  }))
