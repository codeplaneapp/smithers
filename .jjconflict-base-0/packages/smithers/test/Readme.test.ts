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
 *
 * The README's TypeScript example is checked the same way, against
 * `fixtures/readme-example.ts`. The fixture is inside `tsconfig.test.json`, so
 * the package typecheck compiles the published example and this file proves the
 * two have not drifted apart.
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

/** The `ts` fenced blocks in the README, in order. */
const snippets = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? "")

/**
 * The compiled fixture, with its explanatory header and the export that keeps
 * `main` from being an unused local removed, so what remains is the example.
 */
const compiled = readFileSync(fileURLToPath(new URL("./fixtures/readme-example.ts", import.meta.url)), "utf8")
  .replace(/^\/\*\*[\s\S]*?\*\/\n/, "")
  .replace(/\n\nexport \{ main \}\n$/, "\n")

describe("the README example", () => {
  it("is the one the package typecheck compiles", () => {
    // A README example nothing compiles rots silently: this one called
    // `makeConfig` with one argument for as long as it took the signature to
    // grow two more parameters.
    expect(snippets).toHaveLength(1)
    expect(snippets[0]).toBe(compiled)
  })
})
