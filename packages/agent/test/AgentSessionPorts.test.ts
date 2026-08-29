/**
 * The two executor ports that have to reach the engine to mean anything.
 *
 * `Control.cancel` and `Control.signal` are control-plane records until
 * something writes them onto the engine. `AgentSession` is the production
 * `ControlExecutor`, so it is where that happens: a cancel becomes
 * `cancel_requested_at_ms` on the engine row — durable, and readable by
 * whichever process owns the run — and a signal completes the `WaitFor` wait
 * point the parked run declared, through the ordinary
 * `DurableDeferred.succeed` path.
 *
 * Everything here runs against the real durable engine over real SQLite. The
 * ports read and write engine rows, and a double for those rows would prove the
 * shape of a fixture rather than the behavior of a store.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { PersistenceError } from "@smthrs/control/ControlError"
import * as ControlRuntimeModule from "@smthrs/control/ControlRuntime"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { Envelope, Principal } from "@smthrs/control/ControlSchema"
import { FlowEngine } from "@smthrs/engine"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, Interpreter, WaitFor } from "@smthrs/flow"
import * as Jj from "@smthrs/kernel/Jj"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Clock, Effect, Exit, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }
const principal: Principal = { id: "operator", kind: "test", stampedAt: 0 }

/** One step before the wait, so the wake replays a settled prefix. */
const Mark = Action.make("agent/test/ports/mark", { payload: {}, success: Schema.String })

const Gated = Flow.make("agent/test/ports/gated", {
  payload: { name: Schema.String },
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: ({ name }) =>
    Mark.call({}).pipe(
      Node.andThen(() => WaitFor.action.call({ name }))
    )
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "agent-session-ports" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/**
 * The production durable engine over one in-memory SQLite database, with the
 * stores kept in the output because the ports read them.
 */
const stack = Layer.mergeAll(
  Mark.toLayer(() => Effect.succeed("before")),
  WaitFor.layer,
  Interpreter.layer(Gated),
  ControlRuntimeModule.layerMemory({
    flows: [{ flowId: "system/test", description: "Reserved test system flow", deployClass: false, envelope }]
  })
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(
    EngineStore.layer({
      owner: { hostId: "agent-session-ports" },
      journalSource: "agent-session-ports",
      isAlive: () => Effect.succeed(false)
    })
  ),
  Layer.provideMerge(StepBoundary.layerTest()),
  // `layerAt` rather than `layer`: it keeps `DurableEngineState` in the
  // output, and the signal bridge reads the waiting row through it.
  Layer.provideMerge(TestStores.layerAt(":memory:")),
  Layer.provideMerge(Layer.merge(Layer.succeed(Jj.Jj)(jj), NodeCrypto.layer))
)

const run = <A, E, R>(body: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(body, stack as unknown as Layer.Layer<R>).pipe(Effect.scoped, Effect.orDie)
  )

/** Plans, approves, and launches one control run through the port itself. */
const startControlRun = Effect.gen(function*() {
  const runtime = yield* ControlRuntime
  const card = yield* runtime.plan({ flowId: "system/test", input: { suite: "ports" } })
  const token = yield* runtime.lookupApproval(card.approval.target)
  yield* runtime.installBulkGrant(token, card.envelope, "run")
  yield* runtime.resolveApproval(token, "approved", principal)
  const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
  if (launched._tag !== "Started") return yield* Effect.die("expected a started run")
  return launched.run.runId
})

/** Starts the gated flow and returns once the engine has parked it. */
const parkedRun = (runId: string, name: string) =>
  Effect.gen(function*() {
    yield* Gated.execute({ name }, { executionId: runId, discard: true })
    const state = yield* DurableEngineState.DurableEngineState
    const waiting = yield* state.waiting(runId)
    if (Option.isNone(waiting)) return yield* Effect.die(`run ${runId} did not park`)
    return waiting.value
  })

/** The run's store status right now, without waiting for it to move. */
const statusOf = (runId: string): Effect.Effect<string, unknown, RunStore.RunStore> =>
  Effect.map(Effect.flatMap(RunStore.RunStore, (store) => store.get(runId)), (row) => row.status)

/** Polls the run row until it leaves `suspended`, or gives up and reports it. */
const settled = (runId: string, attempts = 2_000): Effect.Effect<string, unknown, RunStore.RunStore> =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const row = yield* store.get(runId)
    if (row.status !== "suspended" || attempts <= 0) return row.status
    yield* Effect.yieldNow
    return yield* settled(runId, attempts - 1)
  })

