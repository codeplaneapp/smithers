/**
 * Deterministic graph tests in the mould of Skyframe's `GraphTester`: a graph
 * is declared as data, compiled, and asserted on. Nothing here touches a
 * clock, a filesystem, or a network — `docs/specs/Concepts/Build Phases.md`
 * makes that a law, and a test that needed any of them would be evidence the
 * law was broken.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as KeyMaterial from "../src/KeyMaterial.ts"
import * as Plan from "../src/Plan.ts"
import * as PlanDiff from "../src/PlanDiff.ts"
import { withCrypto, withCryptoFailure } from "./Crypto.ts"

export const effects = (
  reads: ReadonlyArray<string>,
  writes: ReadonlyArray<string>
): Plan.NodeEffects => ({ reads, writes, boundaryMode: "hard" })

export const draft = (
  id: string,
  options: {
    readonly body?: unknown
    readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
    readonly reads?: ReadonlyArray<string>
    readonly writes?: ReadonlyArray<string>
    readonly removes?: ReadonlyArray<string>
  } & Omit<Plan.NodeDraft, "id" | "material" | "effects"> = {}
): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: options.body ?? { action: id },
    inputs: options.inputs ?? [],
    layers: [],
    capabilities: []
  },
  effects: {
    ...effects(options.reads ?? [], options.writes ?? []),
    ...(options.removes === undefined ? {} : { removes: options.removes })
  },
  ...(options.kind === undefined ? {} : { kind: options.kind }),
  ...(options.priority === undefined ? {} : { priority: options.priority }),
  ...(options.conflictStrategy === undefined ? {} : { conflictStrategy: options.conflictStrategy }),
  ...(options.runtimeStrategy === undefined ? {} : { runtimeStrategy: options.runtimeStrategy })
})

export const compile = (nodes: ReadonlyArray<Plan.NodeDraft>, planId = "plan-1") =>
  Plan.compile({ planId, flow: "example/Build", nodes })

const keyOf = (plan: Plan.Plan, id: string) => plan.nodes.find((node) => node.id === id)!.key

describe("Plan.compile", () => {
  it.effect("orders topologically, keys every node, and defaults its annotations", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("late", { inputs: [{ _tag: "Ref", from: "early", path: [] }] }),
        draft("early")
      ]))
      expect(plan.nodes.map((node) => node.id)).toEqual(["early", "late"])
      expect(plan.nodes.every((node) => node.key.startsWith("key1_"))).toBe(true)
      expect(plan.nodes[0]).toMatchObject({ kind: "step", priority: 0, strategy: "serialize", runtime: "delay-rebase" })
      expect(plan.digest).toBe(plan.baseDigest)
      expect(plan.generation).toBe(0)
    }))

  it.effect("re-keys the dependent cone and nothing else when a leaf's declaration changes", () =>
    Effect.gen(function*() {
      const before = yield* withCrypto(compile([
        draft("source", { body: { seed: 1 } }),
        draft("derived", { inputs: [{ _tag: "Ref", from: "source", path: [] }] }),
        draft("sibling")
      ]))
      const after = yield* withCrypto(compile([
        draft("source", { body: { seed: 2 } }),
        draft("derived", { inputs: [{ _tag: "Ref", from: "source", path: [] }] }),
        draft("sibling")
      ]))
      expect(keyOf(after, "source")).not.toBe(keyOf(before, "source"))
      expect(keyOf(after, "derived")).not.toBe(keyOf(before, "derived"))
      expect(keyOf(after, "sibling")).toBe(keyOf(before, "sibling"))
      expect(after.digest).not.toBe(before.digest)
    }))

  it.effect("renaming a node changes no key — ids are lookup addresses, never hashed", () =>
    Effect.gen(function*() {
      const left = yield* withCrypto(compile([draft("a"), draft("b", { inputs: [{ _tag: "Pending", from: "a" }] })]))
      const right = yield* withCrypto(compile([
        draft("renamed", { body: { action: "a" } }),
        draft("b", { inputs: [{ _tag: "Pending", from: "renamed" }] })
      ]))
      expect(keyOf(right, "b")).toBe(keyOf(left, "b"))
    }))

  it.effect("serializes overlapping writers in declaration order without re-keying them", () =>
    Effect.gen(function*() {
      const disjoint = yield* withCrypto(compile([draft("first", { writes: ["out"] }), draft("second")]))
      const plan = yield* withCrypto(compile([
        draft("first", { writes: ["out", "log"] }),
        draft("second", { writes: ["out"] })
      ]))
      const second = plan.nodes.find((node) => node.id === "second")!
      expect(second.dependsOn).toEqual(["first"])
      expect(second.conflicts).toEqual([{
        with: "first",
        paths: ["out"],
        strategy: "serialize",
        runtime: "delay-rebase"
      }])
      expect(plan.nodes[0]!.conflicts).toEqual([{
        with: "second",
        paths: ["out"],
        strategy: "serialize",
        runtime: "delay-rebase"
      }])
      // The ordering edge is not key material: a serialized node computes the
      // same result, so it must keep its cache hit.
      expect(keyOf(plan, "second")).toBe(keyOf(disjoint, "second"))
    }))

  it.effect("uses conservative pattern overlap for conflicts and reader-after-writer edges", () =>
    Effect.gen(function*() {
      const writer: Plan.NodeDraft = {
        ...draft("a-tree-writer"),
        effects: {
          reads: [],
          writes: [{ _tag: "TreeArtifact", path: "dist" }],
          boundaryMode: "hard"
        }
      }
      const globWriter: Plan.NodeDraft = {
        ...draft("z-glob-writer"),
        effects: {
          reads: [],
          writes: [{ _tag: "Glob", include: ["dist/**/*.js"] }],
          boundaryMode: "hard"
        }
      }
      const reader: Plan.NodeDraft = {
        ...draft("reader"),
        effects: {
          reads: [{ _tag: "Glob", include: ["dist/**"] }],
          writes: [],
          boundaryMode: "hard"
        }
      }
      const plan = yield* withCrypto(compile([writer, globWriter, reader]))
      expect(plan.nodes.find((node) => node.id === "z-glob-writer")!.dependsOn).toEqual(["a-tree-writer"])
      expect(plan.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual([
        "a-tree-writer",
        "z-glob-writer"
      ])
    }))

  it.effect("names a glob when a conservative glob conflict is serialized", () =>
    Effect.gen(function*() {
      const pattern = { _tag: "Glob" as const, include: ["dist/**"] as const }
      const patterned = (id: string): Plan.NodeDraft => ({
        ...draft(id),
        effects: { reads: [], writes: [pattern], boundaryMode: "hard" }
      })
      const plan = yield* withCrypto(compile([
        patterned("a-pattern"),
        patterned("b-pattern")
      ]))
      expect(plan.nodes[0]!.conflicts[0]!.paths).toEqual(["dist/**"])
    }))

  it.effect("gives both writers lane annotations when either asks for a lane", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("first", { writes: ["out"] }),
        draft("second", { writes: ["out"], conflictStrategy: "lane", runtimeStrategy: "stop-merge" })
      ]))
      expect(plan.nodes.map((node) => node.conflicts[0]?.strategy)).toEqual(["lane", "lane"])
      expect(plan.nodes.map((node) => node.conflicts[0]?.runtime)).toEqual(["stop-merge", "stop-merge"])
      // A lane pair gains no ordering edge — the lanes run concurrently.
      expect(plan.nodes.find((node) => node.id === "second")!.dependsOn).toEqual([])
    }))

  it.effect("refuses an overlap a declaration promised could not happen", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(compile([
        draft("first", { writes: ["out"], conflictStrategy: "fail" }),
        draft("second", { writes: ["out"] })
      ]))
      expect(failure).toMatchObject({ code: "overlap_forbidden" })
    }))

  it.effect("does not call writers a dependency path already orders a conflict", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("first", { writes: ["out"] }),
        draft("middle", { inputs: [{ _tag: "Ref", from: "first", path: [] }] }),
        draft("second", { writes: ["out"], inputs: [{ _tag: "Ref", from: "middle", path: [] }] })
      ]))
      expect(plan.nodes.flatMap((node) => node.conflicts)).toEqual([])
    }))

  it.effect("rejects a cycle, an unknown dependency, and a duplicate id", () =>
    Effect.gen(function*() {
      expect(
        yield* withCryptoFailure(compile([
          draft("a", { inputs: [{ _tag: "Ref", from: "b", path: [] }] }),
          draft("b", { inputs: [{ _tag: "Ref", from: "a", path: [] }] })
        ]))
      ).toMatchObject({ code: "cycle" })
      expect(yield* withCryptoFailure(compile([draft("a", { inputs: [{ _tag: "Pending", from: "ghost" }] })])))
        .toMatchObject({ code: "unknown_dependency" })
      expect(yield* withCryptoFailure(compile([draft("a"), draft("a")]))).toMatchObject({ code: "duplicate_node" })
    }))

  it.effect("treats __proto__ as an ordinary node id and dependency address", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("__proto__"),
        draft("consumer", { inputs: [{ _tag: "Ref", from: "__proto__", path: [] }] })
      ]))

      expect(plan.nodes.map((node) => node.id)).toEqual(["__proto__", "consumer"])
      expect(plan.nodes[1]!.dependsOn).toEqual(["__proto__"])
      expect(plan.nodes.every((node) => node.key.startsWith("key1_"))).toBe(true)
    }))
})

