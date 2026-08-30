/**
 * The README's public-export table, checked against the barrel.
 *
 * `src/index.ts` claimed the table was generated from its list. Nothing
 * generated it, and nothing compared it either, so three exports added by the
 * commit that made the claim never reached the table. This is the comparison:
 * every module the barrel exports has a row, and every runtime export it
 * carries is named in that row. Types are not checked — they are erased before
 * a namespace object exists — so a row may name more than this file can see,
 * never less.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/index.ts"

const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8")

/** The table's `| \`Module\` | \`a\`, \`b\` | description |` rows, by module. */
const rows = new Map(
  readme.split("\n")
    .filter((line) => /^\|\s*`/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .map(([module, exported]) =>
      [
        (module ?? "").replaceAll("`", ""),
        (exported ?? "").split(",").map((name) => name.trim().replaceAll("`", "")).filter((name) => name !== "")
      ] as const
    )
)

describe("the README public-export table", () => {
  it("has a row for every module the barrel exports", () => {
    const missing = Object.keys(Cli).filter((module) => !rows.has(module))

    expect(missing).toEqual([])
  })

  for (const [module, namespace] of Object.entries(Cli)) {
    it(`names every runtime export of ${module}`, () => {
      const listed = rows.get(module) ?? []
      const missing = Object.keys(namespace as Record<string, unknown>).filter((name) => !listed.includes(name))

      expect(missing).toEqual([])
    })
  }
})
