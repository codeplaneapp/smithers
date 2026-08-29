// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

describe("memory engine execution surface", () => {
  effect("dies when executing a flow that was never registered", () => {
    const flow = Flow.make("Memory/unregistered", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("is not registered")
    }).pipe(Effect.provide(FlowEngine.layerMemory))
  })

  effect("fails poll for an unknown execution id with a typed not-found", () => {
    const flowActionDeclaration = Action.make("Memory/poll-none/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const flow = Flow.make("Memory/poll-none", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => Effect.void), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      // `Option.none` is reserved for a known, unsettled run; an id the
      // engine never recorded is a typed failure the caller can distinguish.
      const error = yield* Effect.flip(flow.poll("never-started"))
      expect(error).toMatchObject({
        _tag: "@smthrs/flow/FlowExecutionNotFound",
        code: "execution_not_found",
        executionId: "never-started"
      })
    }).pipe(Effect.provide(layer))
  })

  effect("discard execution returns the execution id without awaiting the result", () => {
    const flowActionDeclaration = Action.make("Memory/discard/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Memory/discard", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => Effect.succeed(7)), Interpreter.layer(flow))
      .pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(
        Layer.provideMerge(FlowEngine.layerMemory)
      )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "x" }, { executionId: "run-d", discard: true })
      expect(executionId).toBe("run-d")
      let polled = yield* flow.poll("run-d")
      while (Option.isNone(polled) || polled.value._tag !== "Complete") {
        yield* Effect.yieldNow
        polled = yield* flow.poll("run-d")
      }
      expect(polled.value._tag).toBe("Complete")
    }).pipe(Effect.provide(layer))
  })

  effect("interruptUnsafe interrupts the fiber established before discard returns", () => {
    const flowActionDeclaration = Action.make("Memory/interrupt-unsafe/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const flow = Flow.make("Memory/interrupt-unsafe", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => Effect.never), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-i", discard: true })
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.interruptUnsafe(flow, "run-i")
      const result = yield* flow.poll("run-i").pipe(Effect.exit)
      // A discard result is observable only after `resume` has installed the
      // execution fiber; unsafe interruption can therefore always target it.
      expect(Exit.isFailure(result)).toBe(true)
      expect(Exit.isFailure(result) && String(result.cause)).toContain("Interrupt")
      // interrupting an unknown id is a no-op
      yield* flow.interrupt("missing")
    }).pipe(Effect.provide(layer))
  })
})

