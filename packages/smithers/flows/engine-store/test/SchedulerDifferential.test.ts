import { Plan } from "@smthrs/plan"
import { describe, expect, it } from "vitest"
import { compile, draft, drive, type Scenario } from "./SchedulerDifferentialHarness.ts"
import { runPromise } from "./Sha256.ts"

const compare = async (scenario: Scenario) => {
  const expected = await drive(scenario, true)
  const actual = await drive(scenario, false)
  expect(actual).toEqual(expected)
  return actual
}

describe("indexed scheduler against the captured pre-index scheduler", () => {
  for (const shape of ["chain", "diamond", "wide", "random"] as const) {
    for (let sample = 0; sample < 8; sample++) {
      it(`${shape}, seed ${20260904 + sample}, priorities, aging, failed cones, selection and replay`, async () => {
        let seed = 20260904 + sample
        const random = (max: number) => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
          return seed % max
        }
        const nodes: Array<Plan.NodeDraft> = []
        const fail = new Set<string>()
        const defer = new Set<string>()
        const count = 8 + random(17)
        for (let i = 0; i < count; i++) {
          const id = `node-${i}`
          const dependencies = shape === "wide" || i === 0 ?
            []
            : shape === "chain" ?
            [`node-${i - 1}`]
            : shape === "diamond" ?
            (i % 3 === 0 ? [`node-${i - 1}`, `node-${i - 2}`] : [`node-${i - i % 3}`])
            : Array.from({ length: i }, (_, j) => `node-${j}`).filter(() => random(5) === 0)
          nodes.push(draft(id, dependencies, {
            kind: random(3) === 0 ? "agent" : "step",
            priority: sample === 7 ? Number.MAX_SAFE_INTEGER - random(4) : random(11) - 5
          }))
          if (sample % 2 === 1 && random(7) === 0) fail.add(id)
          if (sample % 3 === 1 && random(4) === 0) defer.add(id)
        }
        const plan = await compile(nodes)
        const observed = await compare({
          plan,
          fail,
          defer,
          concurrency: { steps: 1 + sample % 3, agents: 1 },
          interleave: true,
          replay: true
        })
        expect(observed.topologies).toEqual([plan])
        expect(observed.reports[0]!.settlements.map((s) => s.planKey)).toEqual(plan.nodes.map((node) => node.key))
        expect(observed.reports.every((report) => report.settlements.length === count)).toBe(true)
      })
    }
  }

  for (const runtimeStrategy of ["delay-rebase", "stop-merge"] as const) {
    for (const conflictStrategy of ["serialize", "lane"] as const) {
      for (const attempts of [1, 2, 3]) {
        it(`${conflictStrategy}/${runtimeStrategy}, conflict count ${attempts}, append and frozen prefix`, async () => {
          const effects = { reads: [], writes: ["shared.out"], boundaryMode: "hard" as const }
          const plan = await compile([
            draft("winner", [], { effects, conflictStrategy, runtimeStrategy }),
            draft("loser", [], { effects, conflictStrategy, runtimeStrategy }),
            draft("consumer", ["loser"]),
            draft("loser+merge"),
            draft("independent", [], { kind: "agent", priority: 3 })
          ])
          const observed = await compare({
            plan,
            conflicts: new Map([["loser", attempts]]),
            concurrency: { steps: 2, agents: 1 },
            replay: true,
            interleave: true,
            suffix: [draft("appended", ["winner"])]
          })
          expect(observed.topologies.at(-1)!.nodes.slice(0, plan.nodes.length)).toEqual(plan.nodes)
          if (runtimeStrategy === "stop-merge") {
            expect(observed.reports[0]!.appended).toEqual(["loser+merge#1"])
            expect(observed.reports[0]!.settlements.find((s) => s.nodeId === "loser")!.outcome).toBe("skipped")
          } else {
            expect(observed.reports[0]!.settlements.find((s) => s.nodeId === "loser")).toMatchObject({
              attempts: Math.min(attempts + 1, 3),
              rebases: Math.min(attempts, 2),
              outcome: attempts === 3 ? "failed" : "built"
            })
          }
        })
      }
    }
  }

  for (const deviation of ["Fail", "Reorder", "FactorOut"] as const) {
    it(`reconciles ${deviation} before downstream admission, including repeated discovered owners`, async () => {
      const plan = await compile([
        draft("deviator", [], { effects: { reads: [], writes: ["own.out"], boundaryMode: "expected" }, priority: 4 }),
        draft("owner"),
        draft("consumer", ["deviator"]),
        draft("independent")
      ])
      const observed = await compare({
        plan,
        deviation,
        reorder: ["owner", "owner", "missing"],
        concurrency: { steps: 1 },
        replay: true
      })
      expect(observed.reports[0]!.verdicts[0]!.verdict._tag).toBe(deviation)
      expect(observed.reports[0]!.settlements.find((s) => s.nodeId === "consumer")!.outcome).toBe(
        deviation === "Fail" ? "skipped" : "built"
      )
    })
  }

  it("keeps plan keys distinct from measured dispatch keys through content-stable and changed declarations", async () => {
    const nodes = [draft("source"), draft("derived", ["source"]), draft("sibling"), draft("sibling-child", ["sibling"])]
    const plan = await compile(nodes)
    const source = nodes[0]!
    const changed = await runPromise(Plan.compile({
      planId: "changed",
      flow: "diff",
      nodes: [{ ...source, material: { ...source.material, body: { action: "edited" } } }, ...nodes.slice(1)]
    }))
    const observed = await compare({ plan, changed, concurrency: { steps: 1 } })
    const before = observed.reports[0]!.settlements
    const after = observed.reports[1]!.settlements
    expect(after[1]!.planKey).not.toBe(before[1]!.planKey)
    expect(after[1]!.dispatchKey).toBe(before[1]!.dispatchKey)
    // This expected cache behavior also runs through the frozen scheduler:
    // a concurrent persistence-policy regression is visible independently of
    // the readiness implementation, rather than hidden by the comparison.
    expect(after.map((s) => s.outcome)).toEqual(["built", "clean", "clean", "clean"])
  })

  it("handles an empty plan and a subsequently admitted generation", async () => {
    const plan = await compile([])
    const observed = await compare({ plan, suffix: [draft("new")], replay: true })
    expect(observed.reports[0]!.settlements).toEqual([])
    expect(observed.reports.at(-1)!.settlements.map((s) => s.nodeId)).toEqual(["new"])
  })

  it("records debt only for runnable sinks, while a failed cone is skipped first", async () => {
    const plan = await compile([
      draft("broken"),
      draft("blocked-sink", ["broken"]),
      draft("good"),
      draft("deferred-sink", ["good"])
    ])
    const observed = await compare({
      plan,
      fail: new Set(["broken"]),
      defer: new Set(["blocked-sink", "deferred-sink"]),
      concurrency: { steps: 1 }
    })
    expect(observed.executed.map((node) => node.nodeId)).toEqual(["broken", "good"])
    expect(observed.reports[0]!.settlements.map((node) => [node.nodeId, node.outcome])).toEqual([
      ["broken", "failed"],
      ["blocked-sink", "skipped"],
      ["good", "built"],
      ["deferred-sink", "deferred"]
    ])
    const debts = observed.records.filter((entry) => entry.type === "flows.engine.selection-deferred")
    expect(debts.map((entry) => (entry.payload as { nodeId: string }).nodeId)).toEqual(["deferred-sink"])
  })

  it("ages waiting work ahead of newly ready higher-priority chain nodes", async () => {
    const plan = await compile([
      draft("waiting"),
      ...Array.from({ length: 5 }, (_, i) => draft(`urgent-${i}`, i === 0 ? [] : [`urgent-${i - 1}`], { priority: 2 }))
    ])
    const observed = await compare({ plan, concurrency: { steps: 1 } })
    expect(observed.executed.map((node) => node.nodeId)).toEqual([
      "urgent-0",
      "urgent-1",
      "waiting",
      "urgent-2",
      "urgent-3",
      "urgent-4"
    ])
    const scheduled = observed.records.filter((entry) => entry.type === "flows.engine.node-scheduled")
    expect(scheduled.map((entry) => {
      const payload = entry.payload as { nodeId: string; waited: number }
      return [payload.nodeId, payload.waited]
    })).toEqual([["urgent-0", 0], ["urgent-1", 0], ["waiting", 2], ["urgent-2", 1], ["urgent-3", 0], ["urgent-4", 0]])
  })
})
