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
    // Six maps wrap successful card values in unambiguous quarantine-protocol
    // envelopes; the other two merge each column's batches.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Map")).toHaveLength(8)
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
    expect(() => Kanban.make({ columns: [], items, concurrency: 1 })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Kanban requires at least one column" })
    )
    expect(() => Kanban.make({ columns, items: [], concurrency: 1 })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Kanban requires at least one item" })
    )
    expect(() => Kanban.make({ columns, items, concurrency: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Kanban concurrency must be a positive safe integer"
      })
    )
  })

  it("refuses duplicate column names in a declaration", () => {
    let refusal: unknown
    try {
      Kanban.make({
        columns: [{ name: "same", flow: step }, { name: "same", flow: step }],
        items: [{ id: "a" }],
        concurrency: 1
      })
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(PatternError)
    expect((refusal as PatternError).code).toBe("invalid_decorator")
    expect((refusal as PatternError).message).toBe("Kanban column names must be unique")
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

  it.effect("does not admit a column appended while a pass is in flight", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const runtimeColumns: Array<Kanban.RuntimeColumn<Kanban.Item, string, never, never>> = []
      const late: Kanban.RuntimeColumn<Kanban.Item, string, never, never> = {
        name: "late",
        run: () => Effect.sync(() => (trace.push("late"), "late-done"))
      }
      runtimeColumns.push({
        name: "first",
        run: () => Effect.sync(() => (trace.push("first"), runtimeColumns.push(late), "first-done"))
      })

      const result = yield* Kanban.run([{ id: "a" }], { columns: runtimeColumns, concurrency: 1 })

      expect(trace).toEqual(["first"])
      expect(result).toEqual({
        board: { a: { first: "first-done" } },
        completed: ["a"],
        failed: [],
        iterations: 1
      })
    }))

  it.effect("materialises prototype-shaped item and column names as own data properties", () =>
    Effect.gen(function*() {
      const names = ["__proto__", "constructor", "toString", "normal"]
      const result = yield* Kanban.run(
        names.map((id) => ({ id })),
        {
          concurrency: 4,
          columns: names.map((name) => ({
            name,
            run: ({ item }) => Effect.succeed(`${item.id}:${name}`)
          }))
        }
      )

      expect(Object.getPrototypeOf(result.board)).toBe(Object.prototype)
      for (const id of names) {
        expect(Object.hasOwn(result.board, id)).toBe(true)
        const row = result.board[id]!
        expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
        for (const column of names) {
          expect(Object.hasOwn(row, column)).toBe(true)
          expect(row[column]).toBe(`${id}:${column}`)
        }
      }
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

  it.effect("evaluates until on the final allowed pass", () =>
    Effect.gen(function*() {
      let calls = 0
      const result = yield* Kanban.run([{ id: "a" }], {
        concurrency: 1,
        maxIterations: 1,
        until: () => {
          calls += 1
          return true
        },
        columns: [{ name: "triage", run: () => Effect.succeed("ok") }]
      })

      expect(result.iterations).toBe(1)
      expect(calls).toBe(1)
    }))

  it.effect("evaluates until once per completed pass before stopping on pass two", () =>
    Effect.gen(function*() {
      let calls = 0
      const result = yield* Kanban.run([{ id: "a" }], {
        concurrency: 1,
        maxIterations: 3,
        until: () => {
          calls += 1
          return calls === 2
        },
        columns: [{ name: "triage", run: () => Effect.succeed("ok") }]
      })

      expect(result.iterations).toBe(2)
      expect(calls).toBe(2)
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

  it.effect("calls onComplete exactly once with the final board", () =>
    Effect.gen(function*() {
      const seen: Array<{ readonly items: ReadonlyArray<Kanban.Item>; readonly board: Kanban.Board<string, never> }> =
        []
      const declaredItems = [{ id: "a" }]
      const result = yield* Kanban.run(declaredItems, {
        concurrency: 1,
        maxIterations: 2,
        columns: [{ name: "triage", run: () => Effect.succeed("ok") }],
        onComplete: (input) => Effect.sync(() => seen.push(input))
      })

      expect(seen).toHaveLength(1)
      expect(seen[0]).toEqual({ items: declaredItems, board: result })

      const without = yield* Kanban.run(declaredItems, {
        concurrency: 1,
        columns: [{ name: "triage", run: () => Effect.succeed("ok") }]
      })
      expect(without).toEqual({
        board: { a: { triage: "ok" } },
        completed: ["a"],
        failed: [],
        iterations: 1
      })
    }))

  it.effect("uses an onComplete failure as the run failure", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(
        Kanban.run([{ id: "a" }], {
          concurrency: 1,
          columns: [{ name: "triage", run: () => Effect.succeed("ok") }],
          onComplete: () => Effect.fail("report failed")
        })
      )

      expect(failure).toBe("report failed")
    }))

  it.effect("rejects an invalid runtime concurrency", () =>
    Effect.gen(function*() {
      const failure = yield* Kanban.run(items, {
        concurrency: 0,
        columns: [{ name: "triage", run: () => Effect.succeed("ok") }]
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Kanban concurrency must be a positive safe integer")
    }))

  it("rejects duplicate item ids", () => {
    expect(() => Kanban.make({ columns, items: [{ id: "a" }, { id: "a" }], concurrency: 1 })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Kanban item ids must be unique" })
    )
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
      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Kanban item ids must be unique")
      expect(ran).toBe(0)
    }))

  it.effect("refuses duplicate column names at runtime before a column runs", () =>
    Effect.gen(function*() {
      let ran = 0
      const duplicate = {
        name: "same",
        run: () => Effect.sync(() => (ran += 1, "ok"))
      }
      const failure = yield* Effect.flip(
        Kanban.run([{ id: "a" }], { concurrency: 1, columns: [duplicate, duplicate] })
      )

      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Kanban column names must be unique")
      expect(ran).toBe(0)
    }))

  it.effect("refuses an empty runtime board before a column runs", () =>
    Effect.gen(function*() {
      let ran = 0
      const failure = yield* Effect.flip(
        Kanban.run([], {
          concurrency: 1,
          columns: [{ name: "triage", run: () => Effect.sync(() => (ran += 1, "ok")) }]
        })
      )

      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Kanban requires at least one item")
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
      expect(unbounded.code).toBe("invalid_decorator")
      expect(unbounded.message).toBe("Kanban until requires maxIterations")

      const negative = yield* Kanban.run(items, {
        concurrency: 1,
        maxIterations: 0,
        until: () => false,
        columns: [column]
      }).pipe(Effect.flip)
      expect(negative.code).toBe("invalid_decorator")
      expect(negative.message).toBe("Kanban maxIterations must be a positive safe integer")

      const empty = yield* Kanban.run(items, { concurrency: 1, columns: [] }).pipe(Effect.flip)
      expect(empty.code).toBe("invalid_decorator")
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

  it("declares from the snapshot make took of its options", () => {
    const other = Flow.make({ input: Schema.Unknown, output: Schema.Unknown, body: () => Node.succeed("other") })
    const mutableColumns = [{ name: "triage", flow: step }, { name: "build", flow: step }]
    const mutableItems = [{ id: "a" }, { id: "b" }]
    const options = { columns: mutableColumns, items: mutableItems, concurrency: 2, onComplete: step }
    const board = Kanban.make(options)
    const before = Graph.nodes(Graph.build(board, "sprint")).map((node) => node.keyMaterial.body)

    // Every edit a caller can make after the call: a swapped column flow, an
    // appended column, a renamed item, an appended item, a widened bound, and
    // a swapped completion flow.
    mutableColumns[0]!.flow = other
    mutableColumns.push({ name: "release", flow: other })
    mutableItems[0]!.id = "z"
    mutableItems.push({ id: "c" })
    options.concurrency = 1
    options.onComplete = other

    const after = Graph.nodes(Graph.build(board, "sprint"))
    expect(after.map((node) => node.keyMaterial.body)).toEqual(before)
    expect(after.filter((node) => node.kind === "FlowCall")).toHaveLength(5)
  })

  it.effect("runs the snapshot run took of its items and columns", () =>
    Effect.gen(function*() {
      const seen: Array<string> = []
      const column: Kanban.RuntimeColumn<Kanban.Item, string, never, never> = {
        name: "triage",
        run: ({ item }) => Effect.sync(() => (seen.push(item.id), "ok"))
      }
      const mutableItems = [{ id: "a" }]
      const mutableColumns = [column]
      const options = { columns: mutableColumns, concurrency: 1 }
      const board = Kanban.run(mutableItems, options)

      // Every edit a caller can make between the call and the execution: a
      // duplicate id the validation already refused, a swapped column, an
      // appended column, and a widened bound.
      mutableItems.push({ id: "a" })
      mutableColumns[0] = { name: "triage", run: () => Effect.sync(() => (seen.push("swapped"), "swapped")) }
      mutableColumns.push({ name: "late", run: () => Effect.sync(() => (seen.push("late"), "late")) })
      options.concurrency = 5

      const result = yield* board
      expect(seen).toEqual(["a"])
      expect(result).toEqual({ board: { a: { triage: "ok" } }, completed: ["a"], failed: [], iterations: 1 })
    }))

  it.effect("keys the board by the id an item carried when run was called", () =>
    Effect.gen(function*() {
      const item = { id: "a" }
      const board = Kanban.run([item], {
        concurrency: 1,
        columns: [{ name: "triage", run: ({ item: card }) => Effect.succeed(card === item) }]
      })

      // The record itself stays the caller's: the column receives the same
      // object. Its id was read once, so the row keeps the original name.
      item.id = "renamed"

      const result = yield* board
      expect(result.board).toEqual({ a: { triage: true } })
      expect(result.completed).toEqual(["a"])
    }))
})
