/**
 * The system human-task action: what it puts in a plan, how it parks for an
 * answer, what it does with an answer it cannot accept, and how it settles when
 * the human runs out of attempts or the deadline passes.
 *
 * A restart between the park and the answer is proved twice. Here, by dropping
 * the runtime that parked and building another over the same durable record, so
 * the second process parks on the wait point the first one handed out. And on
 * the real durable engine in `examples/src/34-human-task.ts`, which parks a
 * confirm on one SQLite-backed engine, drops it, and answers it from a second.
 *
 * Every deadline here is a step the case takes on the `TestClock`, so what the
 * timeout does is asserted rather than waited out.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Graph, HumanTask, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { withCrypto } from "./Crypto.ts"
import { layerMemoryOver, makeInstance, makeMemoryState, type MemoryState } from "./MemoryFlowRuntime.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

/**
 * A case whose waits are steps it takes on the `TestClock`, so a deadline is
 * asserted rather than waited out.
 */
const timed = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body().pipe(Effect.provide(TestClock.layer()))))

/**
 * The result an execution reaches once its forked fiber has got there, WITHOUT
 * moving the clock: every wait in these cases is a step the case takes itself,
 * so a helper that nudged the clock would blur the deadline it asserts.
 */
const reaches = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, FlowRuntime.FlowExecutionNotFound, R>,
  tag: Flow.Result<A, E>["_tag"]
): Effect.Effect<Flow.Result<A, E>, FlowRuntime.FlowExecutionNotFound, R> =>
  Effect.gen(function*() {
    for (let turn = 0; turn < 200; turn++) {
      yield* Effect.yieldNow
      const polled = yield* poll
      if (Option.isSome(polled) && polled.value._tag === tag) return polled.value
    }
    return yield* Effect.die(`the execution never reached ${tag}`)
  })

const wiredOver = (
  state: MemoryState,
  registration: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations> = Layer.empty
): Layer.Layer<FlowRuntime.FlowRuntime | Action.Implementations, never, Crypto.Crypto> =>
  Layer.mergeAll(HumanTask.layer, registration).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(layerMemoryOver(state))
  )

const wired = (
  registration: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations> = Layer.empty
): Layer.Layer<FlowRuntime.FlowRuntime | Action.Implementations, never, Crypto.Crypto> =>
  wiredOver(makeMemoryState(), registration)

/**
 * The refusals a runtime RECORDED, in the order it recorded them: what a reader
 * of the durable record finds beside the answers those refusals judged.
 *
 * The fixture keys a recorded step by its dispatch, and a dispatch by the
 * action's name, so a rejection step is found by the name it carries.
 */
const rejectionsRecorded = (state: MemoryState): Array<unknown> =>
  Array.from(state.actions.entries()).flatMap(([id, recorded]) => {
    const [dispatch] = JSON.parse(id) as [string, number]
    const [, scope] = JSON.parse(dispatch) as [string, string, number]
    if (!scope.startsWith("HumanTask/") || !scope.includes("/rejected/")) return []
    if (!Exit.isSuccess(recorded)) return []
    const result = recorded.value
    return result._tag === "Complete" && Exit.isSuccess(result.exit) ? [result.exit.value] : []
  })

/**
 * Gives the runtime's forked fibers turns, WITHOUT moving the clock, until the
 * durable record holds `count` refusals.
 *
 * A case that steps a deadline after a refusal has to know the refusal has been
 * judged and the next attempt re-declared; the recorded refusal is the durable
 * evidence of exactly that, so it is what the case waits on.
 */
const refusalsReach = (state: MemoryState, count: number): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (let turn = 0; turn < 200; turn++) {
      yield* Effect.yieldNow
      if (rejectionsRecorded(state).length >= count) return
    }
    return yield* Effect.die(`the record never held ${count} refusals`)
  })

/** A host flow for interpretations driven outside a registered execution. */
const Host = Flow.make("humanTask/host", { payload: {}, body: () => Node.succeed(undefined) })

const drive = <A, E>(
  body: Effect.Effect<
    A,
    E,
    Crypto.Crypto | FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Action.Implementations
  >,
  instance: FlowRuntime.FlowInstance["Service"]
) =>
  withCrypto(
    body.pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provide(wired())
    )
  )

/** Records the answer a wait point of `Host`'s execution settles with. */
const record = (executionId: string, name: string, attempt: number, value: unknown) =>
  Effect.suspend(() => {
    const point = HumanTask.deferred(name, attempt)
    return HumanTask.answer({
      token: DurableDeferred.tokenFromExecutionId(point, { flow: Host, executionId }),
      value: value as typeof Schema.Json.Type
    })
  })

describe("HumanTask as a declaration", () => {
  it("is an ordinary declared action", () => {
    expect(HumanTask.tag).toBe("system/human-task")
    expect(HumanTask.action.name).toBe("system/human-task")
    expect(HumanTask.action.tier).toBe("sealed")
  })

  it("names one wait point per attempt, in the wait-for namespace", () => {
    expect(HumanTask.deferred("release", 1).name).toBe("WaitFor/release#1")
    expect(HumanTask.deferred("release", 2).name).toBe("WaitFor/release#2")
  })

  it("appears in a built graph as a keyed action-call node", () => {
    const Gated = Flow.make("humanTask/plan", {
      payload: { prompt: Schema.String },
      success: Schema.Json,
      error: HumanTask.HumanTaskFailed,
      body: ({ prompt }) => HumanTask.action.call({ name: "release", kind: "confirm", prompt })
    })
    const graph = Graph.build(Gated, { prompt: "Ship it?" })
    const node = Graph.nodes(graph).find((observed) => observed.kind === "ActionCall")

    expect(graph.diagnostics).toEqual([])
    expect(node?.ast).toEqual({
      _tag: "ActionCall",
      action: "system/human-task",
      payload: { name: "release", kind: "confirm", prompt: "Ship it?" }
    })
  })
})

