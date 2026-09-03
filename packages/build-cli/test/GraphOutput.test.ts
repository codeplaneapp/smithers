/**
 * The `graph` renderers over a hand-built plan: text trees mark external,
 * repeated, and last-child nodes; Mermaid ids are hex-stable and labels are
 * quote-escaped.
 */
import { describe, expect, it } from "vitest"
import * as Ansi from "../src/Ansi.ts"
import * as GraphOutput from "../src/GraphOutput.ts"

const mermaidId = (label: string): string => `n_${Buffer.from(label).toString("hex")}`
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

describe("GraphOutput build-system rendering", () => {
  const rows = [
    { label: "//app:build", target: "Shell.Build" },
    { label: "//app:vendored", target: "Repo.Target", refusal: "the child workspace has no //:lint" }
  ]
  const edges = [
    { from: "//app:build", to: "//lib:lib", kind: "deps" },
    { from: "//app:vendored", to: "@vendor//:lint", kind: "repo" }
  ]

  /**
   * `--mermaid` used to be accepted in the build system and dropped: the text tree
   * was rendered and the envelope still said `format: "text"`.
   */
  it("renders a flowchart with hex-stable ids and kind-labelled edges", () => {
    const rendered = GraphOutput.packageMermaid(rows, edges)
    expect(rendered.split("\n")[0]).toBe("flowchart LR")
    expect(rendered).toContain(`${mermaidId("//app:build")}["//app:build\\nShell.Build"]`)
    expect(rendered).toContain(`${mermaidId("//app:build")} -->|deps| ${mermaidId("//lib:lib")}`)
    expect(rendered).toContain(`${mermaidId("//app:vendored")} -->|repo| ${mermaidId("@vendor//:lint")}`)
  })

  it("carries a refusal into the flowchart node and escapes label quotes", () => {
    const rendered = GraphOutput.packageMermaid(
      [{ label: "//app:x", target: "Repo.Target", refusal: "no \"//:lint\" there\nsecond line" }],
      []
    )
    expect(rendered).toContain("refused: no &quot;//:lint&quot; there second line")
    expect(rendered).not.toContain("\"//:lint\" there")
  })

  it("renders an empty graph as the flowchart header alone", () => {
    expect(GraphOutput.packageMermaid([], [])).toBe("flowchart LR")
  })

  /**
   * A refused repository row used to survive only in the JSON envelope, so a
   * person reading the terminal saw it as an ordinary row.
   */
  it("shows a refusal in the text rendering", () => {
    const rendered = GraphOutput.packageText(rows, edges)
    expect(rendered).toContain("//app:vendored (refused: the child workspace has no //:lint)")
    expect(rendered).toContain("  -repo-> @vendor//:lint")
  })
})
