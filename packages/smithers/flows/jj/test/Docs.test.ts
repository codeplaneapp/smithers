import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

describe("revert documentation", () => {
  it.each(["testing", "run-jj-in-a-browser"])("%s never probes support by reverting", (guide) => {
    const markdown = readFileSync(new URL(`../docs/guides/${guide}.md`, import.meta.url), "utf8")
    const sections = markdown.split(/(?=^#{1,6} )/m)

    for (const section of sections) {
      if (!/capability[- ](?:detect|check)|feature[- ]detect|canRevert/i.test(section)) continue
      expect(section).not.toMatch(/\.revert\s*[!?]?\s*\(/)
      expect(section).not.toMatch(/\bcall\s+`revert`/i)
      expect(section).not.toContain("canRevert")
    }
  })
})