describe("HumanTask.validate", () => {
  it("accepts a string for ask and refuses anything else", () => {
    expect(HumanTask.validate("looks good", { kind: "ask" })).toBeUndefined()
    expect(HumanTask.validate(3, { kind: "ask" })).toContain("string")
  })

  it("accepts a boolean for confirm and refuses anything else", () => {
    expect(HumanTask.validate(true, { kind: "confirm" })).toBeUndefined()
    expect(HumanTask.validate("yes", { kind: "confirm" })).toContain("boolean")
  })

  it("accepts only a declared option for select", () => {
    expect(HumanTask.validate("ship", { kind: "select", options: ["ship", "hold"] })).toBeUndefined()
    expect(HumanTask.validate("burn", { kind: "select", options: ["ship", "hold"] })).toContain("burn")
    expect(HumanTask.validate("ship", { kind: "select" })).toContain("options")
  })

  it("accepts any JSON when a json task names no schema", () => {
    expect(HumanTask.validate({ any: [1, 2] }, { kind: "json" })).toBeUndefined()
  })

  it("checks a json answer against the bounded JSON Schema subset", () => {
    const schema = {
      type: "object",
      required: ["decision", "score"],
      properties: {
        decision: { enum: ["ship", "hold"] },
        score: { type: "integer" },
        notes: { type: "array", items: { type: "string" } },
        reviewer: { type: "string", nullable: true }
      }
    }
    expect(
      HumanTask.validate(
        { decision: "ship", score: 4, notes: ["fine"], reviewer: null },
        { kind: "json", schema }
      )
    ).toBeUndefined()
    expect(HumanTask.validate({ decision: "ship" }, { kind: "json", schema })).toContain("score")
    expect(HumanTask.validate({ decision: "burn", score: 4 }, { kind: "json", schema }))
      .toContain("decision")
    expect(HumanTask.validate({ decision: "ship", score: 1.5 }, { kind: "json", schema }))
      .toContain("integer")
    expect(HumanTask.validate({ decision: "ship", score: 4, notes: [7] }, { kind: "json", schema }))
      .toContain("notes")
    expect(HumanTask.validate("a string", { kind: "json", schema })).toContain("object")
  })

  it("matches object-valued enum members structurally", () => {
    const schema = { enum: [{ id: 1, details: { ready: false } }, "other"] }
    expect(
      HumanTask.validate({ details: { ready: false }, id: 1 }, { kind: "json", schema })
    ).toBeUndefined()
    expect(HumanTask.validate({ id: 2, details: { ready: false } }, { kind: "json", schema }))
      .toContain("must be one of")
    expect(HumanTask.validate({ id: 1 }, { kind: "json", schema })).toContain("must be one of")
    expect(HumanTask.validate({ ix: 1, details: { ready: false } }, { kind: "json", schema }))
      .toContain("must be one of")
  })

  it("matches array-valued enum members structurally", () => {
    const schema = { enum: [[1, { id: 2 }]] }
    expect(HumanTask.validate([1, { id: 2 }], { kind: "json", schema })).toBeUndefined()
    expect(HumanTask.validate([1, { id: 3 }], { kind: "json", schema })).toContain("must be one of")
    expect(HumanTask.validate([1], { kind: "json", schema })).toContain("must be one of")
    expect(HumanTask.validate({ 0: 1 }, { kind: "json", schema })).toContain("must be one of")
  })

  it("matches nested, null-valued, and false-valued enum members", () => {
    const nested = {
      type: "object",
      properties: { choice: { enum: [{ id: 1 }, "b"] } }
    }
    expect(HumanTask.validate({ choice: { id: 1 } }, { kind: "json", schema: nested })).toBeUndefined()
    expect(HumanTask.validate({ choice: { id: 2 } }, { kind: "json", schema: nested })).toContain("choice")
    expect(HumanTask.validate(null, { kind: "json", schema: { enum: [null, "none"] } })).toBeUndefined()
    expect(HumanTask.validate(false, { kind: "json", schema: { enum: [false, true] } })).toBeUndefined()
  })

  it("checks every scalar type the subset covers, both ways", () => {
    const cases: ReadonlyArray<readonly [unknown, unknown, boolean]> = [
      [1.5, { type: "number" }, true],
      [Number.NaN, { type: "number" }, false],
      ["x", { type: "string" }, true],
      [1, { type: "string" }, false],
      [false, { type: "boolean" }, true],
      [0, { type: "boolean" }, false],
      [null, { type: "null" }, true],
      [0, { type: "null" }, false]
    ]
    for (const [value, schema, accepted] of cases) {
      const rejection = HumanTask.validate(value, { kind: "json", schema })
      expect([value, schema, rejection === undefined]).toEqual([value, schema, accepted])
    }
  })

  it("walks arrays and skips properties an answer leaves out", () => {
    const schema = {
      type: "object",
      properties: { notes: { type: "array", items: { type: "string" } }, extra: { type: "string" } }
    }
    // `extra` is absent and not required, so it is not checked at all.
    expect(HumanTask.validate({ notes: ["a"] }, { kind: "json", schema })).toBeUndefined()
    // An object schema that describes no properties accepts any object.
    expect(HumanTask.validate({ whatever: 1 }, { kind: "json", schema: { type: "object" } })).toBeUndefined()
    expect(HumanTask.validate({ notes: "a" }, { kind: "json", schema })).toContain("array")
    // An array with no declared items accepts whatever it holds.
    expect(HumanTask.validate({ mixed: [1, "a"] }, { kind: "json", schema: { type: "array" } }))
      .toContain("array")
    expect(HumanTask.validate([1, "a"], { kind: "json", schema: { type: "array" } })).toBeUndefined()
  })

  it("accepts a schema that describes nothing", () => {
    expect(HumanTask.validate({ anything: true }, { kind: "json", schema: { description: "free form" } }))
      .toBeUndefined()
  })

  it("refuses a schema the subset does not cover", () => {
    expect(HumanTask.validate({}, { kind: "json", schema: { type: "tuple" } })).toContain("tuple")
    expect(HumanTask.validate({}, { kind: "json", schema: { type: "object", minProperties: 1 } }))
      .toContain("minProperties")
    expect(HumanTask.validate({}, { kind: "json", schema: { enum: "ship" } })).toContain("enum")
    expect(HumanTask.validate({}, { kind: "json", schema: "a string" })).toContain("JSON Schema object")
  })

  it("reads an answer's own properties, never the ones every object inherits", () => {
    // `"toString" in {}` is true, so a presence check written with `in` would
    // accept an answer that names none of what was required and would check a
    // property nobody answered.
    const required = { type: "object", required: ["constructor"] }
    const inherited = { type: "object", properties: { toString: { type: "string" } } }

    expect(HumanTask.validate({}, { kind: "json", schema: required })).toContain("constructor")
    expect(HumanTask.validate({ constructor: "mine" }, { kind: "json", schema: required })).toBeUndefined()
    expect(HumanTask.validate({}, { kind: "json", schema: inherited })).toBeUndefined()
    expect(HumanTask.validate({ toString: 1 }, { kind: "json", schema: inherited })).toContain("string")
  })

  it("bounds answer nodes at the exported limit", () => {
    const exact = Array.from({ length: HumanTask.maxAnswerNodes - 1 }, () => null)
    const over = [...exact, null]
    expect(HumanTask.validate(exact, { kind: "json", schema: { type: "array" } })).toBeUndefined()
    const rejection = HumanTask.validate(over, { kind: "json", schema: { type: "array" } })
    expect(rejection).toContain("too large to check")
    expect(rejection).toContain(String(over.length - 1))
  })

  it("truncates rendered diagnostics only after the exported limit", () => {
    const exact = HumanTask.validate("x".repeat(HumanTask.maxDiagnosticChars - 2), {
      kind: "select",
      options: ["ok"]
    })
    const over = HumanTask.validate("x".repeat(HumanTask.maxDiagnosticChars - 1), {
      kind: "select",
      options: ["ok"]
    })
    expect(exact).not.toContain("characters dropped")
    expect(over).toContain("1 characters dropped")
    expect(
      HumanTask.validate("no", { kind: "select", options: ["x".repeat(HumanTask.maxDiagnosticChars + 1)] })
    ).toContain("characters dropped")
    expect(
      HumanTask.validate("no", {
        kind: "json",
        schema: { enum: ["x".repeat(HumanTask.maxDiagnosticChars + 1)] }
      })
    ).toContain("characters dropped")
  })
})

