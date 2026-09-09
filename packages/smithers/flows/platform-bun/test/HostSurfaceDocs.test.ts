import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

/** Collapse JSDoc gutters and wrapping so a claim reads as one line. */
const flatten = (text: string) => text.replace(/^\s*\*/gm, " ").replace(/\s+/g, " ")

describe("Host surface guide", () => {
  it("qualifies every step-key claim as a caller-supplied input", () => {
    const claims = flatten(read("../docs/concepts/host-surface.md"))
      .split(/(?<=\.)\s+/)
      .filter((sentence) => /step key/i.test(sentence))

    expect(claims.length).toBeGreaterThan(0)
    // No planner derives `layers` from a host bundle, so the guide may never
    // describe the closed list as digested into step identity on its own.
    for (const claim of claims) expect(claim).toMatch(/caller|no planner|only/i)
  })

  it("keeps the limitation the implementation identities document", () => {
    const limitation = /no planner derives it from a host bundle/

    expect(flatten(read("../src/BunHost.ts"))).toMatch(limitation)
    expect(flatten(read("../docs/concepts/host-surface.md"))).toMatch(limitation)
  })
})
