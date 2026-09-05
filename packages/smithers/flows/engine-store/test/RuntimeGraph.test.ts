import { KeyMaterial, Plan, Scheduling } from "@smthrs/plan"
import { describe, expect, it } from "vitest"
import * as RuntimeGraph from "../src/internal/RuntimeGraph.ts"
import type { Outcome } from "../src/PlanScheduler.ts"
import { runPromise } from "./Sha256.ts"

const draft = (id: string, dependencies: ReadonlyArray<string> = []): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: id,
    inputs: dependencies.map((from) => ({ _tag: "Pending", from })),
    layers: [],
    capabilities: []
  },
  effects: { reads: [], writes: [], boundaryMode: "hard" }
})
const compile = (nodes: ReadonlyArray<Plan.NodeDraft>) =>
  runPromise(Plan.compile({ planId: "graph", flow: "graph", nodes }))
const ids = (nodes: ReadonlyArray<Plan.PlanNode>) => nodes.map((node) => node.id)
const settle = (graph: RuntimeGraph.RuntimeGraph, id: string, outcome: Outcome) => {
  graph.stage(id, outcome)
  graph.reconcile()
}

describe("RuntimeGraph settlement and generations", () => {
  it("publishes only the reconciled outcome and never settles a retry or rebase twice", async () => {
    const plan = await compile([draft("child", ["root"]), draft("root"), draft("independent")])
    const graph = RuntimeGraph.make(plan.nodes)
    expect(ids(graph.ready())).toEqual(["root", "independent"])
    graph.start("root")
    const state = graph.states.get("root")!
    state.attempts = 2
    state.rebases = 1
    expect(graph.remaining).toBe(3)
    expect(ids(graph.ready())).toEqual(["independent"])
    graph.stage("root", "built")
    graph.stage("root", "failed")
    expect(ids(graph.blocked())).toEqual([])
    graph.reconcile()
    expect(graph.remaining).toBe(2)
    expect(ids(graph.blocked())).toEqual(["child"])
    const before = { ...graph.cost.settlement }
    settle(graph, "root", "failed")
    expect(graph.cost.settlement.edges).toBe(before.edges)
    expect(graph.remaining).toBe(2)
    settle(graph, "child", "skipped")
    settle(graph, "independent", "clean")
    expect(graph.remaining).toBe(0)
    expect(graph.ready()).toEqual([])
    expect(graph.blocked()).toEqual([])
  })

  it("waits for every diamond arm before propagating a failed cone in declaration-ordered waves", async () => {
    const plan = await compile([
      draft("leaf", ["join"]),
      draft("join", ["left", "right"]),
      draft("right", ["root"]),
      draft("left", ["root"]),
      draft("root")
    ])
    const graph = RuntimeGraph.make(plan.nodes)
    settle(graph, "root", "built")
    expect(ids(plan.nodes)).toEqual(["root", "left", "right", "join", "leaf"])
    expect(ids(graph.ready())).toEqual(["left", "right"])
    settle(graph, "left", "failed")
    expect(graph.blocked()).toEqual([])
    settle(graph, "right", "clean")
    expect(ids(graph.blocked())).toEqual(["join"])
    settle(graph, "join", "skipped")
    expect(ids(graph.blocked())).toEqual(["leaf"])
    settle(graph, "leaf", "skipped")
    expect(graph.remaining).toBe(0)
  })

  it("updates blocking contributions without decrementing indegree again", async () => {
    const plan = await compile([draft("a"), draft("b"), draft("child", ["a", "b"])])
    const graph = RuntimeGraph.make(plan.nodes)
    settle(graph, "a", "built")
    settle(graph, "a", "failed")
    settle(graph, "b", "built")
    expect(ids(graph.blocked())).toEqual(["child"])
    expect(graph.remaining).toBe(1)
    settle(graph, "a", "skipped")
    expect(ids(graph.blocked())).toEqual(["child"])
    settle(graph, "a", "clean")
    expect(graph.blocked()).toEqual([])
    expect(ids(graph.ready())).toEqual(["child"])
    settle(graph, "b", "deferred")
    expect(ids(graph.blocked())).toEqual(["child"])
  })

  it("indexes only an admitted suffix and retains prefix state, positions and dependency outcomes", async () => {
    const base = await compile([draft("done"), draft("failed"), draft("running")])
    const graph = RuntimeGraph.make(base.nodes)
    graph.start("running")
    settle(graph, "done", "clean")
    settle(graph, "failed", "failed")
    graph.states.get("running")!.waited = 9
    const grown = await runPromise(Plan.append(base, [
      draft("after-new", ["new"]),
      draft("new", ["done"]),
      draft("bad", ["failed"]),
      draft("wait", ["running"])
    ]))
    const before = { ...graph.cost.update }
    graph.append(Plan.generationNodes(grown))
    expect(graph.cost.update.nodes - before.nodes).toBe(8)
    expect(graph.cost.update.edges - before.edges).toBe(4)
    expect(graph.remaining).toBe(5)
    expect(graph.states.get("running")).toMatchObject({ status: "running", waited: 9 })
    expect(ids(graph.ready())).toEqual(["new"])
    expect(ids(graph.blocked())).toEqual(["bad"])
    expect(ids(grown.nodes)).toEqual(["done", "failed", "running", "new", "after-new", "bad", "wait"])
    expect(graph.candidates(graph.ready())[0]!.order).toBe(3)
    settle(graph, "new", "built")
    expect(ids(graph.ready())).toEqual(["after-new"])
    expect(grown.nodes.slice(0, 3)).toEqual(base.nodes)
  })

  it("deduplicates discovered edges and keeps them out of declared ancestor queries", async () => {
    const plan = await compile([
      draft("root"),
      draft("left", ["root"]),
      draft("right", ["root"]),
      draft("reader", ["left", "right"]),
      draft("deviator"),
      draft("owner")
    ])
    const graph = RuntimeGraph.make(plan.nodes)
    graph.start("left")
    graph.stage("deviator", "built")
    graph.reorder("deviator", ["owner", "owner", "missing", "left", "deviator"])
    graph.reconcile()
    graph.reorder("deviator", ["owner"])
    expect(ids(graph.ready())).toEqual(["root", "owner"])
    settle(graph, "deviator", "failed")
    expect(ids(graph.blocked())).toEqual(["owner"])
    const visited: Array<string> = []
    graph.visitAncestors(plan.nodes[3]!, (node) => visited.push(node.id))
    expect(visited).toEqual(["right", "root", "left"])
    expect(graph.cost.reachability.nodes).toBe(3)
    expect(graph.cost.reachability.edges).toBe(4)
    const ownerAncestors: Array<string> = []
    graph.visitAncestors(plan.nodes[5]!, (node) => ownerAncestors.push(node.id))
    expect(ownerAncestors).toEqual([])
    const grown = await runPromise(Plan.append(plan, [draft("suffix", ["reader"])]))
    const prospective: Array<string> = []
    graph.visitAncestors(grown.nodes.at(-1)!, (node) => prospective.push(node.id))
    expect(prospective).toEqual(["reader", "right", "root", "left"])
  })
})