describe("HumanTask.validateSchema", () => {
  it("accepts a schema the subset can enforce, at every depth", () => {
    expect(
      HumanTask.validateSchema({
        type: "object",
        title: "Review",
        required: ["decision"],
        properties: {
          decision: { enum: ["ship", "hold"] },
          notes: { type: "array", items: { type: "string", nullable: true } }
        }
      })
    ).toBeUndefined()
  })

  it("names the path of the first keyword it cannot enforce", () => {
    expect(
      HumanTask.validateSchema({
        type: "object",
        properties: { score: { type: "integer", multipleOf: 2 } }
      })
    ).toContain("score")
    expect(
      HumanTask.validateSchema({ type: "array", items: { type: "string", pattern: "^a" } })
    ).toContain("items")
    expect(HumanTask.validateSchema({ type: "object", properties: ["decision"] })).toContain("properties")
    expect(HumanTask.validateSchema({ type: "tuple" })).toContain("tuple")
    expect(HumanTask.validateSchema({ enum: "ship" })).toContain("enum")
    expect(HumanTask.validateSchema(null)).toContain("JSON Schema object")
  })

  it("refuses malformed required and nullable declarations at their paths", () => {
    expect(HumanTask.validateSchema({ type: "object", required: "name" })).toContain("required")
    expect(HumanTask.validateSchema({ type: "object", required: [1] })).toContain("required.0")
    expect(HumanTask.validateSchema({ type: "object", nullable: "yes" })).toContain("nullable")
  })

  it("bounds schema depth at the exported limit", () => {
    const nested = (depth: number): unknown => {
      let schema: unknown = { type: "string" }
      for (let index = 0; index < depth; index++) schema = { type: "array", items: schema }
      return schema
    }

    expect(HumanTask.validateSchema(nested(HumanTask.maxSchemaDepth))).toBeUndefined()
    const complaint = HumanTask.validateSchema(nested(HumanTask.maxSchemaDepth + 1))
    expect(complaint).toContain(`depth of ${HumanTask.maxSchemaDepth}`)
    expect(complaint).toContain("items")
  })

  it("bounds schema nodes at the exported limit", () => {
    const schemaWithNodes = (nodes: number) => ({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: nodes - 1 }, (_, index) => [`field${index}`, { type: "string" }])
      )
    })

    expect(HumanTask.validateSchema(schemaWithNodes(HumanTask.maxSchemaNodes))).toBeUndefined()
    const complaint = HumanTask.validateSchema(schemaWithNodes(HumanTask.maxSchemaNodes + 1))
    expect(complaint).toContain(`node count of ${HumanTask.maxSchemaNodes}`)
    expect(complaint).toContain(`field${HumanTask.maxSchemaNodes - 1}`)
  })
})

