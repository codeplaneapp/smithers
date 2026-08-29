import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoveredFlow, main } from "../src/24-control-plane-and-gateway.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.live("plans, approves, runs, and watches a discovered flow over a loopback control server", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "gateway"))

    expect(summary.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    // The catalog a remote client reads is the project's `flows/` directory:
    // nothing in the example names this flow, the directory does.
    expect(summary.catalog).toEqual([discoveredFlow])

    // The plan card crossed the wire and decoded on the other side, carrying
    // the envelope the descriptor's own frontmatter declared.
    expect(summary.plannedFlow).toBe(discoveredFlow)
    expect(summary.plannedEnvelope).toEqual(["examples/RemoteShip"])

    // The approval gate holds over RPC exactly as it does in process.
    expect(summary.beforeApproval).toBe("Parked")
    expect(summary.afterApproval).toBe("Accepted")

    // And what reached the executor is the discovered flow, not a stand-in.
    // Once: the parked launch never reached it.
    expect(summary.launched).toEqual([discoveredFlow])

    // The run the client watches is the run the client approved. The receipt
    // named it, and it is the only run the plane knows about.
    expect(summary.watchedRunId).toBeTypeOf("string")
    expect(summary.listed).toEqual([summary.watchedRunId])
    // The executor started it, the run reached its durable wait, and the
    // executor wrote that back onto the plane's row.
    expect(summary.parked).toBe("parked")

    // And the watch replayed durable history over the WebSocket rather than
    // only forwarding what happened after the subscription opened. Both halves
    // of the chain are in one stream: the plane's decision and the engine's
    // execution of it.
    expect(summary.watched).toContain("control.run.accepted")
    expect(summary.watched).toContain("flows.engine.attempt-started")
  }), { timeout: 60_000 })
