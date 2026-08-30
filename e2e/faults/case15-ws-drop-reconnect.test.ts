/**
 * Case 15 — a live follower whose WebSocket is cut ends, and the reader that
 * replaces it loses nothing that happened while it was gone.
 *
 * A follow stream is the one place where "the connection is fine" is an
 * assumption rather than a fact. The case cuts the socket underneath a running
 * `watch` and then checks the two things that matter: the stream stops instead
 * of hanging forever, and the events the server committed during the outage are
 * still there for the next reader.
 */
import { Control } from "@smthrs/control"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { trackingWebSocketConstructor } from "../harness/dropWebSocket.ts"
import { emitSignals, launchRun } from "../harness/servedRun.ts"
import { servedSuite } from "../harness/servedSuite.ts"

const suite = servedSuite("case15")

beforeAll(() => suite.start(), 180_000)
afterAll(() => suite.stop())

describe("case15 WebSocket drop and reconnect", () => {
  it("ends the follow stream when the socket dies and replays the outage from the cursor", async () => {
    const sockets = trackingWebSocketConstructor(suite.server().token)
    const credential = suite.server().token

    const runId = await suite.remoteWith(
      { credential, sockets },
      Effect.gen(function*() {
        const run = yield* launchRun("case15")
        yield* emitSignals(run.runId, 5, "before")
        return run.runId
      })
    )

    // A live follower on its own connection. `follow` is the default, so this
    // stream stays open until the server or the socket ends it.
    const followed = await suite.remoteWith(
      { credential, sockets },
      Effect.gen(function*() {
        const control = yield* Control.Control
        const collected: Array<number> = []
        const follow = control.watch({ runId }).pipe(
          Stream.tap((event) => Effect.sync(() => collected.push(event.sequence))),
          Stream.runDrain
        )
        const fiber = yield* Effect.forkChild(Effect.exit(follow), { startImmediately: true })
        // Wait until the follower has caught up on committed history.
        yield* Effect.sleep(500)
        const beforeDrop = [...collected]
        yield* Effect.promise(() => sockets.dropLatest("abrupt"))
        // The stream must SETTLE. A follower that hangs on a dead socket is the
        // defect this case exists for, so the timeout is the assertion.
        const settled = yield* Effect.exit(Effect.timeout(Fiber.await(fiber), "15 seconds"))
        return { beforeDrop, settled: Exit.isSuccess(settled) }
      })
    )

    expect(followed.beforeDrop.length).toBeGreaterThan(0)
    expect(followed.settled).toBe(true)

    const cursor = followed.beforeDrop[followed.beforeDrop.length - 1]!
    const openedAfterDrop = sockets.opened()

    // The outage: more events land while nobody is following.
    await suite.remoteWith({ credential, sockets }, emitSignals(runId, 5, "during"))

    const replayed = await suite.remoteWith(
      { credential, sockets },
      Effect.gen(function*() {
        const control = yield* Control.Control
        return yield* control.watch({ runId, follow: false, afterSequence: cursor }).pipe(Stream.runCollect)
      })
    )

    expect(sockets.opened()).toBeGreaterThan(openedAfterDrop)
    expect(replayed.map((event) => event.sequence)).toEqual(
      replayed.map((_, index) => cursor + 1 + index)
    )
    expect(replayed.filter((event) => event.kind === "control.signal.delivered").length).toBeGreaterThanOrEqual(5)
  })
})