describe("HumanTask parks", () => {
  effect("parks under the approval reason with the first attempt's token", () => {
    const instance = makeInstance(Host, "human-park")
    return Effect.gen(function*() {
      const result = yield* Flow.intoResult(
        Interpreter.interpret(
          HumanTask.action.call({ name: "release", kind: "confirm", prompt: "Ship it?" })
        )
      )
      expect(result._tag).toBe("Suspended")
      expect(instance.waiting).toEqual({
        reason: "approval",
        token: DurableDeferred.tokenFromExecutionId(HumanTask.deferred("release", 1), {
          flow: Host,
          executionId: "human-park"
        })
      })
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provide(wired())
    )
  })

  effect("re-parks on the next attempt's token when it cannot accept the answer", () => {
    const instance = makeInstance(Host, "human-reask")
    return drive(
      Effect.gen(function*() {
        yield* record("human-reask", "release", 1, "yes please")

        const result = yield* Flow.intoResult(
          Interpreter.interpret(
            HumanTask.action.call({ name: "release", kind: "confirm", prompt: "Ship it?" })
          )
        )

        expect(result._tag).toBe("Suspended")
        expect(instance.waiting).toEqual({
          reason: "approval",
          token: DurableDeferred.tokenFromExecutionId(HumanTask.deferred("release", 2), {
            flow: Host,
            executionId: "human-reask"
          })
        })
      }),
      instance
    )
  })

  effect("settles with the first answer it can accept", () =>
    drive(
      Effect.gen(function*() {
        yield* record("human-accept", "release", 1, "yes please")
        yield* record("human-accept", "release", 2, true)

        const interpretation = yield* Interpreter.interpret(
          HumanTask.action.call({ name: "release", kind: "confirm", prompt: "Ship it?" })
        )

        expect(interpretation.value).toBe(true)
      }),
      makeInstance(Host, "human-accept")
    ))

  effect("does not park again once an acceptable answer is recorded", () => {
    const instance = makeInstance(Host, "human-replay")
    return drive(
      Effect.gen(function*() {
        yield* record("human-replay", "release", 1, true)

        const interpretation = yield* Interpreter.interpret(
          HumanTask.action.call({ name: "release", kind: "confirm", prompt: "Ship it?" })
        )

        expect(interpretation.value).toBe(true)
        expect(instance.suspended).toBe(false)
      }),
      instance
    )
  })
})

describe("HumanTask gives up", () => {
  effect("fails once the attempt budget is spent, listing what it refused", () => {
    const instance = makeInstance(Host, "human-exhausted")
    return drive(
      Effect.gen(function*() {
        yield* record("human-exhausted", "release", 1, "yes")
        yield* record("human-exhausted", "release", 2, 1)

        const exit = yield* Effect.exit(
          Interpreter.interpret(
            HumanTask.action.call({
              name: "release",
              kind: "confirm",
              prompt: "Ship it?",
              maxAttempts: 2
            })
          )
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons[0]).toMatchObject({
            error: {
              _tag: "@smthrs/flow/HumanTaskFailed",
              code: "rejected",
              task: "release",
              attempts: 2
            }
          })
        }
        expect(instance.suspended).toBe(false)
      }),
      instance
    )
  })

  effect("retains rejection diagnostics exactly to the cap and omits the tail", () => {
    const request = { kind: "select", options: ["ok"] } as const
    const maxValueChars = HumanTask.maxDiagnosticChars - 2
    const valuesAtLimit = (): Array<string> => {
      for (let count = 1; count <= 100; count++) {
        const base = Array.from({ length: count }, (_, index) => {
          const reason = HumanTask.validate("", request)!
          return `attempt ${index + 1}: ${reason}`.length
        }).reduce((sum, length) => sum + length, 0)
        if (base > HumanTask.maxRetainedRejectionChars) break
        if (base + count * maxValueChars < HumanTask.maxRetainedRejectionChars) continue
        let remaining = HumanTask.maxRetainedRejectionChars - base
        return Array.from({ length: count }, () => {
          const length = Math.min(maxValueChars, remaining)
          remaining -= length
          return "x".repeat(length)
        })
      }
      throw new Error("could not construct an exact retained-rejection boundary")
    }
    const values = valuesAtLimit()
    const run = (executionId: string, extra: ReadonlyArray<string>) => {
      const instance = makeInstance(Host, executionId)
      return drive(
        Effect.gen(function*() {
          const answers = [...values, ...extra]
          for (const [index, value] of answers.entries()) {
            yield* record(executionId, "bounded", index + 1, value)
          }
          const exit = yield* Effect.exit(
            Interpreter.interpret(
              HumanTask.action.call({
                name: "bounded",
                kind: "select",
                prompt: "Choose.",
                options: ["ok"],
                maxAttempts: answers.length
              })
            )
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (!Exit.isFailure(exit)) return []
          const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
          expect(failure).toBeInstanceOf(HumanTask.HumanTaskFailed)
          return failure instanceof HumanTask.HumanTaskFailed ? failure.rejections : []
        }),
        instance
      )
    }

    return Effect.gen(function*() {
      const exact = yield* run("human-retained-exact", [])
      expect(exact.reduce((sum, entry) => sum + entry.length, 0)).toBe(HumanTask.maxRetainedRejectionChars)
      expect(exact.some((entry) => entry.includes("were omitted"))).toBe(false)

      const over = yield* run("human-retained-over", ["one more", "and another"])
      expect(over.reduce((sum, entry) => sum + entry.length, 0)).toBeLessThanOrEqual(
        HumanTask.maxRetainedRejectionChars
      )
      expect(over.at(-1)).toMatch(/\d+ further rejections were omitted\./)
    })
  })

  effect("refuses an attempt budget below one attempt before it parks", () => {
    const instance = makeInstance(Host, "human-no-budget")
    return drive(
      Effect.gen(function*() {
        const exit = yield* Effect.exit(
          Interpreter.interpret(
            HumanTask.action.call({ name: "release", kind: "confirm", prompt: "Ship it?", maxAttempts: 0 })
          )
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons[0]).toMatchObject({
            error: { _tag: "@smthrs/flow/HumanTaskFailed", code: "request_invalid", attempts: 0 }
          })
        }
        expect(instance.suspended).toBe(false)
      }),
      instance
    )
  })

  effect("accepts the maximum attempt budget and refuses one more", () => {
    const acceptedInstance = makeInstance(Host, "human-max-budget")
    const refusedInstance = makeInstance(Host, "human-over-budget")
    return Effect.all([
      drive(
        Effect.gen(function*() {
          const result = yield* Flow.intoResult(
            Interpreter.interpret(
              HumanTask.action.call({
                name: "accepted",
                kind: "ask",
                prompt: "Answer.",
                maxAttempts: HumanTask.maxAttemptBudget
              })
            )
          )
          expect(result._tag).toBe("Suspended")
        }),
        acceptedInstance
      ),
      drive(
        Effect.gen(function*() {
          const result = yield* Flow.intoResult(
            Interpreter.interpret(
              HumanTask.action.call({
                name: "refused",
                kind: "ask",
                prompt: "Answer.",
                maxAttempts: HumanTask.maxAttemptBudget + 1
              })
            )
          )
          expect(result._tag).toBe("Complete")
          if (result._tag === "Complete" && Exit.isFailure(result.exit)) {
            expect(result.exit.cause.reasons[0]).toMatchObject({
              error: {
                _tag: "@smthrs/flow/HumanTaskFailed",
                code: "request_invalid",
                message: expect.stringContaining("stuck question")
              }
            })
          }
        }),
        refusedInstance
      )
    ], { discard: true })
  })

  effect("refuses a deadline no clock can keep before it parks", () => {
    // Each of these reaches `Duration.millis` unread today, and each fails a
    // different way: a negative or NaN length is a deadline that has ALREADY
    // passed, so the question times out on the first park without anyone being
    // asked, and an infinite length is a deadline that never arrives, so a
    // question that declares one has none. All three are the same authoring
    // mistake, and it is refused where the other unanswerable questions are.
    const refused = (timeoutMs: number, executionId: string) => {
      const instance = makeInstance(Host, executionId)
      return drive(
        Effect.gen(function*() {
          const result = yield* Flow.intoResult(
            Interpreter.interpret(
              HumanTask.action.call({ name: "release", kind: "confirm", prompt: "Ship it?", timeoutMs })
            )
          )

          expect(result._tag).toBe("Complete")
          if (result._tag === "Complete") {
            expect(Exit.isFailure(result.exit)).toBe(true)
            if (Exit.isFailure(result.exit)) {
              expect(result.exit.cause.reasons[0]).toMatchObject({
                error: {
                  _tag: "@smthrs/flow/HumanTaskFailed",
                  code: "request_invalid",
                  task: "release",
                  attempts: 0
                }
              })
            }
          }
          expect(instance.suspended).toBe(false)
        }),
        instance
      )
    }

    return Effect.all([
      refused(Number.NaN, "human-deadline-nan"),
      refused(Number.POSITIVE_INFINITY, "human-deadline-infinite"),
      refused(-5, "human-deadline-negative")
    ], { discard: true })
  })

  effect("keeps a deadline of no time at all, which is a deadline that has passed", () => {
    const instance = makeInstance(Host, "human-deadline-zero")
    return drive(
      Effect.gen(function*() {
        const result = yield* Flow.intoResult(
          Interpreter.interpret(
            HumanTask.action.call({ name: "release", kind: "confirm", prompt: "Ship it?", timeoutMs: 0 })
          )
        )

        // Zero is a length, so the question is asked and its deadline is over:
        // `timeout`, not `request_invalid`.
        expect(result._tag).toBe("Complete")
        if (result._tag === "Complete" && Exit.isFailure(result.exit)) {
          expect(result.exit.cause.reasons[0]).toMatchObject({
            error: { _tag: "@smthrs/flow/HumanTaskFailed", code: "timeout", task: "release", attempts: 1 }
          })
        }
      }),
      instance
    )
  })

  effect("refuses a schema outside the supported subset before it parks", () => {
    const instance = makeInstance(Host, "human-bad-schema")
    return drive(
      Effect.gen(function*() {
        const exit = yield* Effect.exit(
          Interpreter.interpret(
            HumanTask.action.call({
              name: "release",
              kind: "json",
              prompt: "Decide.",
              schema: { type: "object", properties: { score: { type: "integer", multipleOf: 2 } } }
            })
          )
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons[0]).toMatchObject({
            error: { _tag: "@smthrs/flow/HumanTaskFailed", code: "request_invalid" }
          })
        }
        expect(instance.suspended).toBe(false)
      }),
      instance
    )
  })

  effect("refuses malformed required and nullable schemas before it parks", () => {
    const refused = (schema: typeof Schema.Json.Type, executionId: string, path: string) => {
      const instance = makeInstance(Host, executionId)
      return drive(
        Effect.gen(function*() {
          const result = yield* Flow.intoResult(
            Interpreter.interpret(
              HumanTask.action.call({ name: executionId, kind: "json", prompt: "Answer.", schema })
            )
          )
          expect(result._tag).toBe("Complete")
          if (result._tag === "Complete" && Exit.isFailure(result.exit)) {
            expect(result.exit.cause.reasons[0]).toMatchObject({
              error: {
                _tag: "@smthrs/flow/HumanTaskFailed",
                code: "request_invalid",
                message: expect.stringContaining(path)
              }
            })
          }
          expect(instance.suspended).toBe(false)
        }),
        instance
      )
    }

    return Effect.all([
      refused({ type: "object", required: "name" }, "human-required-string", "required"),
      refused({ type: "object", required: [1] }, "human-required-number", "required.0"),
      refused({ type: "object", nullable: "yes" }, "human-nullable-string", "nullable")
    ], { discard: true })
  })

  effect("refuses a schema on ask, confirm, and select questions", () => {
    const refused = (
      payload: typeof HumanTask.action.payloadSchema.Type,
      executionId: string
    ) => {
      const instance = makeInstance(Host, executionId)
      return drive(
        Effect.gen(function*() {
          const result = yield* Flow.intoResult(Interpreter.interpret(HumanTask.action.call(payload)))
          expect(result._tag).toBe("Complete")
          if (result._tag === "Complete" && Exit.isFailure(result.exit)) {
            expect(result.exit.cause.reasons[0]).toMatchObject({
              error: {
                _tag: "@smthrs/flow/HumanTaskFailed",
                code: "request_invalid",
                message: expect.stringContaining(`"${payload.kind}"`)
              }
            })
          }
        }),
        instance
      )
    }

    return Effect.all([
      refused(
        { name: "ask-schema", kind: "ask", prompt: "Ask.", schema: { type: "string" } },
        "human-ask-schema"
      ),
      refused(
        { name: "confirm-schema", kind: "confirm", prompt: "Confirm.", schema: { type: "boolean" } },
        "human-confirm-schema"
      ),
      refused(
        {
          name: "select-schema",
          kind: "select",
          prompt: "Select.",
          options: ["one"],
          schema: { type: "string" }
        },
        "human-select-schema"
      )
    ], { discard: true })
  })

  effect("keeps json schema validation and ignores a json option list", () =>
    drive(
      Effect.gen(function*() {
        yield* record("human-json-schema", "json-schema", 1, { choice: { id: 1 } })
        const checked = yield* Interpreter.interpret(
          HumanTask.action.call({
            name: "json-schema",
            kind: "json",
            prompt: "Choose.",
            options: ["not-a-json-constraint"],
            schema: {
              type: "object",
              required: ["choice"],
              properties: { choice: { enum: [{ id: 1 }] } }
            }
          })
        )
        expect(checked.value).toEqual({ choice: { id: 1 } })
      }),
      makeInstance(Host, "human-json-schema")
    ))

  effect("refuses a select task whose option list is empty", () => {
    const instance = makeInstance(Host, "human-empty-options")
    return drive(
      Effect.gen(function*() {
        const exit = yield* Effect.exit(
          Interpreter.interpret(
            HumanTask.action.call({ name: "pick", kind: "select", prompt: "Which?", options: [] })
          )
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons[0]).toMatchObject({
            error: { _tag: "@smthrs/flow/HumanTaskFailed", code: "request_invalid" }
          })
        }
      }),
      instance
    )
  })

  effect("refuses a select task that declares no options before it parks", () => {
    const instance = makeInstance(Host, "human-invalid-request")
    return drive(
      Effect.gen(function*() {
        const exit = yield* Effect.exit(
          Interpreter.interpret(
            HumanTask.action.call({ name: "pick", kind: "select", prompt: "Which?" })
          )
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons[0]).toMatchObject({
            error: { _tag: "@smthrs/flow/HumanTaskFailed", code: "request_invalid" }
          })
        }
        expect(instance.suspended).toBe(false)
      }),
      instance
    )
  })

  timed("fails with the timeout code when the deadline passes unanswered", () => {
    const Gated = Flow.make("humanTask/timeout", {
      payload: {},
      success: Schema.Json,
      error: HumanTask.HumanTaskFailed,
      body: () =>
        HumanTask.action.call({
          name: "release",
          kind: "confirm",
          prompt: "Ship it?",
          timeoutMs: 20
        })
    })
    const executionId = "human-timeout"
    return Effect.gen(function*() {
      yield* Effect.orDie(Gated.execute({}, { executionId, discard: true }))
      const parked = yield* Effect.orDie(reaches(Gated.poll(executionId), "Suspended"))
      expect(parked._tag).toBe("Suspended")

      // Nineteen of the declared twenty milliseconds: the question is still
      // open, because a deadline that had already fired would settle here.
      yield* TestClock.adjust("19 millis")
      expect((yield* Effect.orDie(reaches(Gated.poll(executionId), "Suspended")))._tag).toBe("Suspended")

      // The twentieth is the deadline.
      yield* TestClock.adjust("1 milli")
      const result = yield* Effect.orDie(reaches(Gated.poll(executionId), "Complete"))

      expect(result._tag).toBe("Complete")
      if (result._tag === "Complete") {
        expect(Exit.isFailure(result.exit)).toBe(true)
        if (Exit.isFailure(result.exit)) {
          expect(result.exit.cause.reasons[0]).toMatchObject({
            error: { _tag: "@smthrs/flow/HumanTaskFailed", code: "timeout", task: "release" }
          })
        }
      }
    }).pipe(Effect.provide(wired(Interpreter.layer(Gated))))
  })

  timed("settles with an answer that beats the deadline", () => {
    const Gated = Flow.make("humanTask/raced", {
      payload: {},
      success: Schema.Json,
      error: HumanTask.HumanTaskFailed,
      body: () =>
        HumanTask.action.call({
          name: "release",
          kind: "ask",
          prompt: "Why?",
          timeoutMs: 60_000
        })
    })
    const executionId = "human-raced"
    return Effect.gen(function*() {
      yield* Effect.orDie(Gated.execute({}, { executionId, discard: true }))
      yield* Effect.orDie(reaches(Gated.poll(executionId), "Suspended"))

      // The clock never reaches the deadline, so the only thing that can settle
      // this race is the answer.
      yield* TestClock.adjust("30 seconds")
      yield* HumanTask.answer({
        token: DurableDeferred.tokenFromExecutionId(HumanTask.deferred("release", 1), {
          flow: Gated,
          executionId
        }),
        value: "because"
      })
      const result = yield* Effect.orDie(reaches(Gated.poll(executionId), "Complete"))

      expect(result._tag === "Complete" && Exit.isSuccess(result.exit) && result.exit.value).toBe("because")
    }).pipe(Effect.provide(wired(Interpreter.layer(Gated))))
  })

  timed("keeps one deadline for the question across the attempts it re-asks on", () => {
    const Gated = Flow.make("humanTask/timeout-across-attempts", {
      payload: {},
      success: Schema.Json,
      error: HumanTask.HumanTaskFailed,
      body: () =>
        HumanTask.action.call({
          name: "release",
          kind: "confirm",
          prompt: "Ship it?",
          timeoutMs: 20,
          maxAttempts: 5
        })
    })
    const executionId = "human-timeout-across-attempts"
    const durable = makeMemoryState()
    return Effect.gen(function*() {
      yield* Effect.orDie(Gated.execute({}, { executionId, discard: true }))
      yield* Effect.orDie(reaches(Gated.poll(executionId), "Suspended"))

      // Half way through the deadline, an answer a confirm cannot accept sends
      // the question back to a second attempt.
      yield* TestClock.adjust("10 millis")
      yield* HumanTask.answer({
        token: DurableDeferred.tokenFromExecutionId(HumanTask.deferred("release", 1), {
          flow: Gated,
          executionId
        }),
        value: "yes, ship it"
      })
      yield* refusalsReach(durable, 1)

      // The second attempt did not restart the clock. At 19 of the 20 declared
      // milliseconds the question is still open; a per-attempt deadline would
      // have another 10 ms to run here and would leave the run suspended below.
      yield* TestClock.adjust("9 millis")
      expect((yield* Effect.orDie(reaches(Gated.poll(executionId), "Suspended")))._tag).toBe("Suspended")

      // Twenty milliseconds after the QUESTION was asked, it is over.
      yield* TestClock.adjust("1 milli")
      const result = yield* Effect.orDie(reaches(Gated.poll(executionId), "Complete"))

      expect(result._tag).toBe("Complete")
      if (result._tag === "Complete") {
        expect(Exit.isFailure(result.exit)).toBe(true)
        if (Exit.isFailure(result.exit)) {
          expect(result.exit.cause.reasons[0]).toMatchObject({
            error: { _tag: "@smthrs/flow/HumanTaskFailed", code: "timeout", task: "release", attempts: 2 }
          })
        }
      }
    }).pipe(Effect.provide(wiredOver(durable, Interpreter.layer(Gated))))
  })
})