describe("RuntimeGraph deterministic operation counts", () => {
  for (const size of [127, 128, 129, 1024]) {
    it(`settles a ${size}-node chain with one affected edge per settlement`, async () => {
      const plan = await compile(
        Array.from({ length: size }, (_, i) => draft(String(i), i === 0 ? [] : [String(i - 1)]))
      )
      const graph = RuntimeGraph.make(plan.nodes)
      for (let i = 0; i < size; i++) {
        const before = { ...graph.cost.settlement }
        expect(ids(graph.ready())).toEqual([String(i)])
        graph.start(String(i))
        settle(graph, String(i), "built")
        expect(graph.cost.settlement.nodes - before.nodes).toBe(i === size - 1 ? 2 : 3)
        expect(graph.cost.settlement.edges - before.edges).toBe(i === size - 1 ? 0 : 1)
        expect(graph.cost.settlement.allocations - before.allocations).toBe(0)
      }
      expect(graph.cost.update.nodes).toBe(2 * size)
      expect(graph.cost.settlement.edges).toBe(size - 1)
      expect(graph.cost.frontier.nodes).toBe(size)
      expect(graph.remaining).toBe(0)
    })

    it(`prepares ${size} wide candidates with constant membership work each`, async () => {
      const plan = await compile(Array.from({ length: size }, (_, i) => draft(String(i))))
      const graph = RuntimeGraph.make(plan.nodes)
      const candidates = graph.candidates(graph.ready())
      const admission = Scheduling.make().admit(candidates, { steps: 0, agents: 0 })
      for (const { node } of admission.admitted) graph.start(node.id)
      expect(admission.admitted.map(({ order }) => order)).toEqual(Array.from({ length: size }, (_, i) => i))
      expect(graph.cost.admission).toEqual({ nodes: 2 * size, edges: 0, membership: 2 * size, allocations: size + 1 })
      expect(graph.ready()).toEqual([])
    })
  }
})

describe("RuntimeGraph against an exhaustive state model", () => {
  it("matches every frontier and remaining count on 200 generated DAG histories", async () => {
    let seed = 20260904
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    for (let run = 0; run < 200; run++) {
      const drafts: Array<Plan.NodeDraft> = []
      const size = 2 + random(23)
      for (let i = 0; i < size; i++) {
        drafts.push(draft(String(i), Array.from({ length: i }, (_, j) => String(j)).filter(() => random(4) === 0)))
      }
      for (let i = drafts.length - 1; i > 0; i--) {
        const j = random(i + 1)
        ;[drafts[i], drafts[j]] = [drafts[j]!, drafts[i]!]
      }
      const plan = await compile(drafts)
      const graph = RuntimeGraph.make(plan.nodes)
      const outcomes = new Map<string, Outcome>()
      while (outcomes.size < size) {
        // Independent old semantics: rescan every pending node and every
        // dependency. This model never reads the graph's state or counters.
        const eligible = plan.nodes.filter((node) =>
          !outcomes.has(node.id) && node.dependsOn.every((id) => outcomes.has(id))
        )
        const blocked = eligible.filter((node) =>
          node.dependsOn.some((id) => !["built", "clean"].includes(outcomes.get(id)!))
        )
        const ready = eligible.filter((node) => !blocked.includes(node))
        expect(ids(graph.blocked())).toEqual(ids(blocked))
        expect(ids(graph.ready())).toEqual(ids(ready))
        expect(graph.remaining).toBe(size - outcomes.size)
        if (blocked.length > 0) {
          for (const node of blocked) {
            outcomes.set(node.id, "skipped")
            settle(graph, node.id, "skipped")
          }
        } else {
          const node = ready[random(ready.length)]!
          const outcome = (["built", "clean", "failed", "deferred"] as const)[random(4)]!
          outcomes.set(node.id, outcome)
          graph.start(node.id)
          settle(graph, node.id, outcome)
        }
      }
      expect(graph.remaining).toBe(0)
      expect([...graph.states].map(([id, state]) => [id, state.outcome])).toEqual(
        plan.nodes.map((node) => [node.id, outcomes.get(node.id)])
      )
    }
  })
})
