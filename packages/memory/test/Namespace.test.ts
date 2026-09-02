import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Bank from "../src/Bank.ts"
import * as Namespace from "../src/Namespace.ts"

const leaf = (): Namespace.TagGroup => ({ tags: ["scope:project"] })

const nested = (depth: number): Namespace.TagGroup => {
  let group = leaf()
  for (let level = 1; level < depth; level++) group = { not: group }
  return group
}

const wide = (nodes: number): Namespace.TagGroup => ({
  or: Array.from({ length: nodes - 1 }, leaf)
})

describe("Namespace", () => {
  it("parses banks through the validating public counterpart", async () => {
    await expect(Effect.runPromise(Bank.parse("agent-worker"))).resolves.toEqual({ kind: "agent", id: "worker" })
    const failure = await Effect.runPromise(Effect.flip(Bank.parse("")))
    expect(failure.code).toBe("invalid_namespace")
  })

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

  it("accepts the exact tag-group depth limit and rejects the next level without overflowing", () => {
    const decode = Schema.decodeUnknownSync(Namespace.TagGroup)
    expect(decode(nested(Namespace.MAX_TAG_GROUP_DEPTH))).toEqual(nested(Namespace.MAX_TAG_GROUP_DEPTH))

    let failure: unknown
    try {
      decode(nested(Namespace.MAX_TAG_GROUP_DEPTH + 1))
    } catch (cause) {
      failure = cause
    }
    expect(failure).toBeDefined()
    expect(failure).not.toBeInstanceOf(RangeError)
    expect(String(failure)).toContain("invalid_tag")
  })

  it("accepts the exact tag-group node limit and rejects one additional wide node", () => {
    const decode = Schema.decodeUnknownSync(Namespace.TagGroup)
    expect(decode(wide(Namespace.MAX_TAG_GROUP_NODES))).toEqual(wide(Namespace.MAX_TAG_GROUP_NODES))
    expect(() => decode(wide(Namespace.MAX_TAG_GROUP_NODES + 1))).toThrow(/invalid_tag/u)
  })

  it("evaluates an undecoded over-budget group as false without recursive stack growth", () => {
    expect(Namespace.matches(nested(500), ["scope:project"])).toBe(false)
  })
})
