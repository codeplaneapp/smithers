/**
 * The read path's own behaviour: what it does when the control plane refuses,
 * answers something else, or keeps producing events.
 *
 * The suites beside this one run the read path against a real SQLite control
 * plane and prove the rows. These drive a stub control service instead,
 * because the branches under test are the gateway's: a listing that fails, a
 * response of the wrong shape, a subscription that must keep following, and a
 * real control plane cannot be asked to produce them on demand.
 */
import { describe, expect, it } from "@effect/vitest"
import type { Service as ControlService } from "@smthrs/control/Control"
import { PersistenceError, Unavailable } from "@smthrs/control/ControlError"
import type { ControlEvent, ListResponse, RunSummary } from "@smthrs/control/ControlSchema"
import { Effect, Schema, Stream } from "effect"
import { GatewayError } from "../src/GatewayError.ts"
import * as GatewaySchema from "../src/GatewaySchema.ts"
import * as Projections from "../src/Projections.ts"

const die = () => Effect.die("the suite does not use this operation")

const run: RunSummary = {
  runId: "run-1",
  flowId: "deploy",
  status: "waiting-approval",
  createdAt: 1,
  updatedAt: 2
}

const numberedRun = (ordinal: number): RunSummary => ({
  ...run,
  runId: `run-${ordinal}`
})

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

describe("Projections run-list pagination", () => {
  it.effect("folds workspace rows from every control-list page", () =>
    Effect.gen(function*() {
      const first = Array.from({ length: 100 }, (_, index) => numberedRun(index + 1))
      const second = [numberedRun(101)]
      let listCalls = 0
      const projections = Projections.make(control({
        list: () => {
          listCalls += 1
          return Effect.succeed(
            listCalls === 1
              ? { _tag: "runs", items: first, nextCursor: "page-2" } satisfies ListResponse
              : { _tag: "runs", items: second } satisfies ListResponse
          )
        }
      }))

      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(snapshot.rows.map((row) => (row as { readonly runId: string }).runId)).toEqual(
        [...first, ...second].map((item) => item.runId)
      )
      expect(listCalls).toBe(2)
    }))

  it.effect("stops a perpetually paginated listing at the workspace ceiling", () =>
    Effect.gen(function*() {
      let listCalls = 0
      const projections = Projections.make(control({
        list: () => {
          const page = listCalls
          listCalls += 1
          return Effect.succeed(
            {
              _tag: "runs",
              items: Array.from({ length: 100 }, (_, index) => numberedRun(page * 100 + index + 1)),
              nextCursor: `page-${page + 1}`
            } satisfies ListResponse
          )
        }
      }))

      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(Projections.maxWorkspaceRuns).toBe(500)
      expect(snapshot.rows).toHaveLength(500)
      expect(listCalls).toBe(5)
    }))

  it.effect("passes an explicit numeric limit on every run-list request", () =>
    Effect.gen(function*() {
      const limits: Array<number | undefined> = []
      const projections = Projections.make(control({
        list: (request) => {
          limits.push(request.limit)
          return Effect.succeed(
            limits.length === 1
              ? { _tag: "runs", items: [run], nextCursor: "page-2" } satisfies ListResponse
              : { _tag: "runs", items: [] } satisfies ListResponse
          )
        }
      }))

      yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(limits).toEqual([Projections.maxWorkspaceRuns, Projections.maxWorkspaceRuns - 1])
    }))

  it.effect("does not page a run-scoped lookup past its first match", () =>
    Effect.gen(function*() {
      let listCalls = 0
      const limits: Array<number | undefined> = []
      const projections = Projections.make(control({
        list: (request) => {
          listCalls += 1
          limits.push(request.limit)
          return Effect.succeed({ _tag: "runs", items: [run], nextCursor: "another-page" } satisfies ListResponse)
        }
      }))

      const snapshot = yield* projections.snapshot({ _tag: "run-summary", runId: run.runId })
      expect(snapshot.rows).toHaveLength(1)
      expect(listCalls).toBe(1)
      expect(limits).toEqual([1])
    }))

  it.effect("maps and redacts a failure from a later run-list page", () =>
    Effect.gen(function*() {
      let listCalls = 0
      const persistence = new PersistenceError({
        operation: "list runs at /private/tmp/control.db",
        message: "SQL failed on the second page",
        cause: { statement: "select secret from runs" }
      })
      const projections = Projections.make(control({
        list: () => {
          listCalls += 1
          return listCalls === 1
            ? Effect.succeed({ _tag: "runs", items: [run], nextCursor: "page-2" } satisfies ListResponse)
            : Effect.fail(persistence)
        }
      }))

      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(listCalls).toBe(2)
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Listing runs failed")
      expect(failure.cause).toEqual({ _tag: "/control/PersistenceError", code: "persistence_failed" })
      expect(JSON.stringify(failure)).not.toContain("SQL failed")
      expect(JSON.stringify(failure)).not.toContain("select secret")
      expect(JSON.stringify(failure)).not.toContain("/private/tmp")
    }))
})