/**
 * The reader-after-writer pass. Before it existed, `overlap` compared write
 * sets against write sets only, so a node reading what another node wrote was
 * ordered by nothing and the wavefront could admit both in the same round —
 * the reader measuring pre-producer bytes and caching that as legitimate.
 */
describe("Plan.compile reader-after-writer edges", () => {
  const acyclic = (plan: Plan.Plan): boolean => {
    const order = new Map(plan.nodes.map((node, index) => [node.id, index]))
    const edges = new Map(plan.nodes.map((node) => [node.id, node.dependsOn]))
    const state = new Map<string, "visiting" | "done">()
    const visit = (id: string): boolean => {
      const mark = state.get(id)
      if (mark === "done") return true
      if (mark === "visiting") return false
      state.set(id, "visiting")
      for (const next of edges.get(id) ?? []) if (!visit(next)) return false
      state.set(id, "done")
      return true
    }
    return [...order.keys()].every(visit)
  }

  it.effect("treats a declared removal as a write for ordering and for conflict detection", () =>
    Effect.gen(function*() {
      // A removal moves a path's content exactly as a write does: a reader that
      // runs before it sees different bytes than one that runs after, and two
      // nodes that both claim a path's post-state conflict whether either of
      // them claims it by creating the path or by deleting it.
      const ordered = yield* withCrypto(compile([
        draft("remover", { writes: ["remover.out"], removes: ["stale"] }),
        draft("reader", { reads: ["stale"] })
      ]))
      expect(ordered.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual(["remover"])

      const conflicting = yield* withCrypto(compile([
        draft("writer", { writes: ["shared"] }),
        draft("remover", { writes: ["remover.out"], removes: ["shared"] })
      ]))
      expect(conflicting.nodes.find((node) => node.id === "remover")!.conflicts).toMatchObject([
        { with: "writer", paths: ["shared"] }
      ])
    }))

  it.effect("orders a reader behind the node that writes what it reads", () =>
    Effect.gen(function*() {
      const unrelated = yield* withCrypto(compile([
        draft("writer", { writes: ["out"] }),
        draft("reader", { reads: ["other"] })
      ]))
      const plan = yield* withCrypto(compile([
        draft("writer", { writes: ["out"] }),
        draft("reader", { reads: ["out"] })
      ]))
      const reader = plan.nodes.find((node) => node.id === "reader")!
      expect(reader.dependsOn).toEqual(["writer"])
      // An ordering edge, not a conflict: nothing was double-written.
      expect(plan.nodes.flatMap((node) => node.conflicts)).toEqual([])
      // And ordering is not key material, so the reader keeps its cache hit.
      expect(keyOf(plan, "reader")).toBe(keyOf(unrelated, "reader"))
      expect(keyOf(plan, "writer")).toBe(keyOf(unrelated, "writer"))
    }))

  it.effect("puts the writer first even when the reader was declared first", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("reader", { reads: ["out"] }),
        draft("writer", { writes: ["out"] })
      ]))
      expect(plan.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual(["writer"])
      expect(acyclic(plan)).toBe(true)
    }))

  it.effect("adds nothing when a dependency path already orders the pair", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("writer", { writes: ["out"] }),
        draft("middle", { inputs: [{ _tag: "Ref", from: "writer", path: [] }] }),
        draft("reader", { reads: ["out"], inputs: [{ _tag: "Ref", from: "middle", path: [] }] })
      ]))
      expect(plan.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual(["middle"])
    }))

  it.effect("leaves the pair alone rather than closing a cycle", () =>
    Effect.gen(function*() {
      // The graph already orders the writer AFTER the reader. A declared
      // dependency outranks an inferred ordering.
      const plan = yield* withCrypto(compile([
        draft("reader", { reads: ["out"] }),
        draft("writer", { writes: ["out"], inputs: [{ _tag: "Ref", from: "reader", path: [] }] })
      ]))
      expect(plan.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual([])
      expect(plan.nodes.find((node) => node.id === "writer")!.dependsOn).toEqual(["reader"])
      expect(acyclic(plan)).toBe(true)
    }))

  it.effect("never gives a node an edge to itself for reading its own write", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("both", { reads: ["out"], writes: ["out"] })]))
      expect(plan.nodes[0]!.dependsOn).toEqual([])
    }))

  it.effect("visits a diamond of existing edges once while searching for the pair", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("base"),
        draft("left", { inputs: [{ _tag: "Ref", from: "base", path: [] }] }),
        draft("right", { inputs: [{ _tag: "Ref", from: "base", path: [] }] }),
        draft("writer", { writes: ["out"] }),
        draft("reader", {
          reads: ["out"],
          inputs: [{ _tag: "Ref", from: "left", path: [] }, { _tag: "Ref", from: "right", path: [] }]
        })
      ]))
      expect(plan.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual(["left", "right", "writer"])
      expect(acyclic(plan)).toBe(true)
    }))

  it.effect("keeps a whole read-write chain acyclic and ordered", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("c", { reads: ["b.out"], writes: ["c.out"] }),
        draft("a", { writes: ["a.out"] }),
        draft("b", { reads: ["a.out"], writes: ["b.out"] })
      ]))
      expect(acyclic(plan)).toBe(true)
      expect(plan.nodes.find((node) => node.id === "b")!.dependsOn).toEqual(["a"])
      expect(plan.nodes.find((node) => node.id === "c")!.dependsOn).toEqual(["b"])
    }))
})

