/**
 * The featured-flow presentation `ls` folds in from `flows/catalog.json`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as FeaturedFlows from "../src/internal/FeaturedFlows.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const project = (catalog?: string): string => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-featured-flows-"))
  roots.push(root)
  if (catalog !== undefined) {
    mkdirSync(join(root, "flows"), { recursive: true })
    writeFileSync(join(root, "flows", "catalog.json"), catalog)
  }
  return root
}

const row = (id: string, featured: boolean, summary: string | null) => ({
  id,
  description: `Describes ${id}.`,
  summary,
  featured,
  kind: "mdx" as const,
  path: `flows/${id}/flow.mdx`,
  capabilities: [],
  model: null,
  modelInvocable: true
})

const items = [
  { flowId: "alpha", description: "Describes alpha." },
  { flowId: "lint", description: "Describes lint." },
  { flowId: "review", description: "Describes review." }
]

describe("FeaturedFlows.read", () => {
  it("reads a checked-in catalog and treats an absent or malformed one as none", () => {
    const catalog = JSON.stringify({ flows: [row("review", true, "Review it.")] })
    expect(FeaturedFlows.read(project(catalog))?.flows.map((flow) => flow.id)).toEqual(["review"])
    expect(FeaturedFlows.read(project())).toBeUndefined()
    expect(FeaturedFlows.read(project("{"))).toBeUndefined()
    expect(FeaturedFlows.read(project(JSON.stringify({ flows: [{ id: "review" }] })))).toBeUndefined()
  })
})

describe("FeaturedFlows.present", () => {
  it("lists the page unchanged without a catalog", () => {
    expect(FeaturedFlows.present(items, undefined)).toBe(items)
  })

  it("leads with the featured flows in catalog order and decorates only what the catalog declares", () => {
    const catalog = {
      flows: [
        row("review", true, "Review it."),
        row("lint", true, null),
        row("alpha", false, "Alpha summary."),
        row("ghost", true, "Names no listed flow.")
      ]
    }
    expect(FeaturedFlows.present(items, catalog)).toEqual([
      { flowId: "review", description: "Describes review.", featured: true, summary: "Review it." },
      { flowId: "lint", description: "Describes lint.", featured: true },
      { flowId: "alpha", description: "Describes alpha.", summary: "Alpha summary." }
    ])
  })
})

describe("FeaturedFlows.human", () => {
  it("stars featured rows and prefers the summary over the description", () => {
    const listed = FeaturedFlows.present(items, {
      flows: [row("review", true, "Review it."), row("alpha", false, null)]
    })
    expect(FeaturedFlows.human(listed)).toBe(
      "* review  Review it.\n" +
        "  alpha   Describes alpha.\n" +
        "  lint    Describes lint.\n"
    )
    expect(FeaturedFlows.human([])).toBe("No flows discovered under flows/.\n")
  })

  it("recognizes only a flow page whose items carry an id and a description", () => {
    expect(FeaturedFlows.isFlowPage({ _tag: "flows", items })).toBe(true)
    expect(FeaturedFlows.isFlowPage({ _tag: "flows", items: [{ flowId: 1 }] })).toBe(false)
    expect(FeaturedFlows.isFlowPage({ _tag: "runs", items: [] })).toBe(false)
    expect(FeaturedFlows.isFlowPage(null)).toBe(false)
  })
})