describe("AgentSession.requestCancel", () => {
  it("records the cancellation on the engine row", async () => {
    const observed = await run(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* parkedRun("ports-cancel", "approval")
      const before = yield* store.get("ports-cancel")

      const first = yield* AgentSession.requestCancel({ runId: "ports-cancel" })
      const after = yield* store.get("ports-cancel")
      // First-writer-wins: a second ask from a second process is not an error.
      const again = yield* AgentSession.requestCancel({ runId: "ports-cancel" })
      return { first, again, before, after, repeated: yield* store.get("ports-cancel") }
    }))

    expect(observed.before.cancelRequestedAtMs).toBeNull()
    expect(observed.first).toBe("recorded")
    expect(observed.after.cancelRequestedAtMs).not.toBeNull()
    expect(observed.again).toBe("recorded")
    expect(observed.repeated.cancelRequestedAtMs).toBe(observed.after.cancelRequestedAtMs)
  })

  it("reports a settled engine row as terminal, and records nothing on it", async () => {
    const observed = await run(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* parkedRun("ports-cancel-terminal", "approval")
      // Settle the run through the engine itself, so the terminal row is the
      // one the engine actually writes rather than a fixture.
      yield* AgentSession.deliverSignal({
        runId: "ports-cancel-terminal",
        signal: { name: "approval", payload: { approved: true } }
      })
      const status = yield* settled("ports-cancel-terminal")

      const record = yield* AgentSession.requestCancel({ runId: "ports-cancel-terminal" })
      return { status, record, row: yield* store.get("ports-cancel-terminal") }
    }))

    expect(observed.status).toBe("completed")
    // Not "recorded": nothing can act on a cancellation of a finished run, and
    // answering "recorded" let `Control.cancel` write a terminal control status
    // the engine row does not have (triage B-11).
    expect(observed.record).toEqual({ _tag: "Terminal", status: "completed" })
    expect(observed.row.cancelRequestedAtMs).toBeNull()
  })

  it("reports a run the engine never heard of as unknown, not as a failure", async () => {
    const observed = await run(AgentSession.requestCancel({ runId: "ports-absent" }))
    expect(observed).toBe("unknown")
  })

  it("records a cancellation against a clock the row can carry", async () => {
    const observed = await run(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* parkedRun("ports-cancel-clock", "approval")
      const at = yield* Clock.currentTimeMillis
      yield* AgentSession.requestCancel({ runId: "ports-cancel-clock" })
      const row = yield* store.get("ports-cancel-clock")
      return { at, requested: row.cancelRequestedAtMs }
    }))

    expect(observed.requested).toBeGreaterThanOrEqual(observed.at)
  })
})

describe("AgentSession.deliverSignal", () => {
  it("completes the wait point the parked run declared and settles the run", async () => {
    const observed = await run(Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      yield* parkedRun("ports-signal", "approval")

      const delivery = yield* AgentSession.deliverSignal({
        runId: "ports-signal",
        signal: { name: "approval", payload: { approved: true } }
      })
      return {
        delivery,
        status: yield* settled("ports-signal"),
        stillWaiting: yield* state.waiting("ports-signal"),
        result: yield* Gated.poll("ports-signal")
      }
    }))

    expect(observed.delivery).toBe("delivered")
    expect(observed.status).toBe("completed")
    expect(Option.isNone(observed.stillWaiting)).toBe(true)
    // The node settles with the value that resolved the wait.
    const settledValue = Option.isSome(observed.result) && observed.result.value._tag === "Complete" &&
        Exit.isSuccess(observed.result.value.exit)
      ? observed.result.value.exit.value
      : undefined
    expect(settledValue).toEqual({ approved: true })
  })

  it("refuses a signal that names a different wait point", async () => {
    const observed = await run(Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      yield* parkedRun("ports-signal-other", "approval")
      const delivery = yield* AgentSession.deliverSignal({
        runId: "ports-signal-other",
        signal: { name: "shipped", payload: null }
      })
      return { delivery, stillWaiting: yield* state.waiting("ports-signal-other") }
    }))

    expect(observed.delivery).toBe("no-match")
    // Nothing was completed, so the run is exactly where it was.
    expect(Option.isSome(observed.stillWaiting)).toBe(true)
  })

  it("reports a run with no open wait point as unknown", async () => {
    const observed = await run(
      AgentSession.deliverSignal({ runId: "ports-signal-absent", signal: { name: "approval", payload: null } })
    )
    expect(observed).toBe("unknown")
  })
})