describe("HumanTask records what it refused", () => {
  effect("records the refusal as a step of its own, naming the attempt it judged", () => {
    const durable = makeMemoryState()
    const instance = makeInstance(Host, "human-rejection-record")
    return Effect.gen(function*() {
      yield* record("human-rejection-record", "score", 1, { score: "high" })

      const result = yield* Flow.intoResult(
        Interpreter.interpret(
          HumanTask.action.call({
            name: "score",
            kind: "json",
            prompt: "How did it go?",
            schema: { type: "object", properties: { score: { type: "integer" } }, required: ["score"] }
          })
        )
      )

      // The run went back to waiting, and the reason it sent the answer back is
      // in the durable record rather than in a log stream nobody replays.
      expect(result._tag).toBe("Suspended")
      expect(rejectionsRecorded(durable)).toEqual([
        { task: "score", attempt: 1, reason: expect.stringContaining("score") }
      ])
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provide(wiredOver(durable))
    )
  })

  effect("records one refusal per attempt it spent", () => {
    const durable = makeMemoryState()
    const instance = makeInstance(Host, "human-rejection-budget")
    return Effect.gen(function*() {
      yield* record("human-rejection-budget", "release", 1, "yes")
      yield* record("human-rejection-budget", "release", 2, 1)

      yield* Effect.exit(
        Interpreter.interpret(
          HumanTask.action.call({ name: "release", kind: "confirm", prompt: "Ship it?", maxAttempts: 2 })
        )
      )

      expect(rejectionsRecorded(durable)).toEqual([
        { task: "release", attempt: 1, reason: expect.stringContaining("boolean") },
        { task: "release", attempt: 2, reason: expect.stringContaining("boolean") }
      ])
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provide(wiredOver(durable))
    )
  })
})

describe("HumanTask across a restart", () => {
  effect("parks on one process and is answered on the next, through the same token", () => {
    const Gated = Flow.make("humanTask/restart", {
      payload: {},
      success: Schema.Json,
      error: HumanTask.HumanTaskFailed,
      body: () => HumanTask.action.call({ name: "release", kind: "confirm", prompt: "Ship it?" })
    })
    const executionId = "human-restart"
    // The token the FIRST process parked with, computed once. Nothing the
    // second process does may change it: a question that moved its wait point
    // when the process restarted would leave whoever holds this token unable to
    // answer it.
    const parkedToken = DurableDeferred.tokenFromExecutionId(HumanTask.deferred("release", 1), {
      flow: Gated,
      executionId
    })
    // The record both processes read: recorded steps, and settled wait points.
    const durable = makeMemoryState()
    const process = () => wiredOver(durable, Interpreter.layer(Gated))
    return Effect.gen(function*() {
      // The first process asks and parks. Then it is gone: its scope closes,
      // taking its registrations, its live execution, and its fibers with it.
      const parked = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* Effect.orDie(Gated.execute({}, { executionId, discard: true }))
          const suspended = yield* Effect.orDie(reaches(Gated.poll(executionId), "Suspended"))
          const instance = yield* Effect.orDie(Gated.poll(executionId))
          expect(Option.isSome(instance)).toBe(true)
          return suspended
        }).pipe(Effect.provide(process()))
      )
      expect(parked._tag).toBe("Suspended")

      // The second process re-drives the execution it found parked, parks on
      // the SAME wait point, and the token the first process handed out settles
      // it.
      const finished = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* Effect.orDie(Gated.execute({}, { executionId, discard: true }))
          expect((yield* Effect.orDie(reaches(Gated.poll(executionId), "Suspended")))._tag).toBe("Suspended")

          yield* HumanTask.answer({ token: parkedToken, value: true })
          return yield* Effect.orDie(reaches(Gated.poll(executionId), "Complete"))
        }).pipe(Effect.provide(process()))
      )

      expect(finished._tag === "Complete" && Exit.isSuccess(finished.exit) && finished.exit.value).toBe(true)
    })
  })
})

