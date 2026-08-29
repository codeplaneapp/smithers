import { describe, expect, test } from "bun:test"
import graphFixture from "../fixtures/force/graph.json"
import planFixture from "../fixtures/force/plan-typeCheck.json"
import { criticalPath, reachable } from "./TargetGraph"
import {
  CliGraphEnvelopeSchema,
  CliPlanEnvelopeSchema,
  isPrivateLabel,
  mergePlanFacts,
  targetGraphFromCli
} from "./TargetGraphFixture"

/*
 * The captured force workspace (apps/shared/fixtures/force/): 82 targets,
 * 94 edges. The parse is the dev fixture stream's and the backend's shared
 * read of the CLI envelope, so the counts pin it end to end.
 */

const graph = targetGraphFromCli(CliGraphEnvelopeSchema.parse(graphFixture), { repoId: "force" })

describe("the force CLI graph envelope as a TargetGraphResponse", () => {
  test("parses 82 nodes and 94 edges", () => {
    expect(graph.nodes.length).toBe(82)
    expect(graph.edges.length).toBe(94)
  })

  test("every node splits into package and name, rule from the loader row", () => {
    const typeCheck = graph.nodes.find((node) => node.label === "//src:typeCheck")
    expect(typeCheck?.package).toBe("//src")
    expect(typeCheck?.name).toBe("typeCheck")
    expect(typeCheck?.rule).toBe("Shell.Test")
    const ci = graph.nodes.find((node) => node.label === "//.github:ci")
    expect(ci?.rule).toBe("Github.Workflow")
  })

  test("edge kinds are the classified set (data, gates, services)", () => {
    const kinds = new Set(graph.edges.map((edge) => edge.kind))
    expect([...kinds].sort()).toEqual(["data", "gates", "services"])
  })

  test("reachable answers deps and rdeps for focus", () => {
    const deps = reachable(graph.edges, "//:prePush", "deps")
    expect(deps.has("//src:lint")).toBe(true)
    expect(deps.has("//src:typeCheck")).toBe(true)
    expect(deps.has("//src:test")).toBe(true)
    expect(deps.has("//src:agentLints")).toBe(true)
    const rdeps = reachable(graph.edges, "//src:typeCheck", "rdeps")
    expect(rdeps.has("//:prePush")).toBe(true)
    expect(rdeps.has("//:preCommit")).toBe(true)
    expect(rdeps.has("//src:typeCheck")).toBe(false)
  })

  test("the plan envelope merges rule, key, argv, and cacheability onto its nodes", () => {
    const merged = mergePlanFacts(graph, CliPlanEnvelopeSchema.parse(planFixture))
    const typeCheck = merged.nodes.find((node) => node.label === "//src:typeCheck")
    expect(typeCheck?.plan?.mode).toBe("execute")
    expect(typeCheck?.plan?.cacheable).toBe(true)
    expect(typeCheck?.plan?.key).toMatch(/^83972035/)
    expect(typeCheck?.plan?.argv?.[0]).toContain("tsc")
    const relay = merged.nodes.find((node) => node.label === "//src:relayArtifacts")
    expect(relay?.rule).toBe("Shell.Build")
    // Nodes the plan never names keep the loader row untouched.
    const ci = merged.nodes.find((node) => node.label === "//.github:ci")
    expect(ci?.plan).toBeUndefined()
  })

  test("private helper labels read their __ name prefix", () => {
    expect(isPrivateLabel("//src:__private_Overlay_4")).toBe(true)
    expect(isPrivateLabel("//src:typeCheck")).toBe(false)
  })

  test("criticalPath is pure over the same edges the UI renders", () => {
    const path = criticalPath(
      [
        { label: "//:prePush", status: "ran", durationMs: 10 },
        { label: "//src:lint", status: "ran", durationMs: 30 },
        { label: "//src:test", status: "ran", durationMs: 5 }
      ],
      graph.edges
    )
    expect(path).toEqual(["//src:lint", "//:prePush"])
  })
})
