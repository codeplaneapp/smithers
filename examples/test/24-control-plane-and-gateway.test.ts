import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoveredFlow, main, watchedRunId } from "../src/24-control-plane-and-gateway.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.live("plans, approves, runs, and watches a discovered flow over a loopback control server", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "gateway.sqlite"))

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
    expect(summary.launched).toEqual([discoveredFlow])

    // The engine's own parked run is visible to a client that never started it.
    expect(summary.listed).toContain(watchedRunId)
    expect(summary.parked).toBe("parked")

    // And the watch replayed durable history over the WebSocket rather than
    // only forwarding what happened after the subscription opened.
    expect(summary.watched.length).toBeGreaterThan(0)
  }), { timeout: 60_000 })
