import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as MergeQueue from "../src/MergeQueue.ts"
import { PatternError } from "../src/PatternError.ts"

const land = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const members = [
  { id: "docs", flow: land },
  { id: "hotfix", flow: land, priority: 5000 },
  { id: "feature", flow: land }
]

const invalidPriorities = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 2 ** 53]

const literals = (graph: Graph.Graph): ReadonlyArray<Record<string, unknown>> =>
  Graph.nodes(graph)
    .filter((node) => node.kind === "FlowCall")
    .map((node) => {
      const first = node.keyMaterial.inputs[0]
      return first !== undefined && first._tag === "Literal" ? first.value as Record<string, unknown> : {}
    })

describe("MergeQueue", () => {
  it("sorts members by descending priority then declaration order", () => {
    expect(MergeQueue.ordered(members, MergeQueue.DefaultPriority).map((member) => member.id)).toEqual([
      "hotfix",
      "docs",
      "feature"
    ])
    expect(MergeQueue.ordered(members, MergeQueue.DefaultPriority).map((member) => member.priority)).toEqual([
      5000,
      1000,
      1000
    ])
  })

  it("declares a serial chain at concurrency 1 in priority order", () => {
    const graph = Graph.build(MergeQueue.make(members, { failurePolicy: "halt" }), "land")

    expect(Graph.diagnostics(graph)).toEqual([])
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(0)
    expect(literals(graph).map((value) => value.id)).toEqual(["hotfix", "docs", "feature"])
  })

  it("gives every member the default priority unless it sets its own, as an annotation", () => {
    const graph = Graph.build(MergeQueue.make(members, { failurePolicy: "halt" }), "land")

    // The scheduler reads the annotation. A priority carried as call input
    // would instead be key material, and re-prioritizing a queue that lands in
    // the same order would re-land every member.
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall").map((node) => node.priority))
      .toEqual([5000, 1000, 1000])
    expect(literals(graph).map((value) => value.priority)).toEqual([undefined, undefined, undefined])
  })

  it("keeps a member's step identity when a priority change does not reorder the queue", () => {
    const body = (priority: number) =>
      Graph.nodes(
        Graph.build(
          MergeQueue.make([{ id: "docs", flow: land }, { id: "hotfix", flow: land, priority }], {
            failurePolicy: "halt"
          }),
          "land"
        )
      ).map((node) => node.keyMaterial.body)

    expect(body(5000)).toEqual(body(7000))
  })

  it("declares one recovery arm per member under the quarantine policy", () => {
    const serial = Graph.build(MergeQueue.make(members, { failurePolicy: "quarantine" }), "land")
    const batched = Graph.build(
      MergeQueue.make(members, { concurrency: 2, failurePolicy: "quarantine" }),
      "land"
    )
    const halting = Graph.build(MergeQueue.make(members, { failurePolicy: "halt" }), "land")

    expect(Graph.nodes(serial).filter((node) => node.kind === "Catch")).toHaveLength(3)
    expect(Graph.nodes(serial).filter((node) => node.kind === "All")).toHaveLength(0)
    expect(Graph.nodes(batched).filter((node) => node.kind === "Catch")).toHaveLength(3)
    expect(Graph.nodes(halting).filter((node) => node.kind === "Catch")).toHaveLength(0)
    expect(Graph.diagnostics(serial)).toEqual([])
    expect(Graph.diagnostics(batched)).toEqual([])
  })

  it("settles a declared quarantine with the runtime result shape", () => {
    const graph = Graph.build(
      MergeQueue.make([{ id: "docs", flow: land }], { failurePolicy: "quarantine" }),
      "land"
    )
    const marker = Graph.nodes(graph)
      .filter((node) => node.kind === "Succeed")
      .map((node) => (node.keyMaterial.body as { readonly _tag: "Succeed"; readonly value: unknown }).value)
      .find(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "_tag" in value &&
          value._tag === "Quarantined"
      )

    expect(marker).toEqual({
      _tag: "Quarantined",
      id: "docs",
      error: { _tag: "PlannedInput", path: [] }
    })
  })

  it("batches by two at concurrency 2", () => {
    const graph = Graph.build(MergeQueue.make(members, { concurrency: 2, failurePolicy: "halt" }), "land")

    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(2)
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(3)
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("rejects an empty queue, a duplicate id, and an invalid bound", () => {
    expect(() => MergeQueue.make([], { failurePolicy: "halt" })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "MergeQueue requires at least one member" })
    )
    expect(() => MergeQueue.make([members[0]!, members[0]!], { failurePolicy: "halt" })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "MergeQueue member ids must be unique" })
    )
    expect(() => MergeQueue.make(members, { concurrency: 0, failurePolicy: "halt" })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "MergeQueue concurrency must be a positive safe integer"
      })
    )
    expect(() => MergeQueue.make(members, { priority: 1.5, failurePolicy: "halt" })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "MergeQueue priority for member \"docs\" must be a safe integer, received 1.5"
      })
    )
  })

  it("refuses every unsafe member priority at declaration time", () => {
    for (const priority of invalidPriorities) {
      expect(() => MergeQueue.ordered([{ id: "unstable", priority }], MergeQueue.DefaultPriority)).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: `MergeQueue priority for member "unstable" must be a safe integer, received ${priority}`
        })
      )
      expect(() => MergeQueue.make([{ id: "unstable", flow: land, priority }], { failurePolicy: "halt" })).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: `MergeQueue priority for member "unstable" must be a safe integer, received ${priority}`
        })
      )
    }
  })

  it.effect("lands members one at a time in priority then declaration order", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const queued = ["docs", "hotfix", "feature"].map((id) => ({
        id,
        ...(id === "hotfix" ? { priority: 5000 } : {}),
        run: () =>
          Effect.gen(function*() {
            trace.push(`start ${id}`)
            yield* Effect.yieldNow
            trace.push(`end ${id}`)
            return id
          })
      }))

      const result = yield* MergeQueue.run("main", { members: queued, failurePolicy: "halt" })

      expect(trace).toEqual([
        "start hotfix",
        "end hotfix",
        "start docs",
        "end docs",
        "start feature",
        "end feature"
      ])
      expect(result.order).toEqual(["hotfix", "docs", "feature"])
      expect(result.landed.map((entry) => entry.id)).toEqual(["hotfix", "docs", "feature"])
      expect(result.quarantined).toEqual([])
    }))

  it.effect("preserves prototype-shaped member ids in declaration and runtime order", () =>
    Effect.gen(function*() {
      const ids = ["__proto__", "constructor", "toString", "normal"]
      const declared = ids.map((id) => ({ id, flow: land }))
      const graph = Graph.build(MergeQueue.make(declared, { failurePolicy: "halt" }), "land")
      expect(literals(graph).map((value) => value.id)).toEqual(ids)

      const result = yield* MergeQueue.run("main", {
        failurePolicy: "halt",
        members: ids.map((id) => ({ id, run: ({ id }) => Effect.succeed(`${id}-value`) }))
      })
      expect(result.order).toEqual(ids)
      expect(result.landed).toEqual(ids.map((id) => ({ id, output: `${id}-value` })))
    }))

  it.effect("stops later members when one fails under halt", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []
      const queued = ["first", "second", "third"].map((id) => ({
        id,
        run: () =>
          Effect.suspend(() => {
            ran.push(id)
            return id === "second" ? Effect.fail(`${id} conflicts`) : Effect.succeed(id)
          })
      }))

      const failure = yield* MergeQueue.run("main", { members: queued, failurePolicy: "halt" }).pipe(Effect.flip)

      expect(failure).toBe("second conflicts")
      expect(ran).toEqual(["first", "second"])
    }))

  it.effect("lands the rest and reports the failure under quarantine", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []
      const queued = ["first", "second", "third"].map((id) => ({
        id,
        run: () =>
          Effect.suspend(() => {
            ran.push(id)
            return id === "second" ? Effect.fail(`${id} conflicts`) : Effect.succeed(id)
          })
      }))

      const result = yield* MergeQueue.run("main", { members: queued, failurePolicy: "quarantine" })

      expect(ran).toEqual(["first", "second", "third"])
      expect(result.landed).toEqual([{ id: "first", output: "first" }, { id: "third", output: "third" }])
      expect(result.quarantined).toEqual([{ id: "second", error: "second conflicts" }])
    }))

  it.effect("never lands more than the concurrency bound at once", () =>
    Effect.gen(function*() {
      // The test holds every started landing on `held`, so the queue cannot make
      // progress on its own: what lands concurrently is what the bound admits,
      // not what the scheduler happened to interleave.
      const held = yield* Latch.make()
      const saturated = yield* Latch.make()
      const entered: Array<string> = []
      let inFlight = 0
      let peak = 0
      const queued = ["a", "b", "c", "d"].map((id) => ({
        id,
        run: () =>
          Effect.gen(function*() {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            entered.push(id)
            if (entered.length === 2) yield* Latch.open(saturated)
            yield* Latch.await(held)
            inFlight -= 1
            return id
          })
      }))

      const running = yield* MergeQueue.run("main", { members: queued, concurrency: 2, failurePolicy: "halt" })
        .pipe(Effect.forkChild({ startImmediately: true }))

      yield* Latch.await(saturated)

      // Both slots are taken and neither can finish, so no third member started.
      expect(entered).toEqual(["a", "b"])
      expect(inFlight).toBe(2)

      yield* Latch.open(held)
      const result = yield* Fiber.join(running)

      expect(result.landed.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"])
      expect(entered).toEqual(["a", "b", "c", "d"])
      expect(peak).toBe(2)
    }))

  it.effect("rejects an empty queue and an invalid bound at runtime", () =>
    Effect.gen(function*() {
      const empty = yield* MergeQueue.run("main", { members: [], failurePolicy: "halt" }).pipe(Effect.flip)
      expect(empty).toBeInstanceOf(PatternError)
      expect(empty.code).toBe("invalid_decorator")
      expect(empty.message).toBe("MergeQueue requires at least one member")

      const bound = yield* MergeQueue.run("main", {
        members: [{ id: "a", run: () => Effect.succeed("a") }],
        concurrency: -1,
        failurePolicy: "halt"
      }).pipe(Effect.flip)
      expect(bound).toBeInstanceOf(PatternError)
      expect(bound.code).toBe("invalid_decorator")
      expect(bound.message).toBe("MergeQueue concurrency must be a positive safe integer")

      const duplicate = yield* MergeQueue.run("main", {
        members: [{ id: "a", run: () => Effect.succeed("a") }, { id: "a", run: () => Effect.succeed("b") }],
        failurePolicy: "halt"
      }).pipe(Effect.flip)
      expect(duplicate).toBeInstanceOf(PatternError)
      expect(duplicate.code).toBe("invalid_decorator")
      expect(duplicate.message).toBe("MergeQueue member ids must be unique")
    }))

  it.effect("refuses every unsafe member priority before running the queue", () =>
    Effect.gen(function*() {
      let ran = 0
      for (const priority of invalidPriorities) {
        const failure = yield* MergeQueue.run("main", {
          members: [{ id: "unstable", priority, run: () => Effect.sync(() => (ran += 1, "landed")) }],
          failurePolicy: "halt"
        }).pipe(Effect.flip)

        expect(failure).toBeInstanceOf(PatternError)
        expect((failure as PatternError).code).toBe("invalid_decorator")
        expect((failure as PatternError).message).toBe(
          `MergeQueue priority for member "unstable" must be a safe integer, received ${priority}`
        )
      }
      expect(ran).toBe(0)
    }))

  it("gives a halting queue and a quarantining queue different topology and identity", () => {
    const material = (failurePolicy: MergeQueue.FailurePolicy) =>
      Graph.nodes(Graph.build(MergeQueue.make(members, { failurePolicy }), "land"))

    const halting = material("halt")
    const quarantining = material("quarantine")

    expect(halting.map((node) => node.kind)).not.toEqual(quarantining.map((node) => node.kind))
    expect(halting.map((node) => node.keyMaterial.body)).not.toEqual(
      quarantining.map((node) => node.keyMaterial.body)
    )
  })
})
