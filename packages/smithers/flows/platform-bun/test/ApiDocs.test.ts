import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

describe("BunHost API reference", () => {
  it("lists every namespace re-export", () => {
    const source = read("../src/BunHost.ts")
    const docs = read("../docs/api.md")
    const exported = [...source.matchAll(/^export \{([^}]+)\}/gm)]
      .flatMap(([, names]) => names!.split(",").map((name) => name.trim()).filter(Boolean))
      .sort()
    const section = docs.split("### Re-exports")[1]!.split("\n## ")[0]!
    const documented = [...section.matchAll(/^\| `([^`]+)`\s*\|/gm)].map(([, name]) => name).sort()

    expect(exported.length).toBeGreaterThan(0)
    expect(documented).toEqual(exported)
  })
})