describe("execution identity", () => {
  effect("fails a direct self-cycle with the typed cycle path", () => {
    const flow = Flow.make("Memory/self-cycle", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const layer = Interpreter.layer(flow).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const exit = yield* engine.execute(flow, {
        executionId: "self-cycle",
        payload: { id: "x" },
        discard: true
      }).pipe(
        Effect.provideService(
          FlowRuntime.FlowInstance,
          {
            executionId: "self-cycle",
            interrupted: false
          } as FlowRuntime.FlowInstance["Service"]
        ),
        Effect.exit
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(FlowRuntime.FlowCycleDetected)
      expect((failure as FlowRuntime.FlowCycleDetected).path).toEqual(["self-cycle"])
    }).pipe(Effect.provide(layer))
  })

  effect("detects a cycle through a cycle-free fan-in graph", () => {
    const flow = Flow.make("Memory/fan-in-cycle", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const layer = Interpreter.layer(flow).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const execute = (executionId: string, parentExecutionId?: string) => {
        const execution = engine.execute(flow, {
          executionId,
          payload: { id: executionId },
          discard: true
        })
        return parentExecutionId === undefined
          ? execution
          : Effect.provideService(
            execution,
            FlowRuntime.FlowInstance,
            {
              executionId: parentExecutionId,
              interrupted: false
            } as FlowRuntime.FlowInstance["Service"]
          )
      }

      yield* execute("root")
      yield* execute("left", "root")
      yield* execute("right", "root")
      yield* execute("join", "left")
      // Joining an existing run records its second parent and must not be
      // mistaken for a cycle merely because both branches reach root.
      yield* execute("join", "right")
      yield* execute("leaf", "join")

      const failure = yield* Effect.flip(execute("root", "leaf"))
      expect(failure).toBeInstanceOf(FlowRuntime.FlowCycleDetected)
      expect(failure.path).toEqual(["root", "left", "join", "leaf"])
    }).pipe(Effect.provide(layer))
  })

  // An execution id names one run of ONE flow declaration. Reusing the id
  // under a DIFFERENT declaration used to silently join the other flow's
  // fiber and answer its result under this flow's declared schemas;
  // `layerMemory.execute` now refuses the identity clash with a defect, the
  // same posture the durable driver's `ensureCreatedRun` takes for a run row
  // that belongs to a different flow tag.
  effect("refuses to reuse an execution id under a different flow declaration", () => {
    const aActionDeclaration = Action.make("Memory/reuse-a/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flowA = Flow.make("Memory/reuse-a", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => aActionDeclaration.call(payload)
    })
    const bActionDeclaration = Action.make("Memory/reuse-b/action", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flowB = Flow.make("Memory/reuse-b", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: (payload) => bActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      Layer.mergeAll(aActionDeclaration.toLayer(() => Effect.succeed(7)), Interpreter.layer(flowA)).pipe(
        Layer.provideMerge(Action.layerImplementations)
      ),
      Layer.mergeAll(bActionDeclaration.toLayer(() => Effect.succeed("b-value")), Interpreter.layer(flowB)).pipe(
        Layer.provideMerge(Action.layerImplementations)
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      expect(yield* flowA.execute({ id: "x" }, { executionId: "shared-id" })).toBe(7)
      // Without the refusal this would succeed with flowA's `7` presented as
      // flowB's declared string — the leak the refusal prevents.
      const exit = yield* flowB.execute({ id: "x" }, { executionId: "shared-id" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("already belongs to flow Memory/reuse-a")
    }).pipe(Effect.provide(layer))
  })

  effect("dedupes on the execution id alone: a second execute with another payload joins the first", () => {
    // The execution id is the run's whole identity. A caller that reuses an
    // id with a different payload gets the FIRST payload's answer back, and
    // the second payload is never planned or dispatched — id/payload
    // consistency is the caller's contract, pinned here so a change to the
    // join semantics is a deliberate decision.
    const calls: Array<string> = []
    const flowActionDeclaration = Action.make("Memory/reuse-payload/action", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("Memory/reuse-payload", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(({ id }) =>
        Effect.sync(() => {
          calls.push(id)
          return `ran:${id}`
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "first" }, { executionId: "pin-id" })).toBe("ran:first")
      expect(yield* flow.execute({ id: "second" }, { executionId: "pin-id" })).toBe("ran:first")
      expect(calls).toEqual(["first"])
    }).pipe(Effect.provide(layer))
  })
})

describe("compensable snapshot boundary", () => {
  effect("dies when a compensable action runs without a SnapshotBoundary", () => {
    const step = Action.make({
      name: "Memory/compensable-missing-boundary",
      tier: "compensable",
      success: Schema.Void,
      execute: Effect.void
    })
    const flowActionDeclaration = Action.make("Memory/compensable-missing/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const flow = Flow.make("Memory/compensable-missing", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => step), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("requires SnapshotBoundary")
    }).pipe(Effect.provide(layer))
  })

  effect("snapshots before each attempt, restores before retry, and diffs after run", () => {
    const events: Array<string> = []
    let attempts = 0
    const step = Action.make({
      name: "Memory/compensable-retry",
      tier: "compensable",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.suspend(() => {
        attempts++
        events.push(`execute:${attempts}`)
        return attempts === 1 ? Effect.fail("try-again") : Effect.succeed(attempts)
      })
    })
    const flowActionDeclaration = Action.make("Memory/compensable-retry/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Memory/compensable-retry", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const boundary = FlowEngine.SnapshotBoundary.of({
      snapshot: (options) => Effect.sync(() => (events.push(`snapshot:${options.attempt}`), "snap")),
      restore: (snapshot, options) =>
        Effect.sync(() => void events.push(`restore:${String(snapshot)}:${options.attempt}`)),
      diff: (snapshot, options) =>
        Effect.sync(() => {
          events.push(`diff:${String(snapshot)}:${options.attempt}`)
          return Option.none()
        })
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Action.retry(step, { times: 1 })),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(Layer.succeed(FlowEngine.SnapshotBoundary)(boundary))
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(2)
      expect(events).toEqual([
        "snapshot:1",
        "execute:1",
        "diff:snap:1",
        "restore:snap:2",
        "snapshot:2",
        "execute:2",
        "diff:snap:2"
      ])
    }).pipe(Effect.provide(layer))
  })

  /** One compensable wiring per fault case, sharing the same flow/action shape. */
  const compensableCase = (options: {
    readonly tag: string
    readonly boundary: {
      readonly snapshot?: (() => Effect.Effect<unknown>) | undefined
      readonly restore?: (() => Effect.Effect<void>) | undefined
      readonly diff?: (() => Effect.Effect<unknown>) | undefined
    }
    readonly execute: () => Effect.Effect<number, string>
    readonly retryTimes?: number | undefined
  }) => {
    const events: Array<string> = []
    const step = Action.make({
      name: `${options.tag}/step`,
      tier: "compensable",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.suspend(() => {
        events.push("execute")
        return options.execute()
      })
    })
    const flowActionDeclaration = Action.make(`${options.tag}/action`, {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make(options.tag, {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const boundary = FlowEngine.SnapshotBoundary.of({
      snapshot: (boundaryOptions) =>
        Effect.suspend(() => {
          events.push(`snapshot:${boundaryOptions.attempt}`)
          return options.boundary.snapshot?.() ?? Effect.succeed("snap")
        }),
      restore: (_snapshot, boundaryOptions) =>
        Effect.suspend(() => {
          events.push(`restore:${boundaryOptions.attempt}`)
          return options.boundary.restore?.() ?? Effect.void
        }),
      diff: (_snapshot, boundaryOptions) =>
        Effect.suspend(() => {
          events.push(`diff:${boundaryOptions.attempt}`)
          return options.boundary.diff?.() ?? Effect.succeed(Option.none())
        })
    })
    const dispatch = options.retryTimes === undefined
      ? step
      : Action.retry(step, { times: options.retryTimes })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => dispatch),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(Layer.succeed(FlowEngine.SnapshotBoundary)(boundary))
    )
    return { events, flow, layer }
  }

  effect("a snapshot fault surfaces as the cause and the action body never runs", () => {
    // The snapshot precedes the dispatch, so its defect must fault the
    // attempt before any side effect — and must not enter the retry ladder:
    // the boundary fault is not a typed action failure.
    const { events, flow, layer } = compensableCase({
      tag: "Memory/compensable-snapshot-fault",
      boundary: { snapshot: () => Effect.die("snapshot-broke") },
      execute: () => Effect.succeed(1),
      retryTimes: 2
    })
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run-snapshot-fault" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("snapshot-broke")
      // No dispatch, no restore, no diff, no second attempt.
      expect(events).toEqual(["snapshot:1"])
    }).pipe(Effect.provide(layer))
  })

  effect("a diff fault takes cause precedence over the action's typed failure and defeats the retry ladder", () => {
    // `diff` runs as `ensuring` cleanup of the dispatch. When it faults, the
    // boundary defect IS the cause — `Effect.ensuring` replaces the primary
    // typed failure, so `action-broke` does not survive into the exit — and
    // because the dispatch's effect no longer settles with a `Result`, the
    // retry decision point is never reached: one attempt, no backoff, no
    // re-dispatch.
    const { events, flow, layer } = compensableCase({
      tag: "Memory/compensable-diff-fault",
      boundary: { diff: () => Effect.die("diff-broke") },
      execute: () => Effect.fail("action-broke"),
      retryTimes: 3
    })
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run-diff-fault" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("diff-broke")
      // The boundary fault wins outright: the typed action failure is
      // superseded, not combined.
      expect(Exit.isFailure(exit) && String(exit.cause)).not.toContain("action-broke")
      expect(events).toEqual(["snapshot:1", "execute", "diff:1"])
    }).pipe(Effect.provide(layer))
  })

  effect("a restore fault on the retry attempt stops the sequence without re-dispatching", () => {
    // Attempt 2 restores the snapshot recorded under the action's key before
    // re-running. When restore faults, the retry stops there: the recorded
    // snapshot was consumed by exactly one restore call and the body never
    // ran a second time.
    const { events, flow, layer } = compensableCase({
      tag: "Memory/compensable-restore-fault",
      boundary: { restore: () => Effect.die("restore-broke") },
      execute: () => Effect.fail("try-again"),
      retryTimes: 2
    })
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run-restore-fault" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("restore-broke")
      // Attempt 1 ran fully; attempt 2 died at restore before snapshot or
      // dispatch.
      expect(events).toEqual(["snapshot:1", "execute", "diff:1", "restore:2"])
    }).pipe(Effect.provide(layer))
  })

  effect("forced interruption mid-attempt still runs the diff cleanup and settles as interrupted", () => {
    // Between snapshot and diff the dispatch is `Effect.ensuring`-guarded:
    // even `interruptUnsafe` — which promises no cleanup — currently tears
    // the attempt down through the ensuring finalizer, so the boundary's
    // diff observes the aborted attempt and the poll reports interruption,
    // not a result.
    const events: Array<string> = []
    const step = Action.make({
      name: "Memory/compensable-interrupt/step",
      tier: "compensable",
      success: Schema.Number,
      execute: Effect.suspend(() => {
        events.push("execute")
        return Effect.never
      })
    })
    const flowActionDeclaration = Action.make("Memory/compensable-interrupt/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Memory/compensable-interrupt", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const boundary = FlowEngine.SnapshotBoundary.of({
      snapshot: (options) => Effect.sync(() => (events.push(`snapshot:${options.attempt}`), "snap")),
      restore: () => Effect.void,
      diff: (_snapshot, options) =>
        Effect.sync(() => {
          events.push(`diff:${options.attempt}`)
          return Option.none()
        })
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => step),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(Layer.succeed(FlowEngine.SnapshotBoundary)(boundary))
    )
    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-compensable-interrupt", discard: true })
      // The attempt is provably mid-flight: snapshot taken, body entered.
      for (let index = 0; index < 50 && !events.includes("execute"); index++) {
        yield* Effect.yieldNow
      }
      expect(events).toEqual(["snapshot:1", "execute"])
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.interruptUnsafe(flow, "run-compensable-interrupt")
      const polled = yield* flow.poll("run-compensable-interrupt").pipe(Effect.exit)
      // The terminal cause is the interruption, and the diff cleanup ran
      // before it reported.
      expect(Exit.isFailure(polled)).toBe(true)
      expect(Exit.isFailure(polled) && String(polled.cause)).toContain("Interrupt")
      expect(events).toEqual(["snapshot:1", "execute", "diff:1"])
    }).pipe(Effect.provide(layer))
  })
})

