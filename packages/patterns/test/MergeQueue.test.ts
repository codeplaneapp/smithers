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
    expect(literals(graph).map((value) => value.member)).toEqual(["hotfix", "docs", "feature"])
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

  it("batches by two at concurrency 2", () => {
    const graph = Graph.build(MergeQueue.make(members, { concurrency: 2, failurePolicy: "halt" }), "land")

    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(2)
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(3)
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("rejects an empty queue, a duplicate id, and an invalid bound", () => {
    expect(() => MergeQueue.make([], { failurePolicy: "halt" })).toThrow(PatternError)
    expect(() => MergeQueue.make([members[0]!, members[0]!], { failurePolicy: "halt" })).toThrow(PatternError)
    expect(() => MergeQueue.make(members, { concurrency: 0, failurePolicy: "halt" })).toThrow(PatternError)
    expect(() => MergeQueue.make(members, { priority: 1.5, failurePolicy: "halt" })).toThrow(PatternError)
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

      const bound = yield* MergeQueue.run("main", {
        members: [{ id: "a", run: () => Effect.succeed("a") }],
        concurrency: -1,
        failurePolicy: "halt"
      }).pipe(Effect.flip)
      expect(bound).toBeInstanceOf(PatternError)

      const duplicate = yield* MergeQueue.run("main", {
        members: [{ id: "a", run: () => Effect.succeed("a") }, { id: "a", run: () => Effect.succeed("b") }],
        failurePolicy: "halt"
      }).pipe(Effect.flip)
      expect(duplicate).toBeInstanceOf(PatternError)
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
