/**
 * The person-facing `index` rendering: aligned LABEL, RULE, and KINDS
 * columns, the outputs a row owns after an arrow, a star on a featured row,
 * and no escape sequences with the default palette.
 */
import { describe, expect, it } from "vitest"
import * as Ansi from "../src/Ansi.ts"
import * as TargetIndex from "../src/TargetIndex.ts"

const row = (
  partial: Partial<TargetIndex.Row> & Pick<TargetIndex.Row, "label" | "rule" | "kinds">
): TargetIndex.Row => ({
  package: "",
  name: partial.label.slice(partial.label.lastIndexOf(":") + 1),
  cacheable: false,
  inputs: [],
  outputs: [],
  dependencies: [],
  ...partial
})

const listing: TargetIndex.Listing = {
  pattern: "//...",
  targets: [
    row({
      label: "//:ci",
      rule: "GithubCiGen",
      kinds: ["build", "lint"],
      featured: true,
      outputs: [".github/workflows/ci.yml"]
    }),
    row({ label: "//src:lint", rule: "Biome.Lint", kinds: ["lint"] }),
    row({ label: "//src/Server:test", rule: "Jest.Test", kinds: ["test"], refusal: "repository unavailable" })
  ]
}

describe("TargetIndex.text", () => {
  it("aligns the listing and marks outputs, featured rows, and refusals", () => {
    expect(TargetIndex.text(listing)).toBe([
      "LABEL              RULE         KINDS",
      "//:ci              GithubCiGen  build lint *  -> .github/workflows/ci.yml",
      "//src:lint         Biome.Lint   lint",
      "//src/Server:test  Jest.Test    test  (refused: repository unavailable)"
    ].join("\n"))
  })

  it("colours kinds and dims the rule without changing the text", () => {
    const styled = TargetIndex.text(listing, Ansi.colors)
    expect(Ansi.strip(styled)).toBe(TargetIndex.text(listing))
    expect(styled).toContain("[34mbuild[39m")
    expect(styled).toContain("[33mlint[39m")
    expect(styled).toContain("[32mtest[39m")
  })

  it("names an empty listing", () => {
    expect(TargetIndex.text({ pattern: "//nope", targets: [] })).toBe("no targets match //nope")
  })
})