describe("flow definition surface", () => {
  effect("annotate and annotateMerge attach context without changing identity", () => {
    const Marker = Context.Service<{ readonly _: "Marker" }, string>("Memory/Marker")
    const Other = Context.Service<{ readonly _: "Other" }, number>("Memory/Other")
    const flow = Flow.make("Memory/annotations", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const annotated = flow.annotate(Marker, "hello")
    const merged = annotated.annotateMerge(Context.make(Other, 4))
    return Effect.sync(() => {
      expect(annotated._tag).toBe("Memory/annotations")
      expect(Context.get(annotated.annotations as Context.Context<never>, Marker as never)).toBe("hello")
      expect(Context.get(merged.annotations as Context.Context<never>, Marker as never)).toBe("hello")
      expect(Context.get(merged.annotations as Context.Context<never>, Other as never)).toBe(4)
    })
  })

  effect("executionId falls back to the ambient source when the flow has no idempotency key", () => {
    const flow = Flow.make("Memory/no-key", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    return Effect.gen(function*() {
      // The default source derives from the tag and the payload, so a flow
      // that declares no key still names its execution.
      const first = yield* flow.executionId({ id: "x" })
      const second = yield* flow.executionId({ id: "x" })
      const other = yield* flow.executionId({ id: "y" })
      expect(first).toBe(second)
      expect(first).not.toBe(other)
      const hosted = yield* flow.executionId({ id: "x" }).pipe(
        Effect.provide(Flow.layerExecutionIds({ mint: () => Effect.succeed("host-selected") }))
      )
      expect(hosted).toBe("host-selected")
    })
  })

  effect("runs rollbacks only on failure exits", () => {
    const rolledBack: Array<string> = []
    const flowFailActionDeclaration = Action.make("Memory/rollback-fail/action", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const flowFail = Flow.make("Memory/rollback-fail", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      body: (payload) => flowFailActionDeclaration.call(payload)
    })
    const flowOkActionDeclaration = Action.make("Memory/rollback-ok/action", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flowOk = Flow.make("Memory/rollback-ok", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: (payload) => flowOkActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      Layer.mergeAll(
        flowFailActionDeclaration.toLayer(() =>
          Effect.gen(function*() {
            yield* Flow.withRollback(
              Effect.succeed("resource"),
              (value) => Effect.sync(() => void rolledBack.push(`undo:${value}`))
            )
            return yield* Effect.fail("boom")
          })
        ),
        Interpreter.layer(flowFail)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      ),
      Layer.mergeAll(
        flowOkActionDeclaration.toLayer(() =>
          Flow.withRollback(
            Effect.succeed("kept"),
            (value) => Effect.sync(() => void rolledBack.push(`undo:${value}`))
          )
        ),
        Interpreter.layer(flowOk)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const exit = yield* flowFail.execute({ id: "x" }, { executionId: "run-f" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* flowOk.execute({ id: "x" }, { executionId: "run-o" })).toBe("kept")
      expect(rolledBack).toEqual(["undo:resource"])
    }).pipe(Effect.provide(layer))
  })

  effect("addFinalizer observes the flow's final exit", () => {
    const exits: Array<string> = []
    const flowActionDeclaration = Action.make("Memory/finalizer/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Memory/finalizer", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          yield* Flow.addFinalizer((exit) => Effect.sync(() => void exits.push(exit._tag)))
          return 3
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(3)
      expect(exits).toEqual(["Success"])
    }).pipe(Effect.provide(layer))
  })

  effect("provideScope keeps scoped resources open for the flow lifetime", () => {
    const events: Array<string> = []
    const flowActionDeclaration = Action.make("Memory/scoped/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const flow = Flow.make("Memory/scoped", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Flow.provideScope(
          Effect.acquireRelease(
            Effect.sync(() => void events.push("acquire")),
            () => Effect.sync(() => void events.push("release"))
          )
        ).pipe(Effect.tap(() => Effect.sync(() => void events.push("body-done"))), Effect.asVoid)
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run" })
      expect(events[0]).toBe("acquire")
      expect(events).toContain("release")
      expect(events.indexOf("body-done")).toBeLessThan(events.indexOf("release"))
    }).pipe(Effect.provide(layer))
  })

  effect("child flow completion propagates into the parent flow", () => {
    const childActionDeclaration = Action.make("Memory/child/action", {
      payload: { n: Schema.Number },
      success: Schema.Number
    })
    const child = Flow.make("Memory/child", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      body: (payload) => childActionDeclaration.call(payload)
    })
    const parentActionDeclaration = Action.make("Memory/parent/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const parent = Flow.make("Memory/parent", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => parentActionDeclaration.call(payload)
    })
    // The parent's implementation executes the child, so the child's wiring goes
    // UNDER the parent's rather than beside it: that is what answers the child
    // flow's requirement where the parent's implementation asks for it.
    const layer = Layer.mergeAll(
      // The literal child payload always satisfies its schema, so the typed
      // SchemaError on execute cannot occur and is disposed of as a defect.
      parentActionDeclaration.toLayer(() => Effect.orDie(child.execute({ n: 1 }, { executionId: "child-run" }))),
      Interpreter.layer(parent)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(
        Layer.mergeAll(
          childActionDeclaration.toLayer((payload) => Effect.succeed(payload.n + 1)),
          Interpreter.layer(child)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations)
        )
      ),
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* parent.execute({ id: "x" }, { executionId: "parent-run" })).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("child flow failures carry their cause to the parent", () => {
    const childActionDeclaration = Action.make("Memory/child-fail/action", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      error: Schema.String
    })
    const child = Flow.make("Memory/child-fail", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => childActionDeclaration.call(payload)
    })
    const parentActionDeclaration = Action.make("Memory/parent-fail/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const parent = Flow.make("Memory/parent-fail", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => parentActionDeclaration.call(payload)
    })
    // The parent's implementation executes the child, so the child's wiring goes
    // UNDER the parent's rather than beside it: that is what answers the child
    // flow's requirement where the parent's implementation asks for it.
    const layer = Layer.mergeAll(
      parentActionDeclaration.toLayer(() => Effect.orDie(child.execute({ n: 1 }, { executionId: "child-run-f" }))),
      Interpreter.layer(parent)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(
        Layer.mergeAll(
          childActionDeclaration.toLayer(() => Effect.fail("child-broke")),
          Interpreter.layer(child)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations)
        )
      ),
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* parent.execute({ id: "x" }, { executionId: "parent-run-f" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe("child-broke")
    }).pipe(Effect.provide(layer))
  })
})
