import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ")

describe("documentation contracts", () => {
  it("requires durable runner deduplication for at-least-once launch attempts (documentation/1)", () => {
    for (
      const path of [
        "README.md",
        "docs/README.md",
        "docs/concepts/claim-protocol.md",
        "docs/troubleshooting.md",
        "docs/api.md"
      ]
    ) {
      const doc = read(path)
      expect(doc, path).toContain("at-least-once launch attempts")
      expect(doc, path).toContain("durably deduplicate by `idempotencyKey`")
      expect(doc, path).toContain("same run identity on replay")
    }
    expect(read("docs/concepts/claim-protocol.md")).toMatch(/accepted.*before.*`launched` result/)
    expect(read("docs/troubleshooting.md")).not.toContain("which the store's transaction forbids")
    expect(read("docs/quickstart.md")).not.toContain("fire the occurrence once")
    const roster = read("../../../../apps/site/src/content/docs/docs/reference/subpackages.mdx")
    expect(roster).not.toContain("two hosts never fire the same scheduled run twice")
  })

  it("describes catch-up enumeration subject to overlap, not lossless billing (documentation/2, api-design/2)", () => {
    const guide = read("docs/guides/choose-a-policy.md")
    expect(guide).toContain("subject to overlap")
    expect(guide).toContain("launch acknowledgement, not completion")
    expect(guide).toContain("durable queue")
    expect(guide).toContain("interval backlog")
    expect(guide).not.toContain("const hourlyRollup")
    expect(guide).not.toContain("pair `all` with `skip` or `buffer-one`")
  })

  it("distinguishes a first-poll bound breach from subsequent polls (documentation/3)", () => {
    for (
      const path of [
        "docs/concepts/policies.md",
        "docs/api.md",
        "docs/guides/choose-a-policy.md",
        "docs/troubleshooting.md"
      ]
    ) {
      const doc = read(path)
      expect(doc, path).toContain("first poll")
      expect(doc, path).toContain("including the current occurrence")
      expect(doc, path).toContain("subsequent polls")
      expect(doc, path).toContain("subject to overlap")
      expect(doc, path).not.toContain("and still fires the current occurrence")
    }
  })

  it("documents accepted getters and their two evaluations (documentation/5)", () => {
    for (const path of ["docs/troubleshooting.md", "docs/api.md", "src/Trigger.ts"]) {
      const doc = read(path).replace(/ \* /g, " ")
      expect(doc, path).toContain("Enumerable getters are accepted")
      expect(doc, path).toContain("evaluated during decoding and again during SQL serialization")
    }
  })
})
