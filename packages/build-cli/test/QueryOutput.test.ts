/**
 * The person-facing `query` rendering: a listing as aligned columns, a
 * `deps()` answer as a root and its closure, and no escape sequences with
 * the default palette.
 */
import { describe, expect, it } from "vitest"
import * as Ansi from "../src/Ansi.ts"
import * as Query from "../src/Query.ts"

const listing: Query.Listing = {
  query: "//...",
  targets: [
    { label: "//src:build", target: "Rspack.Build", kinds: ["build"] },
    { label: "//src:lint", target: "Biome.Lint", kinds: ["lint"] },
    { label: "//src/Server:test", target: "Jest.Test", kinds: ["test"] }
  ]
}

describe("Query.text", () => {
  it("aligns a listing into LABEL, TARGET, and KINDS columns", () => {
    expect(Query.text(listing)).toBe([
      "LABEL              TARGET        KINDS",
      "//src:build        Rspack.Build  build",
      "//src:lint         Biome.Lint    lint",
      "//src/Server:test  Jest.Test     test"
    ].join("\n"))
  })

  it("colours kinds and dims the rule without changing the text", () => {
    const styled = Query.text(listing, Ansi.colors)
    expect(Ansi.strip(styled)).toBe(Query.text(listing))
    expect(styled).toContain("\u001b[34mbuild\u001b[39m")
    expect(styled).toContain("\u001b[33mlint\u001b[39m")
    expect(styled).toContain("\u001b[32mtest\u001b[39m")
  })

  it("names an empty listing", () => {
    expect(Query.text({ query: "//nope", targets: [] })).toBe("no targets match //nope")
  })

  it("renders deps() as the root over its closure", () => {
    const rendered = Query.text({
      query: "deps(//src:build)",
      root: "//src:build",
      dependencies: ["//src:assets", "//src:lib"],
      edges: [{ from: "//src:lib", to: "//src:build" }]
    })
    expect(rendered).toBe("//src:build depends on 2 targets\n  //src:assets\n  //src:lib")
    expect(Query.text({ query: "deps(//:x)", root: "//:x", dependencies: ["//:y"], edges: [] }))
      .toBe("//:x depends on 1 target\n  //:y")
  })
})

describe("Query.text with an unknown kind", () => {
  it("prints a kind it has no colour for as plain text", () => {
    const styled = Query.text({
      query: "//:x",
      targets: [{ label: "//:x", target: "Custom", kinds: ["custom" as never] }]
    }, Ansi.colors)
    expect(Ansi.strip(styled)).toContain("//:x   Custom  custom")
    expect(styled.endsWith("  custom")).toBe(true)
  })
})