describe("Plan.append", () => {
  it.effect("lands a reader-after-writer edge on the new node only", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("recorded-reader", { reads: ["out"] })]))
      const grown = yield* withCrypto(Plan.append(base, [draft("late-writer", { writes: ["out"] })]))
      // The frozen node's row is never rewritten, so it gains no edge.
      expect(grown.nodes[0]).toEqual(base.nodes[0])
      expect(grown.nodes[1]!.dependsOn).toEqual([])

      const writerFirst = yield* withCrypto(compile([draft("recorded-writer", { writes: ["out"] })]))
      const withReader = yield* withCrypto(
        Plan.append(writerFirst, [draft("late-reader", { reads: ["out"] })])
      )
      expect(withReader.nodes[0]).toEqual(writerFirst.nodes[0])
      expect(withReader.nodes[1]!.dependsOn).toEqual(["recorded-writer"])
    }))

  it.effect("grows the plan without rewriting a single recorded node", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root", { writes: ["out"] })]))
      const grown = yield* withCrypto(
        Plan.append(base, [draft("child", { inputs: [{ _tag: "Ref", from: "root", path: [] }] })])
      )
      expect(grown.nodes[0]).toEqual(base.nodes[0])
      expect(grown.generation).toBe(1)
      expect(grown.baseDigest).toBe(base.baseDigest)
      expect(grown.digest).not.toBe(base.digest)
      expect(Plan.generationNodes(grown).map((node) => node.id)).toEqual(["child"])
      expect(grown.nodes[1]!.generation).toBe(1)
    }))

  it.effect("annotates a conflict discovered during elaboration on the new node only", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root", { writes: ["out"] })]))
      const grown = yield* withCrypto(Plan.append(base, [draft("late", { writes: ["out"] })]))
      expect(grown.nodes[0]!.conflicts).toEqual([])
      expect(grown.nodes[1]!.conflicts).toEqual([{
        with: "root",
        paths: ["out"],
        strategy: "serialize",
        runtime: "delay-rebase"
      }])
      expect(grown.nodes[1]!.dependsOn).toEqual(["root"])
    }))

  it.effect("refuses to append a node id the plan already holds", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      expect(yield* withCryptoFailure(Plan.append(base, [draft("root")]))).toMatchObject({ code: "duplicate_node" })
    }))
})

