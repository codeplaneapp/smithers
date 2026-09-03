import { describe, expect, it } from "vitest"
import * as Executor from "../src/Executor.ts"
import type * as Planner from "../src/Planner.ts"

const target = (
  label: string,
  keyPreview: string,
  dependencies: ReadonlyArray<string> = []
): Planner.PlannedTarget => ({
  label,
  target: "MergeTest",
  kinds: ["build", "test", "lint"],
  attrs: { keyPreview },
  dependencies,
  declaredInputs: [],
  declaredOutputs: undefined,
  cacheable: false,
  cacheLookup: "not-wired",
  wouldRun: true,
  keyMaterial: { body: keyPreview, inputs: null, layers: [], capabilities: [] },
  keyPreview
})

const plan = (
  verb: Planner.Plan["verb"],
  roots: ReadonlyArray<string>,
  targets: ReadonlyArray<Planner.PlannedTarget>,
  warnings: ReadonlyArray<string> = []
): Planner.Plan => ({ verb, pattern: "//...", roots, targets, edges: [], warnings })

describe("mergePlans", () => {
  it.each([
    ["build first", ["build", "lint"] as const],
    ["lint first", ["lint", "build"] as const]
  ])("selects the lint view and prunes dependencies from its discarded build view (%s)", (_name, order) => {
    const buildDependency = target("//:build-only", "build-dependency")
    const lintDependency = target("//:lint-only", "lint-dependency")
    const plans = {
      build: plan("build", ["//:root"], [buildDependency, target("//:root", "build-root", [buildDependency.label])]),
      lint: plan("lint", ["//:root"], [lintDependency, target("//:root", "lint-root", [lintDependency.label])])
    }

    const merged = Executor.mergePlans(order.map((verb) => plans[verb]))
    expect(merged.targets.map((entry) => entry.label)).toEqual(["//:lint-only", "//:root"])
    expect(merged.targets.at(-1)?.keyPreview).toBe("lint-root")
    expect(merged.edges).toEqual([{ from: "//:lint-only", to: "//:root" }])
  })

  it("refuses incompatible non-lint views instead of dropping one", () => {
    expect(() =>
      Executor.mergePlans([
        plan("build", ["//:root"], [target("//:root", "build-root")]),
        plan("test", ["//:root"], [target("//:root", "test-root")])
      ])
    ).toThrow(/incompatible execution views/)
  })

  it("deduplicates warnings and equal-key views", () => {
    const shared = target("//:root", "same")
    const merged = Executor.mergePlans([
      plan("build", [shared.label], [shared], ["warning"]),
      plan("test", [shared.label], [{ ...shared }], ["warning"])
    ])
    expect(merged.targets).toEqual([shared])
    expect(merged.warnings).toEqual(["warning"])
  })

  it("refuses a cycle created by the selected views", () => {
    expect(() =>
      Executor.mergePlans([
        plan("lint", ["//:a"], [target("//:a", "a", ["//:b"])]),
        plan("build", ["//:b"], [target("//:b", "b", ["//:a"])])
      ])
    ).toThrow(/merged dependency cycle/)
  })
})
