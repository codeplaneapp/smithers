/**
 * The trampoline on the in-memory engine: a counter that reaches its target by
 * handing off, the derived round identity underneath it, the round budget, and
 * what a handoff to a flow this engine has never been told about does.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const Increment = Action.make("trampoline/increment", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

/** The declaration shape every counter in this suite shares. */
type CounterFlow = Flow.Flow<
  string,
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never,
  // `.to()` drops the callee's requirements, so a lineage that hands off to
  // itself names only what one round calls and the type stays finite.
  Action.Requirement<"trampoline/increment">
>

/**
 * The declarations a body reaches for by tag. A recursive `.to()` needs the
 * flow inside its own body, which the declaration expression cannot name yet.
 */
const flows = new Map<string, CounterFlow>()

/** A counter that reaches its target one round at a time. */
const counter = (tag: string, maxRounds?: number): CounterFlow =>
  Flow.make(tag, {
    payload: { value: Schema.Number, target: Schema.Number },
    success: Schema.Number,
    ...(maxRounds === undefined ? {} : { maxRounds }),
    body: ({ target, value }: { readonly value: number; readonly target: number }) =>
      Increment.call({ value }).pipe(
        Node.branch({
          if: (next) => next >= target,
          then: (next) => Flow.done(next),
          else: (next) => flows.get(tag)!.to({ value: next, target })
        })
      )
  })

const declare = (tag: string, maxRounds?: number) => {
  const flow = counter(tag, maxRounds)
  flows.set(tag, flow)
  return flow
}

const Counter = declare("trampoline/counter")
const Bounded = declare("trampoline/bounded", 2)
const Single = declare("trampoline/single-round", 1)
const UnboundedTarget = Flow.make("trampoline/unbounded-target", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Increment.call({ value })
})
const OriginBounded = Flow.make("trampoline/origin-bounded", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  maxRounds: 1,
  body: ({ value }) => UnboundedTarget.to({ value })
})
const ParentActionDeclaration = Action.make("trampoline/parent/action", {
  payload: { target: Schema.Number },
  success: Schema.Number
})
const Parent = Flow.make("trampoline/parent", {
  payload: { target: Schema.Number },
  success: Schema.Number,
  body: (payload) => ParentActionDeclaration.call(payload)
})

/** Every increment the lineage dispatched, in order. */
type Registration =
  | Layer.Layer<never, never, unknown>
  | Layer.Layer<Action.Implementations | Action.Requirement<"trampoline/parent/action">, never, unknown>

const wire = <const Registrations extends ReadonlyArray<Registration>>(...registrations: Registrations) => {
  const calls: Array<number> = []
  // The increment goes UNDER the registrations rather than beside them: a
  // registration whose implementation executes a counter asks for it, and a
  // sibling layer answers nobody.
  const layer = Layer.mergeAll(Layer.empty, ...registrations).pipe(
    Layer.provideMerge(
      Increment.toLayer(({ value }) =>
        Effect.sync(() => {
          calls.push(value)
          return value + 1
        })
      )
    ),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )
  return { calls, layer }
}

describe("FlowEngine.Round", () => {
  it("starts a lineage at ordinal zero under the caller's execution id", () => {
    expect(FlowEngine.Round.initial("run-a")).toEqual({ lineageId: "run-a", ordinal: 0 })
  })

  it.effect("derives the same execution id for the same (lineage, ordinal), and different ids otherwise", () =>
    Effect.gen(function*() {
      const [first, again, later, other] = yield* withCrypto(
        Effect.all([
          FlowEngine.Round.executionId({ lineageId: "run-a", ordinal: 1 }),
          FlowEngine.Round.executionId({ lineageId: "run-a", ordinal: 1 }),
          FlowEngine.Round.executionId({ lineageId: "run-a", ordinal: 2 }),
          FlowEngine.Round.executionId({ lineageId: "run-b", ordinal: 1 })
        ])
      )

      expect(first).toBe(again)
      expect(first).not.toBe(later)
      expect(first).not.toBe(other)
      expect(first).toMatch(/^[0-9a-f]{64}$/)
    }))

  it.effect("advances within an unbounded lineage and within a budget that has room", () =>
    Effect.gen(function*() {
      const unbounded = yield* withCrypto(
        FlowEngine.Round.next({ lineageId: "run-a", ordinal: 0 }, {
          flowName: "f",
          maxRounds: undefined
        })
      )
      expect(unbounded.round).toEqual({ lineageId: "run-a", ordinal: 1 })

      const bounded = yield* withCrypto(
        FlowEngine.Round.next({ lineageId: "run-a", ordinal: 0 }, { flowName: "f", maxRounds: 2 })
      )
      expect(bounded.round.ordinal).toBe(1)
    }))

  it.effect("refuses the round that would spend one past the budget", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.exit(
          FlowEngine.Round.next({ lineageId: "run-a", ordinal: 1 }, { flowName: "f", maxRounds: 2 })
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
      expect(error).toBeInstanceOf(Flow.MaxRoundsExceeded)
      expect(error instanceof Flow.MaxRoundsExceeded && error.roundOrdinal).toBe(2)
    }))

  it.effect("refuses the first advance under a zero and under a negative budget", () =>
    Effect.gen(function*() {
      // The budget arithmetic is `advanced.ordinal >= budget`, so 0 and any
      // negative value refuse ordinal 1 — the first advance a lineage can ask
      // for. Round 0 itself is out of `next`'s reach by construction: it is the
      // caller's own execution and no advance mints it.
      const zero = yield* withCrypto(
        Effect.exit(
          FlowEngine.Round.next({ lineageId: "run-a", ordinal: 0 }, { flowName: "f", maxRounds: 0 })
        )
      )
      const negative = yield* withCrypto(
        Effect.exit(
          FlowEngine.Round.next({ lineageId: "run-a", ordinal: 0 }, { flowName: "f", maxRounds: -1 })
        )
      )

      for (const exit of [zero, negative]) {
        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
        expect(error).toBeInstanceOf(Flow.MaxRoundsExceeded)
        expect(error instanceof Flow.MaxRoundsExceeded && error.roundOrdinal).toBe(1)
      }
      const zeroError = Exit.isFailure(zero) ? zero.cause.reasons.find(Cause.isFailReason)?.error : undefined
      expect(zeroError instanceof Flow.MaxRoundsExceeded && zeroError.maxRounds).toBe(0)
    }))
})