describe("HumanTask.answer", () => {
  effect("refuses a bad token with its parse issue and a bounded excerpt", () =>
    drive(
      Effect.gen(function*() {
        const token = "*".repeat(100) as DurableDeferred.Token
        const exit = yield* Effect.exit(
          HumanTask.answer({ token, value: true })
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons[0]).toMatchObject({
            error: {
              _tag: "@smthrs/flow/DurableDeferred/TokenInvalid",
              code: "malformed_token",
              message: expect.stringContaining("Base64Url")
            }
          })
          const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
          if (failure instanceof DurableDeferred.TokenInvalid) {
            expect(failure.message).toContain("*".repeat(64))
            expect(failure.message).toContain("36 characters dropped")
            expect(failure.message).not.toContain(token)
          }
        }
      }),
      makeInstance(Host, "human-bad-token")
    ))

  effect("refuses a token naming a deferred no human task ever opened", () => {
    // `answer` completes a caller-supplied address under `Schema.Json`, so
    // without this check it is an oracle over every durable deferred in the
    // run: a queue item's token or a bare wait point's token, submitted to a
    // human-approval surface, would write a JSON exit into a row the awaiting
    // flow decodes under its own schemas. First-writer-wins makes that
    // permanent, so the refusal has to also leave the row untouched.
    const state = makeMemoryState()
    const executionId = "human-foreign-token"
    const foreign = [
      // A `DurableQueue` per-item address.
      "DurableQueue/releases/item-1",
      // A bare wait point: HumanTask's namespace, but not its attempt suffix.
      "WaitFor/approval",
      // Attempt suffixes `HumanTask.deferred` would never have written.
      "WaitFor/release#01",
      "WaitFor/release#1e0",
      "WaitFor/release#",
      // An unrelated flow's deferred.
      "Some/Other/Deferred"
    ]

    return Effect.gen(function*() {
      for (const deferredName of foreign) {
        const token = new DurableDeferred.TokenParsed({
          flowName: Host._tag,
          executionId,
          deferredName
        }).asToken
        const failure = yield* Effect.flip(HumanTask.answer({ token, value: true }))

        expect(failure).toBeInstanceOf(DurableDeferred.TokenInvalid)
        expect(failure.code).toBe("deferred_mismatch")
        expect(failure.message).toContain(deferredName)
        expect(state.deferredResults.has(`${executionId}/${deferredName}`)).toBe(false)
      }

      // The addresses the surface IS for still complete through it.
      const point = HumanTask.deferred("release", 1)
      yield* HumanTask.answer({
        token: DurableDeferred.tokenFromExecutionId(point, { flow: Host, executionId }),
        value: "ship it"
      })
      expect(state.deferredResults.has(`${executionId}/${point.name}`)).toBe(true)
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Host, executionId)),
      Effect.provide(wiredOver(state))
    )
  })
})

describe("HumanTask.decode", () => {
  const Decision = Schema.Struct({ decision: Schema.Literals(["ship", "hold"]) })

  /**
   * The annotation is the assertion: `action.call` yields `Schema.Json`, and
   * only a `decode` that narrows would typecheck against this declared node
   * type. `tsc -p tsconfig.test.json` is what checks it.
   */
  const asked: Node.Node<{ readonly decision: "ship" | "hold" }, HumanTask.HumanTaskFailed> = HumanTask.action.call({
    name: "release",
    kind: "json",
    prompt: "Decide.",
    schema: { type: "object", required: ["decision"], properties: { decision: { enum: ["ship", "hold"] } } }
  }).pipe(HumanTask.decode(Decision))

  effect("gives the answer the caller's own type", () =>
    drive(
      Effect.gen(function*() {
        yield* record("human-decode", "release", 1, { decision: "ship" })

        const interpretation = yield* Interpreter.interpret(asked)

        expect(interpretation.value).toEqual({ decision: "ship" })
      }),
      makeInstance(Host, "human-decode")
    ))
})
