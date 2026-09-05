/** Local graph-mechanics benchmark. Run only after scheduler equivalence passes.
 * It excludes plan compilation, filesystem work, SQL, and dispatch execution.
 * Each timed implementation first proves identical admission/completion order.
 */
import { KeyMaterial, Plan, Scheduling } from "@smthrs/plan"
import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import * as RuntimeGraph from "../src/internal/RuntimeGraph.ts"
import { runPromise } from "./Sha256.ts"

const reference = (plan: Plan.Plan) => {
  const states = new Map(plan.nodes.map((node) => [node.id, "pending"]))
  const policy = Scheduling.make()
  const queue: Array<Plan.PlanNode> = []
  let nodesVisited = 0
  let edgesVisited = 0
  const admit = () => {
    // Retain the old all-node readiness scan and dependency-state allocation.
    const pending = plan.nodes.filter((node) => {
      nodesVisited++
      return states.get(node.id) === "pending"
    })
    const ready = pending.filter((node) => {
      const dependencies = node.dependsOn.map((id) => {
        edgesVisited++
        return states.get(id)
      })
      return dependencies.every((status) => status === "settled")
    })
    const order = new Map(plan.nodes.map((node, index) => [node.id, index]))
    const decision = policy.admit(ready.map((node) => ({ node, order: order.get(node.id)!, waited: 0 })), {
      steps: 0,
      agents: 0
    })
    for (const { node } of decision.admitted) {
      states.set(node.id, "running")
      queue.push(node)
    }
  }
  admit()
  for (let cursor = 0; cursor < queue.length; cursor++) {
    states.set(queue[cursor]!.id, "settled")
    admit()
  }
  return { order: queue.map((node) => node.id), nodesVisited, edgesVisited }
}

const indexed = (plan: Plan.Plan) => {
  const graph = RuntimeGraph.make(plan.nodes)
  const policy = Scheduling.make()
  const queue: Array<Plan.PlanNode> = []
  const admit = () => {
    const decision = policy.admit(graph.candidates(graph.ready()), { steps: 0, agents: 0 })
    for (const { node } of decision.admitted) {
      graph.start(node.id)
      queue.push(node)
    }
  }
  admit()
  for (let cursor = 0; cursor < queue.length; cursor++) {
    graph.stage(queue[cursor]!.id, "built")
    graph.reconcile()
    admit()
  }
  assert.equal(graph.remaining, 0)
  return { order: queue.map((node) => node.id), cost: graph.cost }
}

const median = (values: Array<number>) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

for (const shape of ["chain", "wide"] as const) {
  for (const size of [256, 1024, 4096]) {
    const plan = await runPromise(Plan.compile({
      planId: `benchmark-${shape}-${size}`,
      flow: "benchmark",
      nodes: Array.from({ length: size }, (_, i) => ({
        id: String(i),
        material: {
          version: KeyMaterial.version,
          kind: "sealed" as const,
          body: i,
          inputs: shape === "chain" && i > 0 ? [{ _tag: "Pending" as const, from: String(i - 1) }] : [],
          layers: [],
          capabilities: []
        },
        effects: { reads: [], writes: [], boundaryMode: "hard" as const }
      }))
    }))
    const expected = reference(plan)
    const actual = indexed(plan)
    assert.deepEqual(actual.order, expected.order)
    const timings = { reference: [] as Array<number>, indexed: [] as Array<number> }
    // Alternate first runner to reduce a fixed warm-up/order advantage.
    for (let repetition = 0; repetition < 7; repetition++) {
      for (const name of repetition % 2 === 0 ? ["reference", "indexed"] as const : ["indexed", "reference"] as const) {
        const start = performance.now()
        if (name === "reference") reference(plan)
        else indexed(plan)
        timings[name].push(performance.now() - start)
      }
    }
    console.log(JSON.stringify({
      node: process.version,
      shape,
      size,
      samples: 7,
      medianMs: { reference: median(timings.reference), indexed: median(timings.indexed) },
      referenceNodesVisited: expected.nodesVisited,
      referenceEdgesVisited: expected.edgesVisited,
      indexedCost: actual.cost
    }))
  }
}