describe("AgentSession.drainRecordedSignals", () => {
  it("delivers a signal recorded while no executor was running", async () => {
    const observed = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const runId = yield* startControlRun
      yield* parkedRun(runId, "approval")
      // What `Control.signal` writes when no executor can deliver it.
      yield* runtime.deliverSignal(runId, { name: "approval", payload: { approved: true } })
      const beforeDrain = yield* statusOf(runId)

      yield* AgentSession.drainRecordedSignals
      return { beforeDrain, status: yield* settled(runId) }
    }))

    expect(observed.beforeDrain).toBe("suspended")
    expect(observed.status).toBe("completed")
  })

  it("leaves a run whose recorded signal names another wait point parked", async () => {
    const observed = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const state = yield* DurableEngineState.DurableEngineState
      const runId = yield* startControlRun
      yield* parkedRun(runId, "approval")
      yield* runtime.deliverSignal(runId, { name: "shipped", payload: null })

      yield* AgentSession.drainRecordedSignals
      const store = yield* RunStore.RunStore
      return { status: (yield* store.get(runId)).status, waiting: yield* state.waiting(runId) }
    }))

    expect(observed.status).toBe("suspended")
    expect(Option.isSome(observed.waiting)).toBe(true)
  })
})

/** A durable state whose one run is parked exactly as the case describes. */
const waitingAs = (reason: string, token: string | null) =>
  Layer.succeed(DurableEngineState.DurableEngineState)({
    ...DurableEngineState.makeMemory(),
    waiting: (runId: string) => Effect.succeedSome({ runId, reason, wakeAt: null, token })
  } as DurableEngineState.Service)

describe("the ports when a store answers badly", () => {
  it("reports an engine that cannot record the cancellation as a typed failure", async () => {
    const failing = RunStore.layerNoop({
      requestCancel: () =>
        Effect.fail(
          new RunStore.RunStoreError({
            method: "requestCancel",
            code: "persistence_failed",
            message: "the disk went away",
            cause: undefined
          })
        )
    })
    const failure = await Effect.runPromise(
      Effect.flip(AgentSession.requestCancel({ runId: "ports-store-down" })).pipe(Effect.provide(failing))
    )

    expect(failure).toBeInstanceOf(PersistenceError)
    expect((failure as PersistenceError).operation).toBe("AgentSession.requestCancel")
  })

  it("refuses a signal to a run parked on something a signal cannot supply", async () => {
    const observed = await Effect.runPromise(
      Effect.all([
        // An approval park: waiting for a person, not for a message.
        AgentSession.deliverSignal({ runId: "ports-approval", signal: { name: "approval", payload: null } }).pipe(
          Effect.provide(Layer.merge(waitingAs("approval", null), FlowEngine.layerMemory))
        ),
        // An event park with no token: nothing names a wait point to complete.
        AgentSession.deliverSignal({ runId: "ports-tokenless", signal: { name: "approval", payload: null } }).pipe(
          Effect.provide(Layer.merge(waitingAs("event", null), FlowEngine.layerMemory))
        )
      ]).pipe(Effect.scoped)
    )

    expect(observed).toEqual(["no-match", "no-match"])
  })

  it("reports a corrupt wake token as a typed failure rather than parking forever", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        AgentSession.deliverSignal({ runId: "ports-corrupt", signal: { name: "approval", payload: null } })
      ).pipe(
        Effect.provide(Layer.merge(waitingAs("event", "not-a-durable-deferred-token"), FlowEngine.layerMemory)),
        Effect.scoped
      )
    )

    expect(failure).toBeInstanceOf(PersistenceError)
    expect((failure as PersistenceError).operation).toBe("AgentSession.deliverSignal")
  })
})