describe("PlanDiff.diff", () => {
  it.effect("reports added, removed, unchanged, and re-keyed nodes with attribution", () =>
    Effect.gen(function*() {
      const before = yield* withCrypto(compile([
        draft("source", { body: { seed: 1 } }),
        draft("derived", { inputs: [{ _tag: "Pending", from: "source" }] }),
        draft("dropped")
      ]))
      const after = yield* withCrypto(compile([
        draft("source", { body: { seed: 2 } }),
        draft("derived", { inputs: [{ _tag: "Pending", from: "source" }] }),
        draft("fresh")
      ]))
      const result = PlanDiff.diff(before, after)
      expect(result.added).toEqual(["fresh"])
      expect(result.removed).toEqual(["dropped"])
      expect(result.unchanged).toEqual([])
      expect(result.rekeyed.map((entry) => entry.id).sort()).toEqual(["derived", "source"])
      expect(result.rekeyed.find((entry) => entry.id === "source")!.changed).toEqual(["body"])
      // The dependent re-keyed because its upstream did, and the report says so.
      expect(result.rekeyed.find((entry) => entry.id === "derived")!.changed).toEqual(["input[0]"])
    }))

  it.effect("attributes every declaration field that can move a key", () =>
    Effect.gen(function*() {
      const material = (overrides: Partial<KeyMaterial.KeyMaterial>): Plan.NodeDraft => ({
        id: "node",
        material: {
          version: KeyMaterial.version,
          kind: "sealed",
          body: 1,
          inputs: [{ _tag: "Literal", value: 1 }],
          layers: ["a"],
          capabilities: ["fs:read"],
          effects: { net: false },
          ...overrides
        },
        effects: effects([], [])
      })
      const before = yield* withCrypto(compile([material({})]))
      const after = yield* withCrypto(compile([
        material({
          body: 2,
          layers: ["b"],
          capabilities: ["fs:write"],
          effects: { net: true },
          inputs: [{ _tag: "Literal", value: 2 }, { _tag: "Literal", value: 3 }]
        })
      ]))
      expect(PlanDiff.diff(before, after).rekeyed[0]!.changed).toEqual([
        "body",
        "layers",
        "capabilities",
        "effects",
        "input[0]",
        "input[1]"
      ])
    }))

  it.effect("says nothing changed when nothing did", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("only")]))
      expect(PlanDiff.diff(plan, plan)).toEqual({ added: [], removed: [], rekeyed: [], unchanged: ["only"] })
    }))

  it.effect("reports a material version bump as its own attribution", () =>
    Effect.gen(function*() {
      const before = yield* withCrypto(compile([draft("node")]))
      const after: Plan.Plan = {
        ...before,
        nodes: [{
          ...before.nodes[0]!,
          key: Schema.decodeUnknownSync(Plan.KeyDigest)(`key1_${"0".repeat(64)}`),
          material: {
            ...before.nodes[0]!.material,
            version: "flows/key-material/v2" as KeyMaterial.KeyMaterial["version"]
          }
        }]
      }
      expect(PlanDiff.diff(before, after).rekeyed[0]!.changed).toEqual(["version"])
    }))

  it.effect("does not blame an unchanged upstream reference for a local edit", () =>
    Effect.gen(function*() {
      const graph = (body: unknown) => [
        draft("source"),
        draft("derived", { body, inputs: [{ _tag: "Ref", from: "source", path: [] }] })
      ]
      // Two-key bodies declared in opposite orders: the attribution report is
      // order-insensitive, so only the value change is blamed.
      const before = yield* withCrypto(compile(graph({ v: 1, w: 0 })))
      const after = yield* withCrypto(compile(graph({ w: 0, v: 2 })))
      expect(PlanDiff.diff(before, after).rekeyed).toEqual([
        { id: "derived", from: keyOf(before, "derived"), to: keyOf(after, "derived"), changed: ["body"] }
      ])
    }))

  it.effect("compares structurally rather than by key order", () =>
    Effect.gen(function*() {
      const node = (body: unknown): Plan.NodeDraft => ({
        id: "node",
        material: {
          version: KeyMaterial.version,
          kind: "sealed",
          body,
          inputs: [],
          layers: [],
          capabilities: []
        },
        effects: effects([], [])
      })
      const before = yield* withCrypto(compile([node({ a: 1, b: [1, "x", null] })]))
      const reordered = yield* withCrypto(compile([node({ b: [1, "x", null], a: 1 })]))
      expect(PlanDiff.diff(before, reordered).unchanged).toEqual(["node"])
    }))
})

