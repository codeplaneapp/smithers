import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Core from "../src/index.ts"

const publicApiRows = (): ReadonlyMap<string, ReadonlySet<string>> => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  const afterHeading = readme.slice(readme.indexOf("## Public API") + "## Public API".length)
  const nextHeading = afterHeading.search(/^## /m)
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)
  const rows = new Map<string, ReadonlySet<string>>()

  for (const line of section.split(/\r?\n/)) {
    const cells = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]*)\|/)
    if (cells === null) continue
    rows.set(cells[1]!, new Set([...cells[2]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)))
  }

  return rows
}

describe("README public API table", () => {
  it("has one row per namespace and lists every runtime export", () => {
    const rows = publicApiRows()

    expect(new Set(rows.keys())).toEqual(new Set(Object.keys(Core)))
    for (const [module, namespace] of Object.entries(Core)) {
      const documented = rows.get(module) ?? new Set<string>()
      expect(Object.keys(namespace).filter((name) => !documented.has(name)), module).toEqual([])
    }
  })
})
