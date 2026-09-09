import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as DelegationChain from "../src/DelegationChain.ts"
import * as Escalation from "../src/Escalation.ts"
import { PatternError } from "../src/PatternError.ts"
import * as ReviewLoop from "../src/ReviewLoop.ts"

const rung = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

// Each flow echoes its own name, so a built graph can name the flow behind
// every `FlowCall` node.
const named = (name: string) =>
  Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    body: Node.capture({ name }, (input) => Node.succeed({ from: name, input }))
  })

const calledFlows = (graph: Graph.Graph): ReadonlyArray<unknown> =>
  Graph.nodes(graph)
    .filter((node) => node.kind === "FlowCall")
    .map((call) => {
      const body = Graph.nodes(graph).find((node) => node.id === `${call.id}.flow`)?.keyMaterial.body
      return (body as { readonly value: { readonly from: string } }).value.from
    })

describe("Escalation", () => {
  it("declares every bounded escalation rung", () => {
    const escalation = Escalation.make({ rungs: [rung, rung], accept: rung })

    expect(Flow.isFlow(escalation)).toBe(true)
    expect(escalation.body?.("request").ast._tag).toBe("AndThen")
    const graph = Graph.build(escalation, "request")
    const calls = Graph.nodes(graph).filter((node) => node.kind === "FlowCall")
    expect(calls).toHaveLength(4)
    expect(calls[1]?.keyMaterial.inputs).toContainEqual({
      _tag: "Ref",
      from: "root.andThen",
      path: []
    })
  })

  it("rejects an empty ladder", () => {
    let refusal: unknown
    try {
      Escalation.make({ rungs: [], accept: rung })
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(PatternError)
    expect((refusal as PatternError).code).toBe("invalid_decorator")
  })

  it("declares every rung and the exhausted terminal when no accept flow is available", () => {
    const graph = Graph.build(Escalation.make({ rungs: [named("cheap"), named("strong")] }), "request")

    expect(calledFlows(graph)).toEqual(["cheap", "strong"])
    expect(Graph.nodes(graph).at(-1)?.keyMaterial.body).toEqual({
      _tag: "Succeed",
      value: {
        level: 1,
        result: { _tag: "PlannedInput", path: [] },
        accepted: false,
        exhausted: true
      }
    })
  })

  it("declares the fallback as the last flow call", () => {
    const graph = Graph.build(
      Escalation.make({
        rungs: [named("cheap"), named("strong")],
        accept: named("accept"),
        fallback: named("human")
      }),
      "request"
    )
    const calls = calledFlows(graph)

    expect(calls).toHaveLength(5)
    expect(calls.at(-1)).toBe("human")
  })

  it("declares a per-rung escalateIf instead of the shared accept", () => {
    const graph = Graph.build(
      Escalation.make({
        rungs: [{ flow: named("cheap"), escalateIf: named("cheap-check") }, named("strong")],
        accept: named("accept")
      }),
      "request"
    )
    expect(calledFlows(graph)).toEqual(["cheap", "cheap-check", "strong", "accept"])
  })

  it.effect("stops operational escalation after acceptance", () =>
    Effect.gen(function*() {
      const attempted: Array<string> = []
      const reached = yield* Escalation.run("request", {
        rungs: [
          () =>
            Effect.sync(() => {
              attempted.push("first")
              return "draft"
            }),
          () =>
            Effect.sync(() => {
              attempted.push("second")
              return "accepted"
            }),
          () =>
            Effect.sync(() => {
              attempted.push("third")
              return "unreachable"
            })
        ],
        accept: (value) => Effect.succeed(value === "accepted")
      })

      expect(reached).toEqual({ level: 1, result: "accepted", exhausted: false })
      expect(attempted).toEqual(["first", "second"])
    }))

  it.effect("uses one own-property acceptance vocabulary across escalation, review, and delegation", () =>
    Effect.gen(function*() {
      const acceptedForms: ReadonlyArray<unknown> = [
        true,
        "approved",
        { approved: true },
        { accepted: true }
      ]
      const inherited = Object.create({ approved: true }) as unknown
      const nearMisses: ReadonlyArray<unknown> = [
        { approved: "yes" },
        { accepted: 1 },
        { approved: false },
        "Approved",
        inherited
      ]

      for (const decision of acceptedForms) {
        const reached = yield* Escalation.run("request", {
          rungs: [() => Effect.succeed("cheap"), () => Effect.succeed("expensive")],
          accept: () => Effect.succeed(decision)
        })
        const reviewed = yield* ReviewLoop.run("draft", {
          maxRounds: 2,
          produce: (input) => Effect.succeed(input),
          review: () => Effect.succeed(decision),
          revise: ({ output }) => Effect.succeed(`${output}-revised`)
        })

        expect(Escalation.accepted(decision)).toBe(true)
        expect(ReviewLoop.accepted(decision)).toBe(true)
        expect(DelegationChain.accepted(decision)).toBe(true)
        expect(reached).toEqual({ level: 0, result: "cheap", exhausted: false })
        expect(reviewed).toEqual({ _tag: "Approved", output: "draft" })
      }

      for (const decision of nearMisses) {
        const reached = yield* Escalation.run("request", {
          rungs: [() => Effect.succeed("cheap"), () => Effect.succeed("expensive")],
          accept: () => Effect.succeed(decision)
        })
        const reviewed = yield* ReviewLoop.run("draft", {
          maxRounds: 2,
          produce: (input) => Effect.succeed(input),
          review: () => Effect.succeed(decision),
          revise: ({ output }) => Effect.succeed(`${output}-revised`)
        })

        expect(Escalation.accepted(decision)).toBe(false)
        expect(ReviewLoop.accepted(decision)).toBe(false)
        expect(DelegationChain.accepted(decision)).toBe(false)
        expect(reached).toEqual({
          level: 1,
          result: "expensive",
          accepted: false,
          exhausted: true
        })
        expect(reviewed).toEqual({
          _tag: "Exhausted",
          output: "draft-revised",
          review: decision
        })
      }
    }))

  it.effect("escalates on the default predicate when no accept flow is supplied", () =>
    Effect.gen(function*() {
      const attempted: Array<number> = []
      const reached = yield* Escalation.run("request", {
        rungs: [
          () =>
            Effect.sync(() => {
              attempted.push(0)
              return { ok: false }
            }),
          () =>
            Effect.sync(() => {
              attempted.push(1)
              return { ok: true }
            })
        ]
      })

      expect(reached).toEqual({ level: 1, result: { ok: true }, exhausted: false })
      expect(attempted).toEqual([0, 1])
    }))

  it("escalates on a failure marker and settles on anything else", () => {
    expect(Escalation.defaultEscalate(undefined)).toBe(true)
    expect(Escalation.defaultEscalate({ error: "boom" })).toBe(true)
    expect(Escalation.defaultEscalate({ failed: true })).toBe(true)
    expect(Escalation.defaultEscalate({ ok: false })).toBe(true)
    expect(Escalation.defaultEscalate({ ok: true })).toBe(false)
    expect(Escalation.defaultEscalate({ error: false })).toBe(false)
    expect(Escalation.defaultEscalate("done")).toBe(false)
  })

  it.effect("stops at a rung whose escalateIf refuses even when accept would escalate", () =>
    Effect.gen(function*() {
      const attempted: Array<number> = []
      const reached = yield* Escalation.run("request", {
        rungs: [
          {
            run: () =>
              Effect.sync(() => {
                attempted.push(0)
                return "cheap"
              }),
            escalateIf: () => Effect.succeed(false)
          },
          () =>
            Effect.sync(() => {
              attempted.push(1)
              return "strong"
            })
        ],
        accept: () => Effect.succeed(false)
      })

      expect(reached).toEqual({ level: 0, result: "cheap", exhausted: false })
      expect(attempted).toEqual([0])
    }))

  it.effect("hands each escalateIf its own rung level", () =>
    Effect.gen(function*() {
      const levels: Array<number> = []
      yield* Escalation.run("request", {
        rungs: [
          { run: () => Effect.succeed("a"), escalateIf: (_result, level) => Effect.succeed(levels.push(level) > 0) },
          { run: () => Effect.succeed("b"), escalateIf: (_result, level) => Effect.succeed(levels.push(level) < 0) }
        ]
      })

      expect(levels).toEqual([0, 1])
    }))

  it.effect("runs the fallback only after every rung escalates", () =>
    Effect.gen(function*() {
      let fallbacks = 0
      const fallback = () =>
        Effect.sync(() => {
          fallbacks = fallbacks + 1
          return "human"
        })

      const reached = yield* Escalation.run("request", {
        rungs: [() => Effect.succeed({ ok: false }), () => Effect.succeed({ ok: false })],
        fallback
      })
      expect(reached).toEqual({ level: 2, result: "human", exhausted: false })
      expect(fallbacks).toBe(1)

      const early = yield* Escalation.run("request", {
        rungs: [() => Effect.succeed({ ok: true }), () => Effect.succeed({ ok: false })],
        fallback
      })
      expect(early).toEqual({ level: 0, result: { ok: true }, exhausted: false })
      expect(fallbacks).toBe(1)
    }))

  it.effect("returns the last result when the ladder is exhausted without a fallback", () =>
    Effect.gen(function*() {
      const exhausted = yield* Escalation.run("request", {
        rungs: [() => Effect.succeed({ ok: false }), () => Effect.succeed({ ok: false, note: "last" })]
      })

      expect(exhausted).toEqual({
        level: 1,
        result: { ok: false, note: "last" },
        accepted: false,
        exhausted: true
      })
    }))

  it.effect("does not admit a rung appended while the run is in flight", () =>
    Effect.gen(function*() {
      const attempted: Array<string> = []
      const rungs: Array<(input: string) => Effect.Effect<{ readonly ok: boolean }>> = []
      const late = () => Effect.sync(() => (attempted.push("late"), { ok: true }))
      rungs.push(() =>
        Effect.sync(() => {
          attempted.push("first")
          rungs.push(late)
          return { ok: false }
        })
      )

      const result = yield* Escalation.run("request", { rungs })

      expect(attempted).toEqual(["first"])
      expect(result).toEqual({
        level: 0,
        result: { ok: false },
        accepted: false,
        exhausted: true
      })
    }))

  it.effect("fails run for an empty ladder", () =>
    Effect.gen(function*() {
      // A bare `Failure` assertion also passes when the run dies for an
      // unrelated reason, so the refusal is pinned by its typed code.
      const error = yield* Effect.flip(
        Escalation.run("request", { rungs: [] as ReadonlyArray<(input: string) => Effect.Effect<string>> })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect(error.code).toBe("invalid_decorator")
    }))
})