describe("Projections read-path failures", () => {
  it.effect("reports a failed run listing as a gateway refusal", () =>
    Effect.gen(function*() {
      const projections = Projections.make(
        control({ list: () => Effect.fail(new Unavailable({ code: "unavailable", feature: "list", ticket: "T-1" })) })
      )
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Listing runs failed")
      expect(failure.cause).toEqual({ _tag: "/control/Unavailable", code: "unavailable" })
    }))

  it.effect("redacts a persistence failure before it reaches a caller", () =>
    Effect.gen(function*() {
      const nested = new Error("nested driver detail at /private/tmp/control.db")
      nested.cause = nested
      const persistence = new PersistenceError({
        operation: "list runs",
        message: "SQL failed while reading /private/tmp/control.db",
        cause: { nested, statement: "select secret from runs", offset: 1n }
      })
      const projections = Projections.make(control({ list: () => Effect.fail(persistence) }))

      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.cause).toEqual({ _tag: "/control/PersistenceError", code: "persistence_failed" })
      const json = JSON.stringify(failure)
      for (const privateText of ["SQL failed", "nested driver", "/private/tmp", "select secret"]) {
        expect(json).not.toContain(privateText)
      }
      expect(() => Schema.encodeUnknownSync(GatewayError)(failure)).not.toThrow()
    }))

  it.effect("carries no cause at all when the failure is not a tagged error", () =>
    Effect.gen(function*() {
      // A control plane is typed, but the wire is not: a transport that hands
      // back a string, a bare object, or nothing is still a read that failed,
      // and the client learns that much and nothing it cannot act on.
      for (
        const opaque of [
          "boom",
          { message: "boom", statement: "select secret from runs" },
          { _tag: 7 },
          null
        ]
      ) {
        const projections = Projections.make(
          control({ list: () => Effect.fail(opaque as unknown as Unavailable) })
        )
        const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
        expect(failure.code).toBe("run_unavailable")
        expect(failure.cause).toBeUndefined()
        expect(JSON.stringify(failure)).not.toContain("select secret")
      }
    }))

  it.effect("names a tagged failure that carries no code", () =>
    Effect.gen(function*() {
      const projections = Projections.make(
        control({ list: () => Effect.fail({ _tag: "/control/Mystery" } as unknown as Unavailable) })
      )
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.cause).toEqual({ _tag: "/control/Mystery" })
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

describe("Projections node output", () => {
  it.effect("answers only the node the selector named", () =>
    Effect.gen(function*() {
      const calls = [
        event(1, "control.agent.cell-call-started", { flowName: "write" }),
        event(2, "control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "wrote it" }),
        event(3, "control.agent.cell-call-started", { flowName: "read" }),
        event(4, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "read it" })
      ]
      const projections = Projections.make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () => Stream.fromIterable(calls)
      }))

      expect((yield* projections.snapshot({ _tag: "node-output", runId: "run-1", nodeId: "call-2" })).rows)
        .toMatchObject([{ nodeId: "call-2", output: "read it" }])
      // A node the run never opened is an empty answer, not a refusal: the run
      // exists, and a client asking about a node it has not seen settle yet is
      // asking a question with an answer.
      expect((yield* projections.snapshot({ _tag: "node-output", runId: "run-1", nodeId: "call-9" })).rows)
        .toEqual([])
    }))
})