describe("a lineage on the memory engine", () => {
  it.effect("tracks nested registrations of the same declaration independently", () =>
    Effect.gen(function*() {
      yield* withCrypto(
        Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          yield* Effect.scoped(
            Effect.gen(function*() {
              yield* runtime.register(Counter, () => Effect.succeed(0))
              yield* Effect.scoped(runtime.register(Counter, () => Effect.succeed(0)))
            })
          )
        }).pipe(Effect.provide(FlowEngine.layerMemory))
      )
    }))

  it.effect("counts to its target across rounds and answers with the lineage's value", () =>
    Effect.gen(function*() {
      const { calls, layer } = wire(Interpreter.layer(Counter))

      const value = yield* withCrypto(
        Counter.execute({ value: 0, target: 3 }, { executionId: "memory-lineage" }).pipe(
          Effect.provide(layer)
        )
      )

      // One increment per round, and the caller sees only the final answer.
      expect(value).toBe(3)
      expect(calls).toEqual([0, 1, 2])
    }))

  it.effect("fails the lineage with the typed refusal once the round budget is spent", () =>
    Effect.gen(function*() {
      const { calls, layer } = wire(Interpreter.layer(Bounded))

      const exit = yield* withCrypto(
        Bounded.execute({ value: 0, target: 99 }, { executionId: "memory-bounded" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("MaxRoundsExceeded")
      // Two rounds ran — ordinals 0 and 1 — and the third was refused before it
      // could dispatch anything.
      expect(calls).toEqual([0, 1])
    }))

  it.effect("keeps the origin flow's budget across a handoff to another declaration", () =>
    Effect.gen(function*() {
      const { calls, layer } = wire(
        Interpreter.layer(OriginBounded),
        Interpreter.layer(UnboundedTarget)
      )

      const exit = yield* withCrypto(
        OriginBounded.execute({ value: 0 }, { executionId: "memory-origin-budget" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("MaxRoundsExceeded")
      expect(calls).toEqual([])
    }))

  it.effect("follows every round of a lineage executed from a parent flow", () =>
    Effect.gen(function*() {
      const { calls, layer } = wire(
        Interpreter.layer(Counter),
        Layer.mergeAll(
          // The constructed child payload always satisfies its schema, so the
          // typed SchemaError on execute cannot occur and is disposed of as a
          // defect.
          ParentActionDeclaration.toLayer(({ target }) =>
            Effect.orDie(Counter.execute({ value: 0, target }, { executionId: "memory-child-lineage" }))
          ),
          Interpreter.layer(Parent)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations)
        )
      )

      const value = yield* withCrypto(
        Parent.execute({ target: 3 }, { executionId: "memory-parent" }).pipe(
          Effect.provide(layer)
        )
      )

      expect(value).toBe(3)
      expect(calls).toEqual([0, 1, 2])
    }))

  it("refuses zero, negative, and fractional round budgets at declaration time", () => {
    // The round-budget contract starts at 1: `maxRounds: 1` means "no handoff
    // at all" and the engine never has to interpret a budget that promises
    // less than the caller's own execution. Invalid budgets are refused where
    // the declaration is written, so `Round.next`'s `>= budget` arithmetic
    // only ever defends against drivers that bypass `Flow.make`.
    expect(() => counter("trampoline/budget-zero", 0)).toThrow(RangeError)
    expect(() => counter("trampoline/budget-negative", -1)).toThrow(RangeError)
    expect(() => counter("trampoline/budget-fraction", 1.5)).toThrow(RangeError)
  })

  it.effect("runs round 0 in full under the smallest legal budget and refuses its first handoff", () =>
    Effect.gen(function*() {
      // `maxRounds: 1` bounds HANDOFFS, not the caller's own execution: round 0
      // is the execution the caller asked for, so its work runs — the budget is
      // only consulted when the settled round asks to open round 1.
      const { calls, layer } = wire(Interpreter.layer(Single))

      const exit = yield* withCrypto(
        Single.execute({ value: 0, target: 99 }, { executionId: "memory-single-round" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("MaxRoundsExceeded")
      // Round 0 dispatched its increment before the refusal; round 1 never ran.
      expect(calls).toEqual([0])
    }))

  it.effect("refuses a handoff to a flow the engine was never told about", () =>
    Effect.gen(function*() {
      const Stranger = Flow.make("trampoline/stranger", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: () => Node.succeed(0)
      })
      const Orphan = Flow.make("trampoline/orphan", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => Stranger.to({ value })
      })
      const { layer } = wire(Interpreter.layer(Orphan))

      const exit = yield* withCrypto(
        Orphan.execute({ value: 1 }, { executionId: "memory-orphan" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("is not registered with this engine")
    }))

  // `layerMemory.register` keeps a per-tag stack with a scope-aware restore,
  // mirroring `make.register`'s declaration table: a closed inner
  // registration is spliced back out, so executions land on the still-open
  // outer registration — and in its still-open scope — rather than on a
  // stale entry whose closed scope would interrupt the round fiber at fork.
  it.effect("serves the outer registration after an inner scoped registration of the same tag closes", () =>
    Effect.gen(function*() {
      yield* withCrypto(
        Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          yield* Effect.scoped(
            Effect.gen(function*() {
              yield* runtime.register(Counter, () => Effect.succeed(1))
              yield* Effect.scoped(runtime.register(Counter, () => Effect.succeed(2)))
              // The inner scope is closed; the outer registration must serve
              // this execution.
              yield* runtime.execute(Counter, {
                executionId: "memory-scoped-lifetime",
                payload: { value: 0, target: 1 },
                discard: true
              })
              let polled: Exit.Exit<
                Option.Option<Flow.Result<unknown, unknown>>,
                FlowRuntime.FlowExecutionNotFound
              > = yield* Effect.exit(
                runtime.poll(Counter, "memory-scoped-lifetime")
              )
              for (let index = 0; index < 50; index++) {
                polled = yield* Effect.exit(runtime.poll(Counter, "memory-scoped-lifetime"))
                if (Exit.isFailure(polled) || (Exit.isSuccess(polled) && Option.isSome(polled.value))) break
                yield* Effect.yieldNow
              }
              expect(
                Exit.isSuccess(polled) && Option.isSome(polled.value) &&
                  polled.value.value._tag === "Complete" &&
                  Exit.isSuccess(polled.value.value.exit) && polled.value.value.exit.value
              ).toBe(1)
            })
          )
        }).pipe(Effect.provide(FlowEngine.layerMemory))
      )
    }))

  it.effect("dies on a handoff whose journaled payload no longer decodes under the registered target's schema", () =>
    Effect.gen(function*() {
      // The handoff payload is serializable data that crossed a journal: the
      // sender encodes it under the declaration its body was authored against,
      // and the engine decodes it under the declaration REGISTERED for the tag.
      // When the registered flow's payload schema has since changed shape, the
      // decode is the wiring error `execute` answers with a defect — and the
      // refused round must never dispatch any of the target's work.
      const EvolvedV1 = Flow.make("trampoline/evolved-target", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => Increment.call({ value })
      })
      const EvolvedV2 = Flow.make("trampoline/evolved-target", {
        payload: { value: Schema.Number, gate: Schema.String },
        success: Schema.Number,
        body: ({ value }) => Increment.call({ value })
      })
      const Sender = Flow.make("trampoline/evolved-sender", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => EvolvedV1.to({ value })
      })
      const { calls, layer } = wire(Interpreter.layer(Sender), Interpreter.layer(EvolvedV2))

      const exit = yield* withCrypto(
        Sender.execute({ value: 1 }, { executionId: "memory-evolved-handoff" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit)
        ? exit.cause.reasons.find((reason) => reason._tag === "Die")?.defect
        : undefined
      // The terminal cause is the typed schema error naming the missing field,
      // recorded as the caller's defect rather than a typed flow failure.
      expect(defect).toBeInstanceOf(Schema.SchemaError)
      expect(String(defect)).toContain("gate")
      // No next-round side effect: the target's increment never dispatched.
      expect(calls).toEqual([])
    }))
})
