/**
 * The capability envelope parsed from a plan card's formatted strings.
 *
 * A live run in `AgentSession.test.ts` covers the ordinary
 * action-and-resource forms. The bare `*` is what a markdown-declared flow
 * carries when its frontmatter names no capabilities at all.
 */
import * as Capability from "@smthrs/capability/Capability"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"

describe("patterns", () => {
  it("reads the bare * as whole authority", () => {
    // `**` and not `*`: `Capability.subsumes` recognises only `**` as
    // recursive, so a grant written with `*` covers nothing.
    expect(AgentSession.patterns(["*"]).map((entry) => ({ action: entry.action, resource: entry.resource })))
      .toEqual([{ action: "*", resource: "**" }])
  })

  it("drops what it cannot name rather than widening it", () => {
    expect(
      AgentSession.patterns(["single", "zz:yy:**", "fs:read:**"]).map((entry) => entry.action)
    ).toEqual(["fs:read"])
  })

  it("delegates every non-bare pattern to the capability grammar", () => {
    const cases = [
      "*:read:**",
      "fs:read:notes:archive.md",
      "single",
      `fs:read:${"x".repeat(Capability.maxResourceLength + 1)}`
    ]

    for (const formatted of cases) {
      expect(AgentSession.patterns([formatted])).toEqual(Option.toArray(Capability.parsePattern(formatted)))
    }
  })
})
