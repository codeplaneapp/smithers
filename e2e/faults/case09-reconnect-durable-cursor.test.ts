/**
 * Case 9 — a reader that loses its connection resumes from a durable cursor
 * without a gap and without a duplicate.
 *
 * The cursor is the journal sequence the reader last committed, which is why it
 * survives the connection: it names a row in the server's SQLite file, not a
 * position in a socket. The case reads half a run's history, drops the socket
 * for real, reconnects with a second client, and asks for everything after the
 * last sequence it kept.
 */
import { Control } from "@smthrs/control"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type LatencyBudget, loadBudget } from "../budgets/loadBudget.ts"
import { trackingWebSocketConstructor } from "../harness/dropWebSocket.ts"
import { emitSignals, launchRun } from "../harness/servedRun.ts"
import { servedSuite } from "../harness/servedSuite.ts"

const suite = servedSuite("case09")
const budget = loadBudget<LatencyBudget>("latency")

beforeAll(() => suite.start())
afterAll(() => suite.stop())

const history = (runId: string, afterSequence?: number) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    return yield* control.watch(
      afterSequence === undefined ? { runId, follow: false } : { runId, follow: false, afterSequence }
    ).pipe(Stream.runCollect)
  })

describe("case09 reconnect from a durable cursor", () => {
  it("resumes after a dropped socket with no gap and no duplicate", async () => {
    const sockets = trackingWebSocketConstructor(suite.server().token)
    const runId = await suite.remoteWith(
      { credential: suite.server().token, sockets },
      Effect.gen(function*() {
        const run = yield* launchRun("case09")
        yield* emitSignals(run.runId, 40)
        return run.runId
      })
    )

    // First reader: takes the first half and keeps its last sequence.
    const first = await suite.remoteWith(
      { credential: suite.server().token, sockets },
      history(runId).pipe(Effect.map((events) => events.slice(0, 20)))
    )
    expect(first.length).toBe(20)
    const cursor = first[first.length - 1]!.sequence

    // The connection is genuinely cut: `terminate` drops the TCP connection
    // without a close frame, which is what a lost network does.
    const openedBefore = sockets.opened()
    expect(openedBefore).toBeGreaterThan(0)
    await sockets.dropLatest("abrupt")

    // Second reader: a new connection, told only the cursor.
    const startedAt = performance.now()
    const rest = await suite.remoteWith({ credential: suite.server().token, sockets }, history(runId, cursor))
    const elapsedMs = performance.now() - startedAt

    expect(sockets.opened()).toBeGreaterThan(openedBefore)
    expect(rest[0]?.sequence).toBe(cursor + 1)
    // Contiguous, in order, and starting exactly where the first reader stopped:
    // no sequence is repeated and none is skipped.
    expect(rest.map((event) => event.sequence)).toEqual(
      rest.map((_, index) => cursor + 1 + index)
    )
    const seen = new Set([...first, ...rest].map((event) => event.sequence))
    expect(seen.size).toBe(first.length + rest.length)
    expect(elapsedMs).toBeLessThan(budget.reconnectCursorMaxMs)
  })
})
