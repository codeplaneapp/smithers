import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Kanban from "../src/Kanban.ts"
import { PatternError } from "../src/PatternError.ts"

const step = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const items = [{ id: "a" }, { id: "b" }, { id: "c" }]
const columns = [{ name: "triage", flow: step }, { name: "build", flow: step }]

describe("Kanban", () => {
  it("declares one call per item per column", () => {
    const board = Kanban.make({ columns, items, concurrency: 3 })

    expect(Flow.isFlow(board)).toBe(true)
    const graph = Graph.build(board, "sprint")
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(6)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(2)
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("batches a column at the concurrency bound and adds the completion call", () => {
    const graph = Graph.build(Kanban.make({ columns, items, concurrency: 2, onComplete: step }), "sprint")

    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(7)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(4)
    expect(Graph.nodes(graph).filter((node) => node.kind === "Map")).toHaveLength(2)
  })

  it("declares one recovery arm per card so a rejected card leaves its column alone", () => {
    const graph = Graph.build(Kanban.make({ columns, items, concurrency: 3 }), "sprint")

    // Three cards through two columns: six calls, six arms. Without them the
    // first rejected card fails its column's join and interrupts every card
    // beside it, which is not the board `run` works.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(6)
    expect(Graph.nodes(graph).find((node) => node.id.endsWith("all.a.recover"))?.keyMaterial.body).toMatchObject({
      _tag: "Succeed",
      value: { _tag: "Quarantined", member: "a" }
    })
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("carries each item's previous column result into the next column", () => {
    const graph = Graph.build(Kanban.make({ columns, items, concurrency: 3 }), "sprint")
    const later = Graph.nodes(graph)
      .filter((node) => node.kind === "FlowCall")
      .filter((node) => {
        const first = node.keyMaterial.inputs[0]
        return first !== undefined && first._tag === "Literal" &&
          (first.value as { readonly column?: unknown }).column === "build"
      })

    expect(later).toHaveLength(3)
    for (const node of later) {
      expect(node.keyMaterial.inputs.some((ref) => ref._tag === "Ref" && ref.path.length > 0)).toBe(true)
    }
  })

  it("rejects an empty board and an invalid concurrency", () => {
    expect(() => Kanban.make({ columns: [], items, concurrency: 1 })).toThrow(PatternError)
    expect(() => Kanban.make({ columns, items: [], concurrency: 1 })).toThrow(PatternError)
    expect(() => Kanban.make({ columns, items, concurrency: 0 })).toThrow(PatternError)
  })

  it.effect("finishes a column for every item before the next column starts", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []

      const result = yield* Kanban.run(items, {
        concurrency: 3,
        columns: columns.map((column) => ({
          name: column.name,
          run: ({ column: name, item, previous }) =>
            Effect.gen(function*() {
              trace.push(`start ${name}:${item.id}`)
              yield* Effect.yieldNow
              trace.push(`end ${name}:${item.id}`)
              return previous === undefined ? name : `${String(previous)}>${name}`
            })
        }))
      })

      expect(trace.indexOf("end triage:a")).toBeLessThan(trace.indexOf("start build:a"))
      expect(trace.indexOf("end triage:c")).toBeLessThan(trace.indexOf("start build:a"))
      expect(result.completed).toEqual(["a", "b", "c"])
      expect(result.board.a).toEqual({ triage: "triage", build: "triage>build" })
      expect(result.failed).toEqual([])
      expect(result.iterations).toBe(1)
    }))

  it.effect("never runs more items at once than the per-column concurrency bound", () =>
    Effect.gen(function*() {
      // The test holds every started item on `held`, so the column cannot make
      // progress on its own: what runs concurrently is what the bound admits,
      // not what the scheduler happened to interleave.
      const held = yield* Latch.make()
      const saturated = yield* Latch.make()
      const entered: Array<string> = []
      let inFlight = 0
      let peak = 0

      const running = yield* Kanban.run([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], {
        concurrency: 2,
        columns: [{
          name: "triage",
          run: ({ item }) =>
            Effect.gen(function*() {
              inFlight += 1
              peak = Math.max(peak, inFlight)
              entered.push(item.id)
              if (entered.length === 2) yield* Latch.open(saturated)
              yield* Latch.await(held)
              inFlight -= 1
              return "ok"
            })
        }]
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Latch.await(saturated)

      // Both slots are taken and neither can finish, so no third item started.
      expect(entered).toEqual(["a", "b"])
      expect(inFlight).toBe(2)

      yield* Latch.open(held)
      const result = yield* Fiber.join(running)

      expect(result.completed).toEqual(["a", "b", "c", "d"])
      expect(entered).toEqual(["a", "b", "c", "d"])
      expect(peak).toBe(2)
    }))

  it.effect("drops a failed item and lets the rest finish the board", () =>
    Effect.gen(function*() {
      const seen: Array<string> = []

      const result = yield* Kanban.run(items, {
        concurrency: 3,
        columns: columns.map((column) => ({
          name: column.name,
          run: ({ column: name, item }) =>
            Effect.suspend(() => {
              seen.push(`${name}:${item.id}`)
              return item.id === "b" && name === "triage"
                ? Effect.fail("b is blocked")
                : Effect.succeed(name)
            })
        }))
      })

      expect(result.completed).toEqual(["a", "c"])
      expect(result.failed).toEqual([{ id: "b", column: "triage", error: "b is blocked" }])
      expect(seen).toEqual(["triage:a", "triage:b", "triage:c", "build:a", "build:c"])
      expect(result.board.b).toEqual(undefined)
    }))

  it.effect("stops the until loop at maxIterations", () =>
    Effect.gen(function*() {
      let passes = 0

      const result = yield* Kanban.run([{ id: "a" }], {
        concurrency: 1,
        maxIterations: 3,
        until: () => false,
        columns: [{
          name: "triage",
          run: () =>
            Effect.sync(() => {
              passes += 1
              return "ok"
            })
        }]
      })

      expect(passes).toBe(3)
      expect(result.iterations).toBe(3)
    }))

  it.effect("stops the until loop as soon as the predicate holds", () =>
    Effect.gen(function*() {
      let passes = 0

      const result = yield* Kanban.run([{ id: "a" }], {
        concurrency: 1,
        maxIterations: 5,
        until: (board) => board.iterations === 2,
        columns: [{
          name: "triage",
          run: () =>
            Effect.sync(() => {
              passes += 1
              return "ok"
            })
        }]
      })

      expect(passes).toBe(2)
      expect(result.iterations).toBe(2)
    }))

  it.effect("runs maxIterations passes when no predicate is given", () =>
    Effect.gen(function*() {
      let passes = 0
      const column = {
        name: "triage",
        run: () =>
          Effect.sync(() => {
            passes += 1
            return "ok"
          })
      }

      const bounded = yield* Kanban.run([{ id: "a" }], { concurrency: 1, maxIterations: 3, columns: [column] })

      expect(passes).toBe(3)
      expect(bounded.iterations).toBe(3)

      passes = 0
      const once = yield* Kanban.run([{ id: "a" }], { concurrency: 1, columns: [column] })

      expect(passes).toBe(1)
      expect(once.iterations).toBe(1)
    }))

  it.effect("rejects an invalid runtime concurrency", () =>
    Effect.gen(function*() {
      const failure = yield* Kanban.run(items, {
        concurrency: 0,
        columns: [{ name: "triage", run: () => Effect.succeed("ok") }]
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
    }))

  it("rejects duplicate item ids", () => {
    expect(() => Kanban.make({ columns, items: [{ id: "a" }, { id: "a" }], concurrency: 1 })).toThrow(PatternError)
  })

  it.effect("rejects duplicate item ids at runtime instead of collapsing the board", () =>
    Effect.gen(function*() {
      let ran = 0

      const failure = yield* Kanban.run([{ id: "a" }, { id: "a" }], {
        concurrency: 2,
        columns: [{
          name: "triage",
          run: () =>
            Effect.sync(() => {
              ran += 1
              return "ok"
            })
        }]
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.message).toBe("Kanban item ids must be unique")
      expect(ran).toBe(0)
    }))

  it.effect("refuses an unbounded until loop and an invalid bound", () =>
    Effect.gen(function*() {
      const column = { name: "triage", run: () => Effect.succeed("ok") }

      const unbounded = yield* Kanban.run(items, {
        concurrency: 1,
        until: () => false,
        columns: [column]
      }).pipe(Effect.flip)
      expect(unbounded.message).toBe("Kanban until requires maxIterations")

      const negative = yield* Kanban.run(items, {
        concurrency: 1,
        maxIterations: 0,
        until: () => false,
        columns: [column]
      }).pipe(Effect.flip)
      expect(negative.message).toBe("Kanban maxIterations must be a positive safe integer")

      const empty = yield* Kanban.run(items, { concurrency: 1, columns: [] }).pipe(Effect.flip)
      expect(empty.message).toBe("Kanban requires at least one column")
    }))

  it("gives two concurrency bounds different step identity at the same topology", () => {
    const material = (concurrency: number) =>
      Graph.nodes(Graph.build(Kanban.make({ columns, items: [{ id: "a" }], concurrency }), "sprint"))

    const one = material(1)
    const two = material(2)

    expect(one.map((node) => node.kind)).toEqual(two.map((node) => node.kind))
    expect(one.map((node) => node.keyMaterial.body)).not.toEqual(two.map((node) => node.keyMaterial.body))
  })
})
