/**
 * `Smithers.Flow` and the catalog it feeds.
 *
 * The declaration is validated where it is written; the catalog is the join
 * of discovery and declarations, and the two properties that matter most are
 * that a declaration naming no discovered flow fails by id and that the row
 * order is featured first, in declaration order.
 */
import { describe, expect, it } from "vitest"
import * as Flow from "../src/Flow.ts"
import * as FlowCatalog from "../src/FlowCatalog.ts"
import type * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

const describeInput = (input: Input.Declared): string =>
  input._tag === "Glob" ? input.pattern : input._tag === "File" ? input.path : input._tag

const discovered = (
  id: string,
  overrides: Partial<FlowCatalog.DiscoveredFlow> = {}
): FlowCatalog.DiscoveredFlow => ({
  id,
  description: `Describes ${id}.`,
  kind: "mdx",
  path: `flows/${id}/flow.mdx`,
  capabilities: ["fs:read:**"],
  model: null,
  modelInvocable: true,
  ...overrides
})

describe("Smithers.Flow", () => {
  it("declares a frozen, tagged, plain declaration with the presentation applied", () => {
    const review = Flow.Flow({ flow: "review", summary: "  Review the change.  ", featured: true })
    expect(review).toEqual({ _tag: "FlowDeclaration", flow: "review", summary: "Review the change.", featured: true })
    expect(Object.isFrozen(review)).toBe(true)
    expect(Flow.isFlowDeclaration(review)).toBe(true)
    expect(Flow.isFlowDeclaration({ flow: "review" })).toBe(false)
  })

  it("defaults featured to false and leaves an absent summary absent", () => {
    const lint = Flow.Flow({ flow: "create-flow/scaffold" })
    expect(lint).toEqual({ _tag: "FlowDeclaration", flow: "create-flow/scaffold", featured: false })
    expect("summary" in lint).toBe(false)
    expect(Flow.Flow({ flow: "lint", summary: undefined, featured: undefined }).featured).toBe(false)
  })

  it("validates the summary and featured through the shared presentation rule", () => {
    expect(() => Flow.Flow({ flow: "review", summary: "" })).toThrow(/summary must not be empty/)
    expect(() => Flow.Flow({ flow: "review", summary: "two\nlines" })).toThrow(/summary must be one line/)
    expect(() => Flow.Flow({ flow: "review", summary: 3 as never })).toThrow(/summary must be a string/)
    expect(() => Flow.Flow({ flow: "review", featured: "yes" as never })).toThrow(/featured must be a boolean/)
  })

  it("refuses an id that is not a directory path below flows/", () => {
    expect(() => Flow.Flow({ flow: "" })).toThrow(/directory path below flows/)
    expect(() => Flow.Flow({ flow: "/review" })).toThrow(/directory path below flows/)
    expect(() => Flow.Flow({ flow: "review/" })).toThrow(/directory path below flows/)
    expect(() => Flow.Flow({ flow: "re view" })).toThrow(/directory path below flows/)
    expect(() => Flow.Flow({ flow: "a".repeat(Flow.maximumIdLength + 1) })).toThrow(/directory path below flows/)
    expect(() => Flow.Flow({ flow: 7 as never })).toThrow(/well-formed string/)
    expect(() => Flow.Flow({ flow: "\uD800" })).toThrow(/well-formed string/)
  })

  it("refuses options that are not a plain object of enumerable data properties", () => {
    expect(() => Flow.Flow(null as never)).toThrow(/plain object/)
    expect(() => Flow.Flow(["review"] as never)).toThrow(/plain object/)
    expect(() => Flow.Flow(new Proxy({ flow: "review" }, {}))).toThrow(/plain object/)
    class Options {
      flow = "review"
    }
    expect(() => Flow.Flow(new Options())).toThrow(/plain object/)
    expect(() => Flow.Flow({ flow: "review", [Symbol("x")]: 1 } as never)).toThrow(/symbol properties/)
    expect(() => Flow.Flow({ flow: "review", model: "gpt" } as never)).toThrow(/unknown option "model"/)
    expect(() =>
      Flow.Flow(Object.defineProperty({ flow: "review" }, "featured", { get: () => true, enumerable: true }))
    ).toThrow(/enumerable data property/)
    expect(() => Flow.Flow(Object.defineProperty({ flow: "review" }, "featured", { value: true, enumerable: false })))
      .toThrow(/enumerable data property/)
  })
})

