import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as Saga from "../src/Saga.ts"

class Boom extends Schema.TaggedError<Boom>()("Boom", { step: Schema.String }) {}

// Each flow echoes its own name, so a built graph can name the flow behind
// every `FlowCall` node.
const named = (name: string) =>
  Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    body: Node.capture({ name }, () => Node.succeed({ from: name }))
  })

const calledFlows = (graph: Graph.Graph): ReadonlyArray<string> =>
  Graph.nodes(graph)
    .filter((node) => node.kind === "FlowCall")
    .map((call) => {
      const body = Graph.nodes(graph).find((node) => node.id === `${call.id}.flow`)?.keyMaterial.body
      return (body as { readonly value: { readonly from: string } }).value.from
    })

const declared = ["one", "two", "three"].map((id) => ({
  id,
  action: named(`do-${id}`),
  compensation: named(`undo-${id}`)
}))

// A scripted step: `fails` decides whether its action fails, and every call is
// appended to `trace` so the test can assert LIFO unwinding.
const scripted = (
  trace: Array<string>,
  id: string,
  options?: {
    readonly fails?: boolean
    readonly compensationFails?: boolean
    readonly compensationDies?: boolean
  }
) => ({
  id,
  action: () =>
    Effect.suspend(() => {
      trace.push(`do-${id}`)
      return options?.fails === true
        ? Effect.fail(new Boom({ step: id }))
        : Effect.succeed(`${id}-done`)
    }),
  compensation: () =>
    Effect.suspend(() => {
      trace.push(`undo-${id}`)
      if (options?.compensationDies === true) return Effect.die(new Error(`undo-${id} exploded`))
      return options?.compensationFails === true
        ? Effect.fail(new Boom({ step: `undo-${id}` }))
        : Effect.succeed(undefined)
    })
})

