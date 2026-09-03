import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Panel from "../src/Panel.ts"
import { PatternError } from "../src/PatternError.ts"

const participant = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

describe("Panel", () => {
  it("declares keyed fail-fast fan-out", () => {
    const panel = Panel.make({
      panelists: { one: participant, two: participant },
      moderator: participant
    })

    expect(Flow.isFlow(panel)).toBe(true)
    expect(panel.body?.("topic").ast._tag).toBe("AndThen")
    const graph = Graph.build(panel, "topic")
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
    expect(Graph.nodes(graph).find((node) => node.id === "root.then")?.keyMaterial.inputs).toContainEqual({
      _tag: "Ref",
      from: "root.andThen",
      path: []
    })
  })

  it("rejects an empty panel", () => {
    expect(() => Panel.make({ panelists: {}, moderator: participant })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Panel requires at least one panelist" })
    )
  })

  it("rejects a role named for a panelist the panel does not have", () => {
    expect(() =>
      Panel.make({ panelists: { critic: participant }, moderator: participant, roles: { absent: "nobody" } })
    ).toThrow(expect.objectContaining({
      code: "invalid_decorator",
      message: "Panel declares a role for the unknown panelist \"absent\""
    }))
  })

  it("rejects prototype-shaped roles that are not own panelist names", () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      expect(() =>
        Panel.make({
          panelists: { critic: participant },
          moderator: participant,
          roles: Object.fromEntries([[name, "unknown role"]])
        })
      ).toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: `Panel declares a role for the unknown panelist "${name}"`
      }))
    }
  })

  it.effect("fails run for an invalid concurrency", () =>
    Effect.gen(function*() {
      // A bare `Failure` assertion also passes when the run dies for an
      // unrelated reason, so the refusal is pinned by its typed code.
      const error = yield* Effect.flip(
        Panel.run("topic", {
          panelists: { a: () => Effect.succeed("a") },
          moderator: ({ opinions }) => Effect.succeed(opinions),
          concurrency: 0
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect(error.code).toBe("invalid_decorator")
      expect(error.message).toBe("Panel concurrency must be a positive safe integer, received 0")
    }))

  it("puts each declared role in that panelist's call payload", () => {
    const panel = Panel.make({
      panelists: { critic: participant, builder: participant, quiet: participant },
      moderator: participant,
      roles: { critic: "find the flaw", builder: "find the fix" }
    })
    const graph = Graph.build(panel, "topic")
    const literal = (name: string) =>
      Graph.nodes(graph).find((node) => node.id.endsWith(`.all.${name}`))?.keyMaterial.inputs[0]

    expect(literal("critic")).toEqual({ _tag: "Literal", value: { input: "topic", role: "find the flaw" } })
    expect(literal("builder")).toEqual({ _tag: "Literal", value: { input: "topic", role: "find the fix" } })
    expect(literal("quiet")).toEqual({ _tag: "Literal", value: "topic" })
  })

  it("changes declaration identity when a role changes", () => {
    const identity = (role: string) =>
      Graph.nodes(
        Graph.build(
          Panel.make({ panelists: { critic: participant }, moderator: participant, roles: { critic: role } }),
          "topic"
        )
      ).find((node) => node.id.endsWith(".all.critic"))?.keyMaterial

    expect(identity("find the flaw")).not.toEqual(identity("find the fix"))
  })

  it("bounds the declared fan-out when a concurrency is given", () => {
    const panel = Panel.make({
      panelists: { one: participant, two: participant, three: participant },
      moderator: participant,
      concurrency: 2
    })
    const graph = Graph.build(panel, "topic")

    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(2)
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(4)
  })

  // Each panelist parks on a shared gate the test holds shut, so what the
  // assertions read is how many the bound ADMITTED, not how the fibers
  // happened to interleave around a yield.
  it.effect("starts one panelist at a time at width one", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make(false)
      const started: Array<string> = []
      const first = yield* Latch.make(false)
      const panelist = (name: string) => () =>
        Effect.gen(function*() {
          started.push(name)
          yield* first.open
          yield* gate.await
          return `${name}-said`
        })

      const fiber = yield* Effect.forkChild(
        Panel.run("topic", {
          panelists: { a: panelist("a"), b: panelist("b"), c: panelist("c") },
          moderator: ({ opinions }) => Effect.succeed(opinions),
          concurrency: 1
        }),
        { startImmediately: true }
      )
      // `a` holds the only slot, so no sibling can have started.
      yield* first.await
      expect(started).toEqual(["a"])

      yield* gate.open
      const opinions = yield* Fiber.join(fiber)

      expect(started).toEqual(["a", "b", "c"])
      expect(opinions).toEqual({ a: "a-said", b: "b-said", c: "c-said" })
    }))

  it.effect("holds three panelists in flight together at width three", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make(false)
      const arrivals = { a: yield* Latch.make(false), b: yield* Latch.make(false), c: yield* Latch.make(false) }
      const started: Array<string> = []
      const panelist = (name: "a" | "b" | "c") => () =>
        Effect.gen(function*() {
          started.push(name)
          yield* arrivals[name].open
          yield* gate.await
          return `${name}-said`
        })

      const fiber = yield* Effect.forkChild(
        Panel.run("topic", {
          panelists: { a: panelist("a"), b: panelist("b"), c: panelist("c") },
          moderator: ({ opinions }) => Effect.succeed(opinions),
          concurrency: 3
        }),
        { startImmediately: true }
      )
      // All three arrivals resolve only while all three are parked at once. A
      // narrower bound never opens the third and the test times out.
      yield* Effect.all([arrivals.a.await, arrivals.b.await, arrivals.c.await])
      expect(started).toHaveLength(3)

      yield* gate.open
      const opinions = yield* Fiber.join(fiber)

      expect(opinions).toEqual({ a: "a-said", b: "b-said", c: "c-said" })
    }))

  it.effect("keys opinions by panelist name whatever the completion order", () =>
    Effect.gen(function*() {
      const settled: Array<string> = []
      const panelist = (name: string, yields: number) => () =>
        Effect.gen(function*() {
          for (let index = 0; index < yields; index++) yield* Effect.yieldNow
          settled.push(name)
          return `${name}-said`
        })

      const seen = yield* Panel.run("topic", {
        panelists: { alpha: panelist("alpha", 4), beta: panelist("beta", 2), gamma: panelist("gamma", 0) },
        moderator: ({ input, opinions }) => Effect.succeed({ input, opinions })
      })

      expect(settled).toEqual(["gamma", "beta", "alpha"])
      expect(seen.input).toBe("topic")
      expect(Object.keys(seen.opinions)).toEqual(["alpha", "beta", "gamma"])
      expect(seen.opinions).toEqual({ alpha: "alpha-said", beta: "beta-said", gamma: "gamma-said" })
    }))

  it.effect("hands the moderator own properties for prototype-shaped panelist names", () =>
    Effect.gen(function*() {
      const names = ["__proto__", "constructor", "toString", "normal"]
      const opinions = yield* Panel.run("topic", {
        panelists: Object.fromEntries(
          names.map((name) => [name, () => Effect.succeed(`${name}-opinion`)])
        ),
        moderator: ({ opinions }) => Effect.succeed(opinions)
      })

      expect(Object.getPrototypeOf(opinions)).toBe(Object.prototype)
      for (const name of names) {
        expect(Object.hasOwn(opinions, name)).toBe(true)
        expect(opinions[name]).toBe(`${name}-opinion`)
      }
    }))

  it.effect("fails run with a typed PatternError for an empty panel", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        Panel.run("topic", {
          panelists: {} as Readonly<Record<string, () => Effect.Effect<string>>>,
          moderator: () => Effect.succeed("none")
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect(error.code).toBe("invalid_decorator")
      expect(error.message).toBe("Panel requires at least one panelist")
    }))
})