describe("FlowCatalog.rows", () => {
  const review = Flow.Flow({ flow: "review", summary: "Review the change.", featured: true })
  const lint = Flow.Flow({ flow: "lint", summary: "Lint the named files.", featured: true })
  const notes = Flow.Flow({ flow: "release-notes", summary: "Draft the notes." })
  const found = [
    discovered("release-notes", { kind: "ts", path: "flows/release-notes/flow.ts", model: "openai:gpt-5.6-sol" }),
    discovered("create-flow/scaffold"),
    discovered("lint", { modelInvocable: false }),
    discovered("review", { kind: "skill", path: "flows/review/SKILL.md", capabilities: [] }),
    discovered("alpha")
  ]

  it("orders featured rows first in declaration order, then declared rows, then the rest by id", () => {
    const rows = FlowCatalog.rows(found, [lint, notes, review])
    expect(rows.map((row) => row.id)).toEqual(["lint", "review", "release-notes", "alpha", "create-flow/scaffold"])
    expect(rows.map((row) => row.featured)).toEqual([true, true, false, false, false])
    expect(rows.map((row) => row.summary)).toEqual([
      "Lint the named files.",
      "Review the change.",
      "Draft the notes.",
      null,
      null
    ])
  })

  it("carries every discovered field onto the row", () => {
    const [row] = FlowCatalog.rows([found[0]!], [notes])
    expect(row).toEqual({
      id: "release-notes",
      description: "Describes release-notes.",
      summary: "Draft the notes.",
      featured: false,
      kind: "ts",
      path: "flows/release-notes/flow.ts",
      capabilities: ["fs:read:**"],
      model: "openai:gpt-5.6-sol",
      modelInvocable: true
    })
  })

  it("fails by id when a declaration names no discovered flow", () => {
    const missing = Flow.Flow({ flow: "reveiw", featured: true })
    expect(() => FlowCatalog.rows(found, [review, missing])).toThrow(FlowCatalog.FlowCatalogError)
    expect(() => FlowCatalog.rows(found, [review, missing])).toThrow(/discovery did not find: "reveiw"/)
    expect(() => FlowCatalog.rows(found, [missing, Flow.Flow({ flow: "nope" })]))
      .toThrow(/flows discovery did not find: "reveiw", "nope"/)
  })

  it("fails when a flow is declared twice or discovered twice", () => {
    expect(() => FlowCatalog.rows(found, [review, Flow.Flow({ flow: "review" })]))
      .toThrow(/declares the flow "review" twice/)
    expect(() => FlowCatalog.rows([...found, discovered("alpha")], []))
      .toThrow(/reported the flow "alpha" twice/)
  })

  it("renders a stable two-space document with a trailing newline that parses back", () => {
    const rows = FlowCatalog.rows(found.slice(0, 1), [notes])
    const text = FlowCatalog.render(rows)
    expect(text.endsWith("\n")).toBe(true)
    expect(text).toBe(`${JSON.stringify({ flows: rows }, null, 2)}\n`)
    expect(FlowCatalog.parse(text)).toEqual({ flows: rows })
    expect(FlowCatalog.parse("{")).toMatch(/not JSON/)
    expect(FlowCatalog.parse(JSON.stringify({ flows: [{ id: "x" }] }))).toMatch(/shape/)
  })
})

describe("FlowCatalog target", () => {
  const review = Flow.Flow({ flow: "review", summary: "Review the change.", featured: true })

  it("checks by default, writes only when asked, and plans one catalog action", () => {
    const checking = FlowCatalog.FlowCatalog({ flows: [review] })
    const metadata = Target.metadata(checking)
    expect(metadata.attrs).toEqual({ root: "flows", output: "flows/catalog.json", flows: [review], mode: "check" })
    expect(metadata.cacheable).toBe(true)
    expect(metadata.outputs).toEqual({ cwd: ".", paths: [] })
    expect(metadata.inputs.map(describeInput)).toEqual([
      "//flows/**/flow.ts",
      "//flows/**/flow.mdx",
      "//flows/**/SKILL.md",
      "//flows/catalog.json"
    ])
    expect(plannedCalls(checking)).toEqual([{
      action: "smithers-build/flow-catalog",
      payload: { root: "flows", output: "flows/catalog.json", flows: [review], mode: "check" }
    }])

    const writing = FlowCatalog.FlowCatalog({ mode: "write", root: "//recipes", output: "//recipes/catalog.json" })
    const written = Target.metadata(writing)
    expect(written.cacheable).toBe(false)
    expect(written.outputs).toEqual({ cwd: ".", paths: ["recipes/catalog.json"] })
    expect(written.inputs.map(describeInput)).toEqual([
      "//recipes/**/flow.ts",
      "//recipes/**/flow.mdx",
      "//recipes/**/SKILL.md"
    ])
    expect(plannedCalls(writing)).toEqual([{
      action: "smithers-build/flow-catalog",
      payload: { root: "recipes", output: "recipes/catalog.json", flows: [], mode: "write" }
    }])
  })

  it("forces the non-writing view under the lint verb and keeps build as declared", () => {
    const metadata = Target.metadata(FlowCatalog.FlowCatalog({ mode: "write" }))
    expect((metadata.forKind("lint").attrs as FlowCatalog.Attrs).mode).toBe("check")
    expect((metadata.forKind("build").attrs as FlowCatalog.Attrs).mode).toBe("write")
    expect((Target.metadata(FlowCatalog.FlowCatalog({})).forKind("lint").attrs as FlowCatalog.Attrs).mode).toBe("check")
  })

  it("refuses declarations that are not Smithers.Flow values", () => {
    expect(() => FlowCatalog.FlowCatalog({ flows: [{ flow: "review" }] as never })).toThrow()
  })
})
