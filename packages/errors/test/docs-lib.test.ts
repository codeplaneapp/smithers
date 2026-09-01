import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  barrelExports,
  exportedDocs,
  exportNames,
  firstSentence,
  markdownTable,
  moduleDoc,
  regionEnd,
  regionStart,
  replaceRegion
} from "../scripts/docs-lib.ts"

// The docsPages target drift-checks docs/pages; these tests cover generator logic without opening that output.
describe("documented exports", () => {
  it("parses every supported declaration form with a category", () => {
    const source = `
/**
 * Runs work. Additional details follow.
 * @category functions
 */
export function run() {}

/**
 * Defines a base. Additional details follow.
 * @category classes
 */
export abstract class Base {}

/**
 * Names modes. Additional details follow.
 * @category enums
 */
export enum Mode { One }

/**
 * Runs later. Additional details follow.
 * @category functions
 */
export async function runLater() {}

/** This export has no category. */
export const skipped = true
`

    expect(exportedDocs(source)).toEqual([
      { name: "run", declaration: "function", category: "functions", summary: "Runs work." },
      { name: "Base", declaration: "class", category: "classes", summary: "Defines a base." },
      { name: "Mode", declaration: "enum", category: "enums", summary: "Names modes." },
      { name: "runLater", declaration: "function", category: "functions", summary: "Runs later." }
    ])
  })

  it("does not span separate JSDoc blocks", () => {
    const source = `/** first
 * @category a
 */
const x = 1
/** second */
export const y = 2`

    expect(exportedDocs(source)).toEqual([])
  })

  it("lists declarations whether or not they have JSDoc", () => {
    const source = `
export type A = string
export const b = 1
export let c = 2
export class D {}
export interface E {}
export function f() {}
export enum G { One }
export abstract class H {}
export async function i() {}
`

    expect(exportNames(source)).toEqual(["A", "b", "c", "D", "E", "f", "G", "H", "i"])
  })

  it("parses typed and renamed names from multiple barrel blocks", () => {
    const source = `
export {
  type Alpha,
  beta as renamed,
  gamma
} from "./First.ts"
export { delta, type Epsilon } from "./Second.ts"
`

    expect(barrelExports(source)).toEqual([
      { name: "Alpha", module: "First" },
      { name: "beta", module: "First" },
      { name: "gamma", module: "First" },
      { name: "delta", module: "Second" },
      { name: "Epsilon", module: "Second" }
    ])
  })
})

describe("documentation text helpers", () => {
  it("extracts the first linked sentence", () => {
    expect(firstSentence("Use {@link Foo}. Read the next sentence.")).toBe("Use `Foo`.")
    expect(firstSentence("Version 1.2 works. Read the next sentence.")).toBe("Version 1.2 works.")
    expect(firstSentence("No final period")).toBe("No final period")
  })

  it("renders escaped and padded Markdown tables", () => {
    expect(markdownTable(["A", "Long"], [["x|y", "z"], ["q", "wide"]])).toBe(
      `| A   | Long |
| --- | ---- |
| x\\|y | z    |
| q   | wide |`
    )
  })

  it("requires a module JSDoc block", () => {
    expect(() => moduleDoc("export const x = 1")).toThrowError("errors docs: no module JSDoc block")
  })
})

describe("generated regions", () => {
  it("rejects every missing or misordered marker form", () => {
    const start = "<!-- generated:X start -->"
    const end = "<!-- generated:X end -->"
    for (const source of ["none", start, `${end}\n${start}`]) {
      expect(() => replaceRegion(source, "X", "body", "P")).toThrowError(
        "errors docs: region X is missing from P"
      )
    }
  })

  it("uses MDX markers under docs/pages and HTML markers elsewhere", () => {
    expect(regionStart("docs/pages/P.md", "X")).toBe("{/* generated:X start */}")
    expect(regionEnd("docs/pages/P.md", "X")).toBe("{/* generated:X end */}")
    expect(replaceRegion(
      "{/* generated:X start */}\nold\n{/* generated:X end */}",
      "X",
      "new",
      "docs/pages/P.md"
    )).toBe("{/* generated:X start */}\n\nnew\n\n{/* generated:X end */}")
    expect(replaceRegion(
      "<!-- generated:X start -->\nold\n<!-- generated:X end -->",
      "X",
      "new",
      "README.md"
    )).toBe("<!-- generated:X start -->\n\nnew\n\n<!-- generated:X end -->")
  })
})

describe("real source completeness", () => {
  it("documents every source and barrel export", () => {
    const sourceRoot = join(import.meta.dirname, "..", "src")
    const barrel = readFileSync(join(sourceRoot, "index.ts"), "utf8")
    const entries = barrelExports(barrel)
    const documentedNames = new Set<string>()

    for (const module of new Set(entries.map((entry) => entry.module))) {
      const source = readFileSync(join(sourceRoot, `${module}.ts`), "utf8")
      const exported = new Set(exportNames(source))
      const documented = new Set(exportedDocs(source).map((entry) => entry.name))
      expect(documented).toEqual(exported)
      for (const name of documented) documentedNames.add(name)
    }

    for (const entry of entries) expect(documentedNames.has(entry.name)).toBe(true)
  })
})
