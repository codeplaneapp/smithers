import { Chunk, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"

const writer = (path: string, onConflict: Effects.Declaration["onConflict"] = "serialize"): Node.Any =>
  Node.withEffects(
    Node.dynamic({}),
    Effects.make({ reads: [], writes: [path], mode: "hermetic", onConflict })
  )

/**
 * A shallow plan: one `Node.all` root over `count` leaves. Keys are zero
 * padded so the sorted visit order is the numeric order and the last leaf
 * admitted is the highest index.
 */
const siblings = (count: number, leaf: (index: number) => Node.Any): Node.Any => {
  const members: Record<string, Node.Any> = {}
  for (let index = 0; index < count; index++) members[`n${String(index).padStart(4, "0")}`] = leaf(index)
  return Node.all(members)
}

/**
 * Groups of writers that share one path per group. Every pair inside a group
 * conflicts; no pair across groups does, so the conflict count is the sum of
 * each group's pair count.
 */
const writerGroups = (
  sizes: ReadonlyArray<number>,
  onConflict: Effects.Declaration["onConflict"],
  plain = 0
): { readonly node: Node.Any; readonly conflicts: number; readonly nodes: number } => {
  const members: Record<string, Node.Any> = {}
  let conflicts = 0
  sizes.forEach((size, group) => {
    conflicts += size * (size - 1) / 2
    for (let index = 0; index < size; index++) {
      members[`g${group}w${index}`] = writer(`out/group-${group}`, onConflict)
    }
  })
  for (let index = 0; index < plain; index++) members[`p${index}`] = Node.succeed(index)
  return { node: Node.all(members), conflicts, nodes: 1 + sizes.reduce((sum, size) => sum + size, 0) + plain }
}

const thrown = (build: () => unknown): unknown => {
  try {
    build()
  } catch (error) {
    return error
  }
  throw new Error("expected Graph.build to throw")
}

describe("Graph width limits", () => {
  it("exports fixed limits", () => {
    expect(Graph.maximumGraphNodes).toBe(4096)
    expect(Graph.maximumGraphEdges).toBe(65_536)
    expect(Graph.maximumGraphConflicts).toBe(65_536)
    expect(Graph.maximumPayloadMembers).toBe(100_000)
  })

  it("builds a plan with exactly maximumGraphNodes nodes and rejects one more", () => {
    const atLimit = Graph.build(siblings(Graph.maximumGraphNodes - 1, (index) => Node.succeed(index)))
    expect(Graph.nodes(atLimit)).toHaveLength(Graph.maximumGraphNodes)

    const error = thrown(() => Graph.build(siblings(Graph.maximumGraphNodes, (index) => Node.succeed(index))))
    expect(error).toBeInstanceOf(Graph.GraphBuildError)
    expect(error).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: `root.all.n${Graph.maximumGraphNodes - 1}`
    })
  })

  it("counts synthesized lane merge nodes against maximumGraphNodes", () => {
    // Every laned pair synthesizes one merge node, so `count` writers on one
    // path add `count * (count - 1) / 2` nodes after the visit completes. Each
    // merge also depends on every earlier merge of either writer, so the edge
    // count grows cubically and 40 writers keep it under maximumGraphEdges.
    const writers = 40
    const merges = writers * (writers - 1) / 2
    const plain = Graph.maximumGraphNodes - 1 - writers - merges
    const atLimit = writerGroups([writers], "lane", plain)
    expect(Graph.nodes(Graph.build(atLimit.node))).toHaveLength(Graph.maximumGraphNodes)

    const overLimit = writerGroups([writers], "lane", plain + 1)
    expect(thrown(() => Graph.build(overLimit.node))).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: `lane.merge.${merges - 1}`
    })
  })

  it("records exactly maximumGraphEdges edges and rejects one more", () => {
    // Serialized writers on one path form a complete ordering, so `writers`
    // nodes contribute `writers` structural edges plus one conflict edge per
    // pair. Plain leaves top the count up to the limit one edge at a time.
    const writers = 361
    const structural = writers + writers * (writers - 1) / 2
    const plain = Graph.maximumGraphEdges - structural
    const atLimit = Graph.build(writerGroups([writers], "serialize", plain).node)
    expect(Graph.edges(atLimit)).toHaveLength(Graph.maximumGraphEdges)
    expect(Graph.conflicts(atLimit)).toHaveLength(writers * (writers - 1) / 2)

    expect(thrown(() => Graph.build(writerGroups([writers], "serialize", plain + 1).node))).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: expect.stringMatching(/^root\.all\.g0w\d+$/)
    })
  })

  it("records exactly maximumGraphConflicts conflicts and rejects one more", () => {
    const sizes = [362, 20, 3, 2, 2]
    const atLimit = writerGroups(sizes, "fail")
    expect(atLimit.conflicts).toBe(Graph.maximumGraphConflicts)
    const graph = Graph.build(atLimit.node)
    expect(Graph.conflicts(graph)).toHaveLength(Graph.maximumGraphConflicts)
    expect(Graph.diagnostics(graph).filter((diagnostic) => diagnostic.code === "write_conflict"))
      .toHaveLength(Graph.maximumGraphConflicts)

    const overLimit = writerGroups([...sizes, 2], "fail")
    expect(overLimit.conflicts).toBe(Graph.maximumGraphConflicts + 1)
    expect(thrown(() => Graph.build(overLimit.node))).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: "root.all.g5w1"
    })
  })

  it("builds the widest admissible disjoint-writer plan within a bounded time", () => {
    const node = siblings(Graph.maximumGraphNodes - 1, (index) => writer(`out/${index}`))
    const started = performance.now()
    const graph = Graph.build(node)
    const elapsed = performance.now() - started

    expect(Graph.nodes(graph)).toHaveLength(Graph.maximumGraphNodes)
    expect(Graph.conflicts(graph)).toEqual([])
    expect(elapsed).toBeLessThan(10_000)
  })

  it("reflects exactly maximumPayloadMembers array items and rejects one more", () => {
    const items = (count: number): Array<number> => Array.from({ length: count }, (_, index) => index)

    expect(() => Graph.build(Node.succeed(items(Graph.maximumPayloadMembers)))).not.toThrow()
    const error = thrown(() => Graph.build(Node.succeed(items(Graph.maximumPayloadMembers + 1))))
    expect(error).toBeInstanceOf(Graph.GraphBuildError)
    expect(error).toMatchObject({ code: "payload_too_large", paths: ["$"], nodeId: "root" })
  })

  it("charges a sparse array by its length before materializing holes", () => {
    const sparse: Array<number> = []
    sparse.length = Graph.maximumPayloadMembers + 1

    expect(thrown(() => Graph.build(Node.succeed({ sparse })))).toMatchObject({
      code: "payload_too_large",
      paths: ["$.sparse"],
      nodeId: "root"
    })
  })

  it("charges named array properties as members", () => {
    const decorated = Array.from({ length: Graph.maximumPayloadMembers }, (_, index) => index) as Array<number> & {
      extra?: number
    }
    decorated.extra = 1

    expect(thrown(() => Graph.build(Node.succeed(decorated)))).toMatchObject({
      code: "payload_too_large",
      paths: ["$"],
      nodeId: "root"
    })
  })

  it.each([
    [
      "a plain object",
      (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, 0]))
    ],
    ["a Map", (count: number) => new Map(Array.from({ length: count }, (_, index) => [index, 0]))],
    ["a Set", (count: number) => new Set(Array.from({ length: count }, (_, index) => index))],
    ["a Chunk", (count: number) => Chunk.fromIterable(Array.from({ length: count }, (_, index) => index))],
    ["an ArrayBuffer", (count: number) => new ArrayBuffer(count)],
    ["a typed array view", (count: number) => new Uint8Array(count)]
  ])("bounds %s at maximumPayloadMembers members", (_, make) => {
    // The wrapping object spends one member of the shared budget on `value`.
    expect(() => Graph.build(Node.succeed({ value: make(Graph.maximumPayloadMembers - 1) }))).not.toThrow()
    expect(thrown(() => Graph.build(Node.succeed({ value: make(Graph.maximumPayloadMembers) })))).toMatchObject({
      code: "payload_too_large",
      paths: ["$.value"],
      nodeId: "root"
    })
  })

  it("charges a Map by its intrinsic size when an own size property lies", () => {
    const map = new Map(Array.from({ length: Graph.maximumPayloadMembers + 1 }, (_, index) => [index, 0]))
    Object.defineProperty(map, "size", { value: 0 })

    expect(thrown(() => Graph.build(Node.succeed(map)))).toMatchObject({
      code: "payload_too_large",
      paths: ["$"],
      nodeId: "root"
    })
  })

  it("shares one member budget across every level of one plan value", () => {
    const half = Graph.maximumPayloadMembers / 2
    const level = (count: number): Array<number> => Array.from({ length: count }, (_, index) => index)

    expect(() => Graph.build(Node.succeed({ left: level(half - 1), right: level(half - 1) }))).not.toThrow()
    expect(thrown(() => Graph.build(Node.succeed({ left: level(half), right: level(half) })))).toMatchObject({
      code: "payload_too_large",
      paths: ["$.right"],
      nodeId: "root"
    })
  })

  it("budgets a flow call input separately from the declaration body", () => {
    const items = (count: number): Array<number> => Array.from({ length: count }, (_, index) => index)
    const wide = items(Graph.maximumPayloadMembers)
    const flow = Flow.make({
      input: Schema.Array(Schema.Number),
      output: Schema.Array(Schema.Number),
      body: () => Node.succeed(wide)
    })

    expect(() => Graph.build(flow, wide)).not.toThrow()
    expect(thrown(() => Graph.build(flow, items(Graph.maximumPayloadMembers + 1)))).toMatchObject({
      code: "payload_too_large",
      paths: ["$"],
      nodeId: "root"
    })
  })

  it("shares one budget between a schema's annotations and the value that carries it", () => {
    const carrier = (count: number) => ({
      schema: Schema.String.annotate({ wide: Array.from({ length: count }, (_, index) => index) })
    })

    // The carrier spends one member on `schema` and the annotations record
    // spends one on `wide` before the array itself is charged.
    expect(() => Graph.build(Node.succeed(carrier(Graph.maximumPayloadMembers - 2)))).not.toThrow()
    expect(thrown(() => Graph.build(Node.succeed(carrier(Graph.maximumPayloadMembers - 1))))).toMatchObject({
      code: "payload_too_large",
      paths: ["$.schema.ast.annotations.wide"],
      nodeId: "root"
    })
  })

  it("compares a glob writer against every other writer and skips literal writers on disjoint paths", () => {
    const graph = Graph.build(Node.all({
      docs: writer("docs/index.md"),
      glob: writer("src/**"),
      other: writer("docs/index.md"),
      src: writer("src/index.ts")
    }))

    expect(Graph.conflicts(graph).map((conflict) => [conflict.nodes, conflict.paths])).toEqual([
      [["root.all.docs", "root.all.other"], ["docs/index.md"]],
      [["root.all.glob", "root.all.src"], ["src/index.ts"]]
    ])
  })

  it("records one conflict for literal writers that share several paths", () => {
    const shared = (): Node.Any =>
      Node.withEffects(
        Node.dynamic({}),
        Effects.make({ reads: [], writes: ["out/a", "out/b"], mode: "hermetic", onConflict: "serialize" })
      )
    const graph = Graph.build(Node.all({ left: shared(), right: shared() }))

    expect(Graph.conflicts(graph)).toEqual([
      { nodes: ["root.all.left", "root.all.right"], paths: ["out/a", "out/b"], strategy: "serialize" }
    ])
    expect(Graph.edges(graph).filter((edge) => edge.reason === "conflict")).toEqual([
      { from: "root.all.left", to: "root.all.right", reason: "conflict" }
    ])
  })

  it("lists the width codes as fatal", () => {
    for (const code of ["plan_too_large", "payload_too_large"] as const) {
      expect(Graph.isFatalDiagnostic(new Graph.GraphBuildError({ code, paths: [], nodeId: "root" }))).toBe(true)
    }
  })
})