describe("Saga", () => {
  it("declares one catch per step and reverse-ordered compensations", () => {
    const graph = Graph.build(Saga.make({ steps: declared, onFailure: "compensate-and-fail" }), "order")

    expect(calledFlows(graph)).toEqual([
      "do-one",
      "do-two",
      "do-three",
      "undo-three",
      "undo-two",
      "undo-one"
    ])
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "Fail")).toHaveLength(3)
  })

  it("declares no compensation arm under the fail policy", () => {
    const graph = Graph.build(Saga.make({ steps: declared, onFailure: "fail" }), "order")

    expect(calledFlows(graph)).toEqual(["do-one", "do-two", "do-three"])
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(0)
  })

  it("declares a settled outcome under the compensate policy", () => {
    const graph = Graph.build(Saga.make({ steps: declared, onFailure: "compensate" }), "order")
    const catches = Graph.nodes(graph).filter((node) => node.kind === "Catch")

    expect(catches).toHaveLength(4)
    expect(Graph.nodes(graph).at(-1)?.keyMaterial.body).toEqual({
      _tag: "Succeed",
      value: { compensated: true, failure: { _tag: "PlannedInput", path: [] } }
    })
  })

  it("rejects an empty saga", () => {
    expect(() => Saga.make({ steps: [], onFailure: "compensate" })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Saga requires at least one step" })
    )
  })

  it.effect("runs every step and no compensation when the saga succeeds", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const result = yield* Saga.run("order", {
        steps: [scripted(trace, "one"), scripted(trace, "two")],
        onFailure: "compensate"
      })

      expect(trace).toEqual(["do-one", "do-two"])
      expect(result).toEqual({ one: "one-done", two: "two-done" })
    }))

  it.effect("copies and returns own completed values for prototype-shaped step ids", () =>
    Effect.gen(function*() {
      const ids = ["__proto__", "constructor", "toString", "normal"]
      const seen: Array<Readonly<Record<string, string>>> = []
      const result = yield* Saga.run<string, string, never, never, never, never>("order", {
        onFailure: "fail",
        steps: ids.map((id) => ({
          id,
          action: ({ completed }) => Effect.sync(() => (seen.push(completed), `${id}-value`)),
          compensation: () => Effect.void
        }))
      })

      for (const [index, completed] of seen.entries()) {
        expect(Object.getPrototypeOf(completed)).toBe(Object.prototype)
        expect(Object.keys(completed)).toEqual(ids.slice(0, index))
        for (const id of ids.slice(0, index)) {
          expect(Object.hasOwn(completed, id)).toBe(true)
          expect(completed[id]).toBe(`${id}-value`)
        }
      }
      expect("compensated" in result).toBe(false)
      const completed = result as Readonly<Record<string, string>>
      expect(Object.getPrototypeOf(completed)).toBe(Object.prototype)
      for (const id of ids) {
        expect(Object.hasOwn(completed, id)).toBe(true)
        expect(completed[id]).toBe(`${id}-value`)
      }
    }))

  it.effect("compensates completed steps in reverse and settles under compensate", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const result = yield* Saga.run("order", {
        steps: [scripted(trace, "one"), scripted(trace, "two"), scripted(trace, "three", { fails: true })],
        onFailure: "compensate"
      })

      expect(trace).toEqual(["do-one", "do-two", "do-three", "undo-two", "undo-one"])
      expect(result).toEqual({ compensated: true, failure: new Boom({ step: "three" }) })
    }))

  it.effect("re-fails with the original error under compensate-and-fail", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [scripted(trace, "one"), scripted(trace, "two"), scripted(trace, "three", { fails: true })],
          onFailure: "compensate-and-fail"
        })
      )

      expect(trace).toEqual(["do-one", "do-two", "do-three", "undo-two", "undo-one"])
      expect(error).toEqual(new Boom({ step: "three" }))
    }))

  it.effect("runs no compensation under the fail policy", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [scripted(trace, "one"), scripted(trace, "two", { fails: true })],
          onFailure: "fail"
        })
      )

      expect(trace).toEqual(["do-one", "do-two"])
      expect(error).toEqual(new Boom({ step: "two" }))
    }))

  it.effect("reports a failing compensation and still runs the rest", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [
            scripted(trace, "one"),
            scripted(trace, "two", { compensationFails: true }),
            scripted(trace, "three", { fails: true })
          ],
          onFailure: "compensate"
        })
      )

      expect(trace).toEqual(["do-one", "do-two", "do-three", "undo-two", "undo-one"])
      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("compensation_failed")
      expect((error as PatternError).message).toBe("Saga compensation failed for: two")
      expect((error as PatternError).cause).toEqual({
        failure: new Boom({ step: "three" }),
        residue: [{ id: "two", error: new Boom({ step: "undo-two" }) }]
      })
    }))

  it.effect("sorts every failed compensation in the refusal", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [
            scripted(trace, "two", { compensationFails: true }),
            scripted(trace, "one", { compensationFails: true }),
            scripted(trace, "three", { fails: true })
          ],
          onFailure: "compensate"
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("compensation_failed")
      expect((error as PatternError).message).toBe("Saga compensation failed for: one, two")
      expect((error as PatternError).cause).toEqual({
        failure: new Boom({ step: "three" }),
        residue: [
          { id: "one", error: new Boom({ step: "undo-one" }) },
          { id: "two", error: new Boom({ step: "undo-two" }) }
        ]
      })
    }))

  it.effect("reports compensation residue without inventing a typed failure for a defect", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [
            scripted([], "one", { compensationFails: true }),
            {
              id: "two",
              action: () => Effect.die(new Error("forward defect")),
              compensation: () => Effect.void
            }
          ],
          onFailure: "compensate"
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("compensation_failed")
      expect((error as PatternError).message).toBe("Saga compensation failed for: one")
      expect((error as PatternError).cause).toEqual({
        residue: [{ id: "one", error: new Boom({ step: "undo-one" }) }]
      })
    }))

  it.effect("propagates a forward defect when every compensation succeeds", () =>
    Effect.gen(function*() {
      const defect = new Error("forward defect")
      const exit = yield* Effect.exit(
        Saga.run("order", {
          steps: [{ id: "one", action: () => Effect.die(defect), compensation: () => Effect.void }],
          onFailure: "compensate"
        })
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        // The forward defect reaches the caller unwrapped: `compensate` turns a
        // typed failure into `Compensated`, and a defect is not a typed failure.
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(Result.getOrThrow(Cause.findDefect(exit.cause))).toBe(defect)
      }
    }))

  it.effect("does not admit a step appended while the run is in flight", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const steps: Array<Saga.RuntimeStep<string, string, never, never, never, never>> = []
      const late: Saga.RuntimeStep<string, string, never, never, never, never> = {
        id: "late",
        action: () => Effect.sync(() => (trace.push("late"), "late-done")),
        compensation: () => Effect.void
      }
      steps.push({
        id: "one",
        action: () => Effect.sync(() => (trace.push("one"), steps.push(late), "one-done")),
        compensation: () => Effect.void
      })

      const result = yield* Saga.run("order", { steps, onFailure: "fail" })

      expect(trace).toEqual(["one"])
      expect(result).toEqual({ one: "one-done" })
    }))

  it.effect("compensates completed steps when the forward chain is interrupted", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const fiber = yield* Effect.forkChild(
        Saga.run("order", {
          steps: [
            scripted(trace, "one"),
            {
              id: "two",
              action: () => Effect.never,
              compensation: () => Effect.sync(() => trace.push("undo-two"))
            }
          ],
          onFailure: "compensate"
        }),
        { startImmediately: true }
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)

      expect(trace).toEqual(["do-one", "undo-one"])
    }))

  // `run` refuses with a TYPED failure, not a defect: `PatternError` is in the
  // declared error channel, so a caller must be able to claim it.
  it.effect("fails run with a typed PatternError for an empty saga and for duplicate step ids", () =>
    Effect.gen(function*() {
      const empty = yield* Effect.flip(
        Saga.run("order", {
          steps: [] as ReadonlyArray<Saga.RuntimeStep<string, string, never, never, never, never>>,
          onFailure: "compensate"
        })
      )
      const step: Saga.RuntimeStep<string, string, never, never, never, never> = {
        id: "one",
        action: () => Effect.succeed("done"),
        compensation: () => Effect.void
      }
      const duplicate = yield* Effect.flip(Saga.run("order", { steps: [step, step], onFailure: "compensate" }))

      expect(empty).toBeInstanceOf(PatternError)
      expect(empty.code).toBe("invalid_decorator")
      expect(empty.message).toBe("Saga requires at least one step")
      expect(duplicate).toBeInstanceOf(PatternError)
      expect(duplicate.code).toBe("invalid_decorator")
      expect(duplicate.message).toBe("Saga step ids must be unique")
    }))
  it("defaults an omitted policy to compensate in the declaration", () => {
    const graph = Graph.build(Saga.make({ steps: declared }), "order")
    const explicit = Graph.build(Saga.make({ steps: declared, onFailure: "compensate" }), "order")

    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(4)
    expect(calledFlows(graph)).toEqual(calledFlows(explicit))
    // The default is normalized before it reaches key material, so omitting
    // the policy and naming it plan to the same node keys and hit the same
    // cache entries.
    expect(Graph.nodes(graph).map((node) => node.keyMaterial)).toEqual(
      Graph.nodes(explicit).map((node) => node.keyMaterial)
    )
  })

  it("refuses a step whose action or compensation is not a flow", () => {
    const notAFlow = (() => Node.succeed(1)) as unknown as Flow.Any

    for (
      const [step, message] of [
        [{ id: "one", action: notAFlow, compensation: named("undo-one") }, "Saga step \"one\" action must be a flow"],
        [
          { id: "one", action: named("do-one"), compensation: notAFlow },
          "Saga step \"one\" compensation must be a flow"
        ]
      ] as const
    ) {
      let refusal: unknown
      try {
        Saga.make({ steps: [step], onFailure: "compensate" })
      } catch (error) {
        refusal = error
      }
      expect(refusal).toBeInstanceOf(PatternError)
      expect((refusal as PatternError).code).toBe("invalid_decorator")
      expect((refusal as PatternError).message).toBe(message)
    }
  })

  it.effect("defaults an omitted policy to compensate at run time", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const result = yield* Saga.run("order", {
        steps: [scripted(trace, "one"), scripted(trace, "two"), scripted(trace, "three", { fails: true })]
      })

      expect(trace).toEqual(["do-one", "do-two", "do-three", "undo-two", "undo-one"])
      expect(result).toEqual({ compensated: true, failure: new Boom({ step: "three" }) })
    }))

  // A compensation that DIES is a failed compensation: the step's undo did not
  // happen, so it belongs in the residue like a typed failure. Letting the
  // defect escape would lose both the residue and the original failure.
  it.effect("reports a compensation that dies and still runs the rest", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [
            scripted(trace, "one"),
            scripted(trace, "two", { compensationDies: true }),
            scripted(trace, "three", { fails: true })
          ],
          onFailure: "compensate"
        })
      )

      expect(trace).toEqual(["do-one", "do-two", "do-three", "undo-two", "undo-one"])
      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("compensation_failed")
      expect((error as PatternError).message).toBe("Saga compensation failed for: two")
    }))
})