describe("Projections subscriptions", () => {
  const movingLog = () => {
    let nonFollowingReads = 0
    let log: ReadonlyArray<ControlEvent> = []
    const service = control({
      list: () => Effect.succeed({ _tag: "runs", items: [run] }),
      watch: (filter) => {
        if (filter.follow !== true) {
          nonFollowingReads += 1
          log = [...log, event(log.length + 1, "control.run.accepted", { runId: "run-1" })]
          return Stream.fromIterable(log)
        }
        log = [...log, event(log.length + 1, "control.run.completed", { runId: "run-1" })]
        return Stream.fromIterable(log.filter((item) => item.sequence > (filter.afterSequence ?? 0)))
      }
    })
    return { reads: () => nonFollowingReads, service }
  }

  for (const tag of ["run-events", "run-summary", "run-tree", "transcript", "approvals"] as const) {
    it.effect(`uses one moving-log read for a ${tag} subscription`, () =>
      Effect.gen(function*() {
        const moving = movingLog()
        const projections = Projections.make(moving.service, { heartbeatMillis: 60_000 })
        const frames = yield* Stream.runCollect(projections.subscribe({ _tag: tag, runId: "run-1" }))
        const snapshotEnd = frames.find((frame) => frame._tag === "snapshot-end")
        const deltas = frames.filter((frame) => frame._tag === "delta")

        expect(moving.reads()).toBe(1)
        expect(snapshotEnd?._tag).toBe("snapshot-end")
        if (snapshotEnd?._tag !== "snapshot-end") return
        expect(deltas.length).toBeGreaterThan(0)
        expect(deltas.every((frame) => frame.cursor.value > snapshotEnd.cursor.value)).toBe(true)

        if (tag === "run-events") {
          const snapshotSequences = frames.flatMap((frame) =>
            frame._tag === "row" ? [(frame.row as ControlEvent).sequence] : []
          )
          const deltaSequences = deltas.flatMap((frame) =>
            (frame.delta as ReadonlyArray<ControlEvent>).map((item) => item.sequence)
          )
          expect(snapshotSequences.filter((sequence) => deltaSequences.includes(sequence))).toEqual([])
        }
      }))
  }

  it.effect("uses one moving-log read for a unary snapshot cursor and rows", () =>
    Effect.gen(function*() {
      const moving = movingLog()
      const snapshot = yield* Projections.make(moving.service).snapshot({ _tag: "run-events", runId: "run-1" })
      const rows = snapshot.rows as ReadonlyArray<ControlEvent>
      expect(moving.reads()).toBe(1)
      expect(snapshot.cursor.value).toBe(rows.at(-1)?.sequence)
    }))

  it.effect("reads each run's non-following log exactly once per snapshot", () =>
    Effect.gen(function*() {
      const second = { ...run, runId: "run-2" }
      const reads: Array<string> = []
      const projections = Projections.make(control({
        list: (request) => {
          const named = request._tag === "runs" ? request.filters?.runId : undefined
          return Effect.succeed(
            {
              _tag: "runs",
              items: named === undefined ? [run, second] : [run, second].filter((item) => item.runId === named)
            } satisfies ListResponse
          )
        },
        watch: (filter) => {
          if (filter.follow !== true && filter.runId !== undefined) reads.push(filter.runId)
          return Stream.empty
        }
      }))

      yield* projections.snapshot({ _tag: "run-summary", runId: "run-1" })
      expect(reads).toEqual(["run-1"])
      reads.length = 0
      yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(reads.sort()).toEqual(["run-1", "run-2"])
    }))

  it.effect("accumulates fifty run-tree deltas without re-reading history", () =>
    Effect.gen(function*() {
      const followed = Array.from({ length: 50 }, (_, index) =>
        event(index + 1, "control.agent.cell-call-started", { flowName: `call-${index + 1}` }))
      let history: ReadonlyArray<ControlEvent> = []
      let nonFollowingReads = 0
      let listCalls = 0
      const projections = Projections.make(
        control({
          list: () => {
            listCalls += 1
            return Effect.succeed({ _tag: "runs", items: [run] })
          },
          watch: (filter) => {
            if (filter.follow !== true) {
              nonFollowingReads += 1
              return Stream.fromIterable(history)
            }
            history = followed
            return Stream.fromIterable(followed)
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "run-tree", runId: "run-1" }))
      const deltas = frames.filter((frame) =>
        frame._tag === "delta"
      )
      expect(nonFollowingReads).toBe(1)
      expect(listCalls).toBe(51)
      expect(deltas).toHaveLength(50)

      const fresh = yield* projections.snapshot({ _tag: "run-tree", runId: "run-1" })
      expect(nonFollowingReads).toBe(2)
      expect(deltas.at(-1)?.delta).toEqual(fresh.rows)
    }))

  it.effect("delivers workspace deltas with the workspace cursor", () =>
    Effect.gen(function*() {
      const completed: RunSummary = { ...run, status: "completed", updatedAt: 3 }
      const planEvent: ControlEvent = {
        sequence: 1,
        kind: "control.plan.created",
        occurredAt: 1,
        payload: { planId: "plan-1" }
      }
      const changed = event(1, "control.run.completed", { runId: run.runId })
      const projections = Projections.make(
        control({
          list: (request) =>
            Effect.succeed({
              _tag: "runs",
              items: request._tag === "runs" && request.filters?.runId === run.runId ? [completed] : [run]
            }),
          watch: (filter) => filter.follow === true ? Stream.fromIterable([planEvent, changed]) : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      const delta = frames.find((frame) => frame._tag === "delta")
      // Without the unscoped follow, a dashboard keeps the snapshot's stale
      // waiting status after the control row has completed under a fence.
      expect(delta?._tag).toBe("delta")
      if (delta?._tag !== "delta") return
      expect(delta.cursor).toEqual({ projection: "workspace-runs", runId: null, value: 0 })
      expect(delta.delta).toMatchObject([{ runId: "run-1", status: "completed", verdict: "completed" }])
    }))

  it.effect("admits a newly followed run with one journal read", () =>
    Effect.gen(function*() {
      const second = { ...numberedRun(2), status: "running" } satisfies RunSummary
      const accepted: ControlEvent = {
        ...event(1, "control.run.accepted", { runId: second.runId }),
        runId: second.runId
      }
      let nonFollowingReads = 0
      const projections = Projections.make(
        control({
          list: (request) =>
            Effect.succeed({
              _tag: "runs",
              items: request._tag === "runs" && request.filters?.runId === second.runId ? [second] : []
            }),
          watch: (filter) => {
            if (filter.follow === true) return Stream.fromIterable([accepted])
            nonFollowingReads += 1
            return Stream.fromIterable([accepted])
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      const delta = frames.find((frame) => frame._tag === "delta")
      // Re-listing or re-reading the whole workspace for one new run turns a
      // live dashboard into work proportional to workspace size per event.
      expect(delta?._tag).toBe("delta")
      if (delta?._tag !== "delta") return
      expect(delta.delta).toMatchObject([{ runId: "run-2", status: "running" }])
      expect(nonFollowingReads).toBe(1)
    }))

  it.effect("suppresses the replayed workspace prefix", () =>
    Effect.gen(function*() {
      const history = [
        event(1, "control.run.accepted", { runId: run.runId }),
        event(2, "control.run.running", { runId: run.runId })
      ]
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fromIterable(history)
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      // An unscoped control follow replays every partition. Re-emitting that
      // prefix would send rows the snapshot already delivered.
      expect(frames.filter((frame) => frame._tag === "delta")).toEqual([])
    }))

  it.effect("skips an unlistable followed run without ending the workspace subscription", () =>
    Effect.gen(function*() {
      const second = { ...numberedRun(2), status: "running" } satisfies RunSummary
      const missing: ControlEvent = {
        ...event(1, "control.run.accepted", { runId: "run-missing" }),
        runId: "run-missing"
      }
      const accepted: ControlEvent = {
        ...event(1, "control.run.accepted", { runId: second.runId }),
        runId: second.runId
      }
      const projections = Projections.make(
        control({
          list: (request) =>
            Effect.succeed({
              _tag: "runs",
              items: request._tag === "runs" && request.filters?.runId === second.runId ? [second] : []
            }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable([missing, accepted])
              : filter.runId === second.runId
              ? Stream.fromIterable([accepted])
              : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      // A journal notification can race visibility in the run listing. That
      // one row must not kill the subscription before the next visible run.
      expect(deltas).toHaveLength(1)
      expect(deltas[0]?.delta).toMatchObject([{ runId: "run-2" }])
    }))

  it.effect("keeps followed workspace rows within the workspace ceiling", () =>
    Effect.gen(function*() {
      const initial = Array.from({ length: Projections.maxWorkspaceRuns }, (_, index) => numberedRun(index + 1))
      const extra = numberedRun(Projections.maxWorkspaceRuns + 1)
      const accepted: ControlEvent = {
        ...event(1, "control.run.accepted", { runId: extra.runId }),
        runId: extra.runId
      }
      const projections = Projections.make(
        control({
          list: (request) => {
            const named = request._tag === "runs" ? request.filters?.runId : undefined
            return Effect.succeed({
              _tag: "runs",
              items: named === extra.runId ? [extra] : named === undefined ? initial : []
            })
          },
          watch: (filter) =>
            filter.follow === true || filter.runId === extra.runId ? Stream.fromIterable([accepted]) : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      const rowIds = frames.flatMap((frame) =>
        frame._tag === "row" ? [(frame.row as { readonly runId: string }).runId] : []
      )
      // Admitting beyond the documented ceiling makes one long-lived stream
      // consume more journals than the bounded snapshot contract allows.
      expect(rowIds).toHaveLength(Projections.maxWorkspaceRuns)
      expect(rowIds).not.toContain(extra.runId)
      expect(frames.filter((frame) => frame._tag === "delta")).toEqual([])
    }))

  it.effect("delivers new gates to an unscoped approvals inbox", () =>
    Effect.gen(function*() {
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => filter.follow === true ? Stream.fromIterable([approvalRequested]) : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
      const delta = frames.find((frame) => frame._tag === "delta")
      // Without workspace deltas, an operator never sees a gate requested
      // after the approvals inbox snapshot was read.
      expect(delta?._tag).toBe("delta")
      if (delta?._tag !== "delta") return
      expect(delta.cursor).toEqual({ projection: "approvals", runId: null, value: 0 })
      expect(delta.delta).toMatchObject([{ runId: "run-1", requestId: "gate", status: "pending" }])
    }))

  it.effect("resumes after a run cursor without emitting snapshot frames", () =>
    Effect.gen(function*() {
      const history = [
        event(1, "control.run.accepted", { runId: "run-1" }),
        event(2, "control.run.running", { runId: "run-1" }),
        event(3, "control.run.completed", { runId: "run-1" })
      ]
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? 0)))
              : Stream.fromIterable(history)
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe(
        { _tag: "run-events", runId: "run-1" },
        { projection: "run-events", runId: "run-1", value: 1 }
      ))
      expect(frames.map((frame) => frame._tag)).toEqual(["delta", "delta"])
      expect(frames.flatMap((frame) => frame._tag === "delta" ? [frame.cursor.value] : [])).toEqual([2, 3])
      // The fold is seeded with the events up to the cursor, so a resumed
      // subscription is not a projection of the tail alone.
      expect(frames.flatMap((frame) => frame._tag === "delta" ? [frame.delta] : [])).toEqual([
        [history[1]],
        [history[2]]
      ])
    }))

  it.effect("refuses negative and fractional resume cursor values before following", () =>
    Effect.gen(function*() {
      const history = [event(1, "control.run.accepted", { runId: "run-1" })]
      let follows = 0
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => {
            if (filter.follow !== true) return Stream.fromIterable(history)
            follows += 1
            return Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? 0)))
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      for (const value of [-1, 0.5]) {
        const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(
          { _tag: "run-events", runId: "run-1" },
          { projection: "run-events", runId: "run-1", value }
        )))
        expect(failure.code).toBe("malformed_request")
        expect(failure.message).toContain(String(value))
      }
      expect(follows).toBe(0)
    }))

  it.effect("refuses a resume cursor ahead of the run's last sequence", () =>
    Effect.gen(function*() {
      const history = [
        event(1, "control.run.accepted", { runId: "run-1" }),
        event(2, "control.run.running", { runId: "run-1" })
      ]
      let follows = 0
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => {
            if (filter.follow !== true) return Stream.fromIterable(history)
            follows += 1
            return Stream.empty
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(
        { _tag: "run-events", runId: "run-1" },
        { projection: "run-events", runId: "run-1", value: 3 }
      )))
      expect(failure.code).toBe("malformed_request")
      expect(failure.message).toContain("3")
      expect(failure.message).toContain("2")
      expect(follows).toBe(0)
    }))

  it.effect("refuses a positive resume cursor for a run with no events", () =>
    Effect.gen(function*() {
      let follows = 0
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => {
            if (filter.follow === true) follows += 1
            return Stream.empty
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(
        { _tag: "run-events", runId: "run-1" },
        { projection: "run-events", runId: "run-1", value: 1 }
      )))
      expect(failure.code).toBe("malformed_request")
      expect(failure.message).toContain("1")
      expect(failure.message).toContain("0")
      expect(follows).toBe(0)
    }))

  for (
    const [name, selector, after, message] of [
      [
        "a different projection",
        { _tag: "run-events", runId: "run-1" },
        { projection: "transcript", runId: "run-1", value: 1 },
        "projection"
      ],
      [
        "a different run",
        { _tag: "run-events", runId: "run-1" },
        { projection: "run-events", runId: "run-2", value: 1 },
        "run"
      ],
      [
        "a workspace projection",
        { _tag: "workspace-runs" },
        { projection: "workspace-runs", runId: null, value: 0 },
        "workspace"
      ],
      [
        "a cursor that names no run",
        { _tag: "run-events", runId: "run-1" },
        { projection: "run-events", runId: null, value: 1 },
        "for run none"
      ]
    ] as const satisfies ReadonlyArray<
      readonly [
        string,
        GatewaySchema.ProjectionSelector,
        GatewaySchema.ProjectionCursor,
        string
      ]
    >
  ) {
    it.effect(`refuses a resume cursor for ${name}`, () =>
      Effect.gen(function*() {
        const projections = Projections.make(
          control({
            list: () => Effect.succeed({ _tag: "runs", items: [run] })
          }),
          { heartbeatMillis: 60_000 }
        )
        const failure = yield* Effect.flip(Stream.runCollect(Stream.take(projections.subscribe(selector, after), 1)))
        expect(failure.code).toBe("malformed_request")
        expect(failure.message).toContain(message)
      }))
  }

  it.live("keeps a workspace subscription open on keepalives alone", () =>
    Effect.gen(function*() {
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [] }),
          watch: (filter) => filter.follow === true ? Stream.never : Stream.empty
        }),
        { heartbeatMillis: 1 }
      )
      const frames = yield* Stream.runCollect(
        Stream.take(projections.subscribe({ _tag: "workspace-runs" }), 3)
      )
      // An empty workspace produces no delta, so the keepalive is what proves
      // its live follow remains connected while there is nothing to report.
      expect(frames.map((frame) => frame._tag)).toEqual(["snapshot-start", "snapshot-end", "heartbeat"])
      const heartbeat = frames[2]
      expect(heartbeat?._tag === "heartbeat" && typeof heartbeat.atMs).toBe("number")
    }))

  it.live("emits every declared gateway frame tag through subscriptions", () =>
    Effect.gen(function*() {
      const runFrames = yield* Stream.runCollect(
        Projections.make(
          control({
            list: () => Effect.succeed({ _tag: "runs", items: [run] }),
            watch: (filter) =>
              filter.follow === true
                ? Stream.fromIterable([event(2, "control.run.completed", { runId: "run-1" })])
                : Stream.fromIterable([approvalRequested])
          }),
          { heartbeatMillis: 60_000 }
        ).subscribe({ _tag: "run-summary", runId: "run-1" })
      )
      const workspaceFrames = yield* Stream.runCollect(Stream.take(
        Projections.make(
          control({
            list: () => Effect.succeed({ _tag: "runs", items: [] }),
            watch: (filter) => filter.follow === true ? Stream.never : Stream.empty
          }),
          { heartbeatMillis: 1 }
        ).subscribe({ _tag: "workspace-runs" }),
        3
      ))
      const emitted = new Set([...runFrames, ...workspaceFrames].map((frame) => frame._tag))
      const declared = new Set(
        GatewaySchema.GatewayFrame.members.map((member) => member.fields._tag.schema.literal)
      )
      expect(emitted).toEqual(declared)
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

  it.effect("reports a workspace follow that broke mid-stream as a gateway refusal", () =>
    Effect.gen(function*() {
      const projections = Projections.make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fail(new Unavailable({ code: "unavailable", feature: "watch", ticket: "T-4" }))
              : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )
      // A broken workspace follow must become a typed refusal. Leaving the
      // snapshot open on keepalives would silently freeze every workspace view.
      const failure = yield* Effect.flip(
        Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      )
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Following the workspace failed")
      expect(failure.cause).toEqual({ _tag: "/control/Unavailable", code: "unavailable" })
    }))
})

describe("Projections keepalive cadence", () => {
  it("stays under the relay's idle cut with margin", () => {
    // plue-consumer-contract §11: the relay drops an idle tunnel at 600 s.
    expect(Projections.heartbeatIntervalMillis).toBeLessThan(600_000 / 2)
  })
})