describe("Graph effect path limits", () => {
  const paths = (count: number, prefix = "out"): Array<string> =>
    Array.from({ length: count }, (_, index) => `${prefix}/${index}`)

  const declaring = (
    reads: ReadonlyArray<string>,
    writes: ReadonlyArray<string>,
    onConflict: Effects.Declaration["onConflict"] = "serialize"
  ): Node.Any => Node.withEffects(Node.dynamic({}), Effects.make({ reads, writes, mode: "hermetic", onConflict }))

  const assembled = (reads: ReadonlyArray<string>, writes: ReadonlyArray<string>): Node.Any =>
    Node.withEffects(Node.dynamic({}), { reads, writes, mode: "hermetic", onConflict: "serialize" })

  const pad = (index: number): string => String(index).padStart(4, "0")

  it("exports fixed effect path limits", () => {
    expect(Graph.maximumEffectPaths).toBe(1024)
    expect(Graph.maximumPlanEffectPaths).toBe(65_536)
  })

  it("refuses two writers that share 20,001 literal paths before any overlap work", () => {
    const shared = paths(20_001)
    const node = Node.all({ left: declaring([], shared), right: declaring([], shared) })

    const started = performance.now()
    const error = thrown(() => Graph.build(node))
    const elapsed = performance.now() - started

    expect(error).toBeInstanceOf(Graph.GraphBuildError)
    expect(error).toMatchObject({ code: "plan_too_large", paths: [], nodeId: "root.all.left" })
    expect(elapsed).toBeLessThan(1_000)
  })

  it("refuses a declaration of 1,000,000 paths by its length before reading a member", () => {
    const million = paths(1_000_000)
    let members = 0
    const observed = new Proxy(million, {
      get: (target, key) => {
        if (typeof key === "string" && /^\d+$/.test(key)) members++
        return Reflect.get(target, key)
      }
    })

    const started = performance.now()
    const error = thrown(() => Graph.build(assembled([], observed)))
    const elapsed = performance.now() - started

    expect(error).toBeInstanceOf(Graph.GraphBuildError)
    expect(error).toMatchObject({ code: "plan_too_large", paths: [], nodeId: "root" })
    expect(members).toBe(0)
    expect(elapsed).toBeLessThan(1_000)
    expect(thrown(() => Graph.build(assembled(million, [])))).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: "root"
    })
  })

  it("copies a caller-assembled iterable no further than the limit", () => {
    // A generator has no length to refuse by, so the copy itself is bounded:
    // it stops one path past the limit instead of draining the iterable.
    let yielded = 0
    function* endless(): Generator<string> {
      while (true) {
        yielded++
        yield `out/${yielded}`
      }
    }
    const iterable = endless() as unknown as ReadonlyArray<string>

    expect(thrown(() => Graph.build(assembled(iterable, [])))).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: "root"
    })
    expect(yielded).toBe(Graph.maximumEffectPaths + 1)

    const within = new Set(paths(Graph.maximumEffectPaths)) as unknown as ReadonlyArray<string>
    const graph = Graph.build(assembled(within, []))
    expect(Graph.effects(graph)[0]?.declared?.reads).toEqual(paths(Graph.maximumEffectPaths))
  })

  it("builds a declaration listing exactly maximumEffectPaths paths and refuses one more", () => {
    const half = Graph.maximumEffectPaths / 2
    const graph = Graph.build(declaring(paths(half, "in"), paths(half)))
    expect(Graph.effects(graph)[0]?.declared?.reads).toHaveLength(half)
    expect(Graph.effects(graph)[0]?.declared?.writes).toHaveLength(half)

    expect(thrown(() => Graph.build(declaring(paths(half, "in"), paths(half + 1))))).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: "root"
    })
  })

  it("admits exactly maximumPlanEffectPaths paths across a plan and refuses one more", () => {
    const writers = Graph.maximumPlanEffectPaths / Graph.maximumEffectPaths
    const members: Record<string, Node.Any> = {}
    for (let index = 0; index < writers; index++) {
      members[`w${pad(index)}`] = declaring([], paths(Graph.maximumEffectPaths, `w${index}`))
    }

    const graph = Graph.build(Node.all(members))
    expect(Graph.nodes(graph)).toHaveLength(writers + 1)
    expect(Graph.conflicts(graph)).toEqual([])

    expect(thrown(() => Graph.build(Node.all({ ...members, x: declaring([], ["extra"]) })))).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: "root.all.x"
    })
  })

  it("counts an inherited envelope at every work node that inherits it", () => {
    const envelope = Effects.make({
      reads: [],
      writes: paths(Graph.maximumEffectPaths),
      mode: "hermetic",
      onConflict: "serialize"
    })
    const inheriting = (children: number): Node.Any =>
      Node.withEffects(siblings(children, () => Node.dynamic({})), envelope)
    // The root declares the envelope once and every dynamic child inherits
    // it, so the plan admits `children + 1` declarations of the maximum size.
    const children = Graph.maximumPlanEffectPaths / Graph.maximumEffectPaths - 1

    const graph = Graph.build(inheriting(children))
    expect(Graph.effects(graph).filter((entry) => entry.effective !== undefined)).toHaveLength(children)
    expect(Graph.conflicts(graph)).toHaveLength(children * (children - 1) / 2)

    expect(thrown(() => Graph.build(inheriting(children + 1)))).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: `root.all.n${pad(children)}`
    })
  })

  it("admits a called flow's envelope once for the call and the body it encloses", () => {
    const called = Flow.make({
      input: Schema.Number,
      output: Schema.Number,
      effects: Effects.make({
        reads: [],
        writes: paths(Graph.maximumEffectPaths),
        mode: "hermetic",
        onConflict: "serialize"
      }),
      body: (value) => Node.succeed(value)
    })
    const calls = Graph.maximumPlanEffectPaths / Graph.maximumEffectPaths

    const graph = Graph.build(siblings(calls, (index) => called(index)))
    expect(Graph.effects(graph)).toHaveLength(calls)

    expect(thrown(() => Graph.build(siblings(calls + 1, (index) => called(index))))).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: `root.all.n${pad(calls)}`
    })
  })

  it("admits a dynamic node's own envelope even when an annotation overrides it", () => {
    const own = Effects.make({
      reads: [],
      writes: paths(Graph.maximumEffectPaths, "own"),
      mode: "hermetic",
      onConflict: "serialize"
    })
    const override = Effects.make({
      reads: [],
      writes: paths(Graph.maximumEffectPaths, "override"),
      mode: "hermetic",
      onConflict: "serialize"
    })
    const overridden = (): Node.Any => Node.withEffects(Node.dynamic({ effects: own }), override)
    // Both declarations reach the graph: the override as the node's declared
    // effects and the node's own envelope inside its key material.
    const count = Graph.maximumPlanEffectPaths / (2 * Graph.maximumEffectPaths)

    const graph = Graph.build(siblings(count, overridden))
    expect(Graph.effects(graph)[0]?.declared?.writes[0]).toBe("override/0")
    expect(Graph.nodes(graph)[1]?.keyMaterial.body).toMatchObject({ _tag: "Dynamic", effects: { writes: own.writes } })

    expect(thrown(() => Graph.build(siblings(count + 1, overridden)))).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: `root.all.n${pad(count)}`
    })
  })

  it("counts a synthesized lane merge as one declaration naming its overlap twice", () => {
    const half = Graph.maximumEffectPaths / 2
    const laned = (shared: number): Node.Any =>
      Node.all({ left: declaring([], paths(shared), "lane"), right: declaring([], paths(shared), "lane") })

    const graph = Graph.build(laned(half))
    const merge = Graph.effects(graph).find((entry) => entry.nodeId === "lane.merge.0")
    expect(merge?.declared?.reads).toHaveLength(half)
    expect(merge?.declared?.writes).toHaveLength(half)

    expect(thrown(() => Graph.build(laned(half + 1)))).toMatchObject({
      code: "plan_too_large",
      paths: [],
      nodeId: "lane.merge.0"
    })
  })

  it("charges the effects of a flow placed in a plan value to the member budget", () => {
    const carrying = (count: number): Node.Any =>
      Node.succeed({
        flow: Flow.make({
          effects: Effects.make({ reads: paths(count, "in"), writes: [], mode: "hermetic", onConflict: "serialize" })
        })
      })

    expect(() => Graph.build(carrying(Graph.maximumEffectPaths + 1))).not.toThrow()
    expect(thrown(() => Graph.build(carrying(Graph.maximumPayloadMembers)))).toMatchObject({
      code: "payload_too_large",
      paths: ["$.flow.effects"],
      nodeId: "root"
    })
  })
})
