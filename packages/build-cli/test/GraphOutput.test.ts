/**
 * The `graph` renderers over a hand-built plan: text trees mark external,
 * repeated, and last-child nodes; Mermaid ids are hex-stable and labels are
 * quote-escaped.
 */
import { describe, expect, it } from "vitest"
import * as Ansi from "../src/Ansi.ts"
import * as GraphOutput from "../src/GraphOutput.ts"
import type * as Planner from "../src/Planner.ts"

/** The slice of a planned target the renderers read. */
const planned = (
  label: string,
  target: string,
  dependencies: ReadonlyArray<string> = []
): Planner.PlannedTarget => ({ label, target, dependencies }) as unknown as Planner.PlannedTarget

const plan = (
  roots: ReadonlyArray<string>,
  targets: ReadonlyArray<Planner.PlannedTarget>,
  edges: ReadonlyArray<Planner.Edge> = []
): Planner.Plan => ({ verb: "graph", pattern: "//...", roots, targets, edges, warnings: [] })

const mermaidId = (label: string): string => `n_${Buffer.from(label).toString("hex")}`

describe("GraphOutput.text", () => {
  it("renders one tree per root with external, repeated, and last nodes marked", () => {
    const rendered = GraphOutput.text(plan(
      ["//:app", "//:docs"],
      [
        planned("//:app", "ToolBuild", ["//:lib", "//:assets"]),
        planned("//:lib", "TsBuild", ["//:shared", "@external"]),
        planned("//:assets", "Filegroup", ["//:shared"]),
        planned("//:shared", "Filegroup"),
        planned("//:docs", "TypedocDocs", ["//:lib"])
      ]
    ))
    expect(rendered).toBe([
      "//:app (ToolBuild)",
      "├─ //:lib (TsBuild)",
      "│  ├─ //:shared (Filegroup)",
      "│  └─ @external [external]",
      "└─ //:assets (Filegroup)",
      "   └─ //:shared (Filegroup) [seen]",
      "",
      "//:docs (TypedocDocs)",
      "└─ //:lib (TsBuild)",
      "   ├─ //:shared (Filegroup)",
      "   └─ @external [external]"
    ].join("\n"))
  })

  it("renders a root that is not in the plan as external", () => {
    expect(GraphOutput.text(plan(["//:missing"], []))).toBe("//:missing [external]")
  })

  it("renders an empty plan as an empty string", () => {
    expect(GraphOutput.text(plan([], []))).toBe("")
  })
})

describe("GraphOutput.mermaid", () => {
  it("renders hex-stable node ids and one arrow per edge", () => {
    const rendered = GraphOutput.mermaid(plan(
      ["//:app"],
      [planned("//:app", "ToolBuild", ["//:lib"]), planned("//:lib", "TsBuild")],
      [{ from: "//:lib", to: "//:app" }]
    ))
    expect(rendered).toBe([
      "flowchart LR",
      `  ${mermaidId("//:app")}["//:app\\nToolBuild"]`,
      `  ${mermaidId("//:lib")}["//:lib\\nTsBuild"]`,
      `  ${mermaidId("//:lib")} --> ${mermaidId("//:app")}`
    ].join("\n"))
  })

  it("escapes double quotes inside labels", () => {
    const rendered = GraphOutput.mermaid(plan(["//:say"], [planned("//:say\"hi\"", "Shell.Run")]))
    expect(rendered).toContain("[\"//:say&quot;hi&quot;\\nShell.Run\"]")
    expect(rendered).not.toContain("say\"hi\"")
  })

  it("renders an empty plan as the bare flowchart header", () => {
    expect(GraphOutput.mermaid(plan([], []))).toBe("flowchart LR")
  })
})

describe("GraphOutput styled", () => {
  const styledPlan = plan(
    ["//:app"],
    [
      planned("//:app", "ToolBuild", ["//:lib", "//:assets", "@external"]),
      planned("//:lib", "TsBuild", ["//:assets"]),
      planned("//:assets", "Filegroup")
    ]
  )

  it("adds colour without changing the tree text", () => {
    const styled = GraphOutput.text(styledPlan, Ansi.colors)
    expect(Ansi.strip(styled)).toBe(GraphOutput.text(styledPlan))
    expect(styled).toContain(Ansi.colors.bold("//:app"))
    expect(styled).toContain(Ansi.colors.cyan("(TsBuild)"))
    expect(styled).toContain(Ansi.colors.dim("//:assets"))
    expect(styled).toContain(Ansi.colors.dim("(Filegroup)"))
    expect(styled).toContain(Ansi.colors.dim("@external [external]"))
  })
})

describe("GraphOutput.packageText", () => {
  const rows = [
    { label: "//src:build", target: "Rspack.Build" },
    { label: "//src:srcs", target: "Filegroup" }
  ]
  const edges = [
    { from: "//src:build", to: "//src:srcs", kind: "data" },
    { from: "//src:build", to: "//src:lint", kind: "gates" }
  ]

  it("lists each label over its outgoing edges", () => {
    expect(GraphOutput.packageText(rows, edges)).toBe(
      "//src:build\n  -data-> //src:srcs\n  -gates-> //src:lint\n//src:srcs"
    )
  })

  it("styles labels and edge kinds without changing the text", () => {
    const styled = GraphOutput.packageText(rows, edges, Ansi.colors)
    expect(Ansi.strip(styled)).toBe(GraphOutput.packageText(rows, edges))
    expect(styled).toContain(Ansi.colors.bold("//src:build"))
    expect(styled).toContain(Ansi.colors.dim("//src:srcs"))
    expect(styled).toContain(Ansi.colors.dim("-data->"))
  })
})