describe("Plan.compile effects validation", () => {
  // Drafts are typed values, never decoded rows, so the `FileSet.Pattern`
  // schema filter has not seen them: admission is where absolute and aliased
  // spellings — which defeat exact-string overlap detection — are refused.
  it.effect("refuses an absolute declared path", () =>
    Effect.gen(function*() {
      const error = yield* withCryptoFailure(compile([draft("node", { writes: ["/etc/passwd"] })]))
      expect(error).toMatchObject({ code: "invalid_effects" })
    }))

  it.effect("refuses upward traversal and aliasing spellings", () =>
    Effect.gen(function*() {
      for (const spelling of ["../escape.txt", "./out.txt", "out//x.txt"]) {
        const error = yield* withCryptoFailure(compile([draft("node", { reads: [spelling] })]))
        expect(error).toMatchObject({ code: "invalid_effects" })
      }
    }))

  it.effect("refuses a glob whose include leaves the workspace", () =>
    Effect.gen(function*() {
      const error = yield* withCryptoFailure(compile([{
        ...draft("node"),
        effects: { reads: [{ _tag: "Glob", include: ["/abs/**"] }], writes: [], boundaryMode: "hard" }
      }]))
      expect(error).toMatchObject({ code: "invalid_effects" })
    }))

  it.effect("refuses a path declared as both a write and a removal", () =>
    Effect.gen(function*() {
      const error = yield* withCryptoFailure(compile([draft("node", { writes: ["a.txt"], removes: ["a.txt"] })]))
      expect(error).toMatchObject({ code: "invalid_effects" })
    }))

  it.effect("refuses a removal a write glob or tree output covers", () =>
    Effect.gen(function*() {
      const viaGlob = yield* withCryptoFailure(compile([{
        ...draft("node"),
        effects: {
          reads: [],
          writes: [{ _tag: "Glob", include: ["out/*.txt"] }],
          removes: ["out/stale.txt"],
          boundaryMode: "hard"
        }
      }]))
      expect(viaGlob).toMatchObject({ code: "invalid_effects" })
      const viaTree = yield* withCryptoFailure(compile([{
        ...draft("node"),
        effects: {
          reads: [],
          writes: [{ _tag: "TreeArtifact", path: "dist" }],
          removes: ["dist/old.bin"],
          boundaryMode: "hard"
        }
      }]))
      expect(viaTree).toMatchObject({ code: "invalid_effects" })
    }))

  it.effect("admits disjoint writes and removals", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("node", { writes: ["a.txt"], removes: ["b.txt"] })]))
      expect(plan.nodes).toHaveLength(1)
    }))
})
