import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readDoc = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

describe("public surface documentation", () => {
  it("uses configurable LlmLint instead of removed repository review macros", () => {
    const api = readDoc("docs/api.md")
    expect(api).toContain("`LlmLint` with explicit instructions")
    expect(api).not.toMatch(/DurableIdentityGuard|DocsReferenceSync|JsdocTruthfulness/)
  })

  it.each(["README.md", "docs/reference/targets.md"])(
    "%s documents Cargo target selectors without legacy check overloads",
    (path) => {
      const doc = readDoc(path)
      expect(doc).toMatch(/workspace: true/)
      expect(doc).toMatch(/package: /)
      expect(doc).toMatch(/crates: /)
      expect(doc).not.toMatch(/CargoLint|CargoTest|Cargo\.Clippy\(\)|check values?/)
    }
  )

  it.each(["README.md", "docs/api.md", "docs/reference/targets.md"])(
    "%s describes opaque Target declarations and explicit execution",
    (path) => {
      const doc = readDoc(path)
      expect(doc).not.toMatch(
        /returns a Flow|Flow declarations with planner metadata|whose declarations every rule returns/
      )
      expect(doc).toMatch(/opaque `Target` declaration/)
      expect(doc).toContain("package executor")
      expect(doc).toContain("Target.plan(target)")
    }
  )
})
