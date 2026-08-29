/**
 * The read path's own behaviour: what it does when the control plane refuses,
 * answers something else, or keeps producing events.
 *
 * The suites beside this one run the read path against a real SQLite control
 * plane and prove the rows. These drive a stub control service instead,
 * because the branches under test are the gateway's — a listing that fails, a
 * response of the wrong shape, a subscription that must keep following — and a
 * real control plane cannot be asked to produce them on demand.
 */
import { describe, expect, it } from "@effect/vitest"
import type { Service as ControlService } from "@smthrs/control/Control"
import { Unavailable } from "@smthrs/control/ControlError"
import type { ControlEvent, ListResponse, RunSummary } from "@smthrs/control/ControlSchema"
import { Effect, Stream } from "effect"
import * as Projections from "../src/Projections.ts"

const die = () => Effect.die("the suite does not use this operation")

const run: RunSummary = {
  runId: "run-1",
  flowId: "deploy",
  status: "waiting-approval",
  createdAt: 1,
  updatedAt: 2
}

const event = (sequence: number, kind: string, payload: unknown): ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence,
  payload: payload as ControlEvent["payload"]
})

const approvalRequested = event(1, "control.approval.requested", {
  runId: "run-1",
  requestId: "gate",
  question: "Ship?",
  payload: {
    target: { _tag: "Node", runId: "run-1", requestId: "gate", digest: "d", envelope: {} },
    scope: "run",
    idempotencyKey: "k"
  }
})

/** A control service answering exactly what a test needs and nothing else. */
const control = (overrides: Partial<ControlService>): ControlService => ({
  plan: die,
  run: die,
  approve: die,
  deny: die,
  steer: die,
  signal: die,
  cancel: die,
  pause: die,
  resume: die,
  list: () => Effect.succeed({ _tag: "runs", items: [] } satisfies ListResponse),
  watch: () => Stream.empty,
  ...overrides
} as ControlService)

describe("Projections read-path failures", () => {
  it.effect("reports a failed run listing as a gateway refusal", () =>
    Effect.gen(function*() {
      const projections = Projections.make(
        control({ list: () => Effect.fail(new Unavailable({ code: "unavailable", feature: "list", ticket: "T-1" })) })
      )
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Listing runs failed")
    }))

  it.effect("reports a failed event read as a gateway refusal naming the run", () =>
    Effect.gen(function*() {
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fail(new Unavailable({ code: "unavailable", feature: "watch", ticket: "T-2" }))
        })
      )
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "run-summary", runId: "run-1" }))
      expect(failure.message).toBe("Reading the events of run-1 failed")
    }))

  it.effect("treats a listing that answered about flows as no runs at all", () =>
    Effect.gen(function*() {
      const projections = Projections.make(
        control({ list: () => Effect.succeed({ _tag: "flows", items: [] } satisfies ListResponse) })
      )
      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(snapshot.rows).toEqual([])
    }))
})

describe("Projections approvals inbox", () => {
  it.effect("collects the pending gates of every waiting run", () =>
    Effect.gen(function*() {
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fromIterable([approvalRequested])
        })
      )
      const snapshot = yield* projections.snapshot({ _tag: "approvals" })
      expect(snapshot.rows).toMatchObject([{ runId: "run-1", requestId: "gate", status: "pending" }])
      // The workspace inbox is not scoped to a run, so its cursor names none.
      expect(snapshot.cursor).toEqual({ projection: "approvals", runId: null, value: 0 })
    }))
})

describe("Projections subscriptions", () => {
  it.effect("recomputes the selector's rows on every new event", () =>
    Effect.gen(function*() {
      let follows = 0
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => {
            if (filter.follow !== true) return Stream.fromIterable([approvalRequested])
            follows += 1
            return Stream.fromIterable([event(2, "control.run.completed", { runId: "run-1" })])
          }
        }),
        { heartbeatMillis: 60_000 }
      )
      const frames = yield* Stream.runCollect(
        Stream.take(projections.subscribe({ _tag: "run-summary", runId: "run-1" }), 4)
      )
      expect(frames.map((frame) => frame._tag)).toEqual(["snapshot-start", "row", "snapshot-end", "delta"])
      expect(follows).toBe(1)
      // The delta follows from the snapshot's cursor, so nothing is replayed
      // and nothing between the two reads is skipped.
      const delta = frames[3]
      expect(delta?._tag === "delta" && delta.cursor.value).toBe(2)
    }))

  it.live("keeps a workspace subscription open on keepalives alone", () =>
    Effect.gen(function*() {
      const projections = Projections.make(
        control({ list: () => Effect.succeed({ _tag: "runs", items: [] }) }),
        { heartbeatMillis: 1 }
      )
      const frames = yield* Stream.runCollect(
        Stream.take(projections.subscribe({ _tag: "workspace-runs" }), 3)
      )
      // A workspace selector has no single event stream to follow, so after
      // the snapshot the connection is held open by keepalives and refreshed
      // by re-subscribing.
      expect(frames.map((frame) => frame._tag)).toEqual(["snapshot-start", "snapshot-end", "heartbeat"])
      const heartbeat = frames[2]
      expect(heartbeat?._tag === "heartbeat" && typeof heartbeat.atMs).toBe("number")
    }))
})

describe("Projections delta failures", () => {
  it.effect("reports a follow that broke mid-stream as a gateway refusal", () =>
    Effect.gen(function*() {
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fail(new Unavailable({ code: "unavailable", feature: "watch", ticket: "T-3" }))
              : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )
      const failure = yield* Effect.flip(
        Stream.runCollect(projections.subscribe({ _tag: "run-summary", runId: "run-1" }))
      )
      expect(failure.message).toBe("Following run-1 failed")
    }))
})

describe("Projections keepalive cadence", () => {
  it("stays under the relay's idle cut with margin", () => {
    // plue-consumer-contract §11: the relay drops an idle tunnel at 600 s.
    expect(Projections.heartbeatIntervalMillis).toBeLessThan(600_000 / 2)
  })
})
