import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Namespace from "../src/Namespace.ts"

describe("Namespace", () => {
  it("decodes the four structured namespace kinds", () => {
    const decode = Schema.decodeUnknownSync(Namespace.Namespace)
    for (const kind of ["flow", "agent", "user", "global"] as const) {
      expect(decode({ kind, id: "bank-1" })).toEqual({ kind, id: "bank-1" })
    }
    expect(() => decode({ kind: "run", id: "bank-1" })).toThrow()
    expect(() => decode({ kind: "flow", id: "" })).toThrow()
  })

  it("enforces the tag vocabulary and 16-tag cap", () => {
    const decode = Schema.decodeUnknownSync(Namespace.Tags)
    expect(decode(["branch:main", "stream:checkout", "source:run", "scope:project"])).toEqual([
      "branch:main",
      "stream:checkout",
      "source:run",
      "scope:project"
    ])
    expect(() => decode(["custom:value"])).toThrow()
    expect(() => decode(["scope:"])).toThrow()
    expect(() => decode(Array.from({ length: 17 }, (_, index) => `scope:${index}`))).toThrow()
  })

  it("evaluates leaf match modes with Smithers wildcard semantics", () => {
    const tags = ["branch:main", "scope:project"]
    expect(Namespace.matches({ tags: ["branch:main"] }, tags)).toBe(true)
    expect(Namespace.matches({ tags: ["branch:other"] }, [])).toBe(true)
    expect(Namespace.matches({ tags: ["branch:main", "scope:other"], match: "all" }, tags)).toBe(false)
    expect(Namespace.matches({ tags: ["branch:main"], match: "all" }, [])).toBe(true)
    expect(Namespace.matches({ tags: ["branch:main"], match: "any_strict" }, [])).toBe(false)
    expect(Namespace.matches({ tags: ["branch:main", "scope:project"], match: "all_strict" }, tags)).toBe(true)
    expect(Namespace.matches({ tags: ["branch:main"], match: "exact" }, tags)).toBe(false)
    expect(
      Namespace.matches({ tags: ["scope:project", "branch:main"], match: "exact" }, tags)
    ).toBe(true)
  })

  it("combines tag groups with and, or, and not", () => {
    const group: Namespace.TagGroup = {
      and: [
        {
          or: [
            { tags: ["branch:main"], match: "all_strict" },
            { tags: ["branch:release"], match: "all_strict" }
          ]
        },
        { not: { tags: ["scope:secret"], match: "any_strict" } }
      ]
    }
    expect(Namespace.matches(group, ["branch:main", "scope:project"])).toBe(true)
    expect(Namespace.matches(group, ["branch:main", "scope:secret"])).toBe(false)
    expect(Namespace.matches(group, ["branch:feature", "scope:project"])).toBe(false)
    expect(Schema.decodeUnknownSync(Namespace.TagGroup)(group)).toEqual(group)
  })
})
