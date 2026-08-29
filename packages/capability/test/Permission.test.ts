import { Option } from "effect"
import { systemError } from "effect/PlatformError"
import { describe, expect, it } from "vitest"
import { Capability, CapabilityPattern } from "../src/Capability.ts"
import {
  evaluate,
  fromPlatformError,
  permissionDenied,
  permissionRequired,
  Rule,
  type RuleEffect,
  toPlatformError
} from "../src/Permission.ts"

const capability = new Capability({
  action: "fs:read",
  resource: "/workspace/readme.md"
})

const rule = (
  effect: "allow" | "deny" | "ask",
  action: "fs:read" | "fs:*" | "*",
  resource: string
): Rule =>
  new Rule({
    effect,
    pattern: new CapabilityPattern({ action, resource })
  })

const fiveRulesetsWithFinalMatch = (
  decisivePosition: number,
  decisiveEffect: RuleEffect
): ReadonlyArray<ReadonlyArray<Rule>> =>
  Array.from({ length: 5 }, (_, position) => {
    if (position > decisivePosition) {
      return [rule("deny", "fs:read", "/does-not-match/**")]
    }
    if (position === decisivePosition) {
      return [rule(decisiveEffect, "fs:read", "/workspace/readme.md")]
    }
    if (position === 0) {
      return [rule("ask", "fs:read", "/workspace/readme.md")]
    }
    return [
      rule(
        decisiveEffect === "allow" ? "deny" : "allow",
        "fs:read",
        "/workspace/readme.md"
      )
    ]
  })

describe("Permission policy", () => {
  it("uses the last matching rule across ordered rulesets", () => {
    expect(
      evaluate(
        [
          [
            rule("deny", "fs:read", "/tmp/**"),
            rule("ask", "fs:*", "/workspace/**")
          ],
          [rule("allow", "fs:read", "/workspace/**")],
          [rule("deny", "fs:read", "/workspace/private/**")]
        ],
        capability
      )
    ).toBe("allow")

    expect(
      evaluate(
        [
          [rule("ask", "fs:*", "/workspace/**")],
          [
            rule("allow", "fs:read", "/workspace/**"),
            rule("deny", "fs:read", "/workspace/readme.md")
          ]
        ],
        capability
      )
    ).toBe("deny")
  })

  it("reduces configured rules last-match-wins before applying deny precedence", () => {
    expect(
      evaluate(
        [
          [
            rule("deny", "fs:*", "/workspace/**"),
            rule("allow", "fs:read", "/workspace/readme.md")
          ],
          [],
          [],
          [rule("allow", "*", "**")]
        ],
        capability
      )
    ).toBe("allow")

    expect(
      evaluate(
        [
          [
            rule("allow", "fs:read", "/workspace/readme.md"),
            rule("deny", "fs:*", "/workspace/**")
          ],
          [rule("allow", "*", "**")]
        ],
        capability
      )
    ).toBe("deny")
  })

  it.each(
    [
      [
        "configured deny wildcard",
        rule("deny", "fs:*", "/workspace/**"),
        rule("allow", "fs:read", "/workspace/readme.md"),
        "deny"
      ],
      [
        "configured ask wildcard",
        rule("ask", "fs:*", "/workspace/**"),
        rule("allow", "fs:read", "/workspace/**"),
        "allow"
      ]
    ] as const
  )("applies the configured veto semantics when %s overlaps a later session/tool grant", (
    _scenario,
    configured,
    later,
    expected
  ) => {
    // The module docs name only an effective configured `deny` as a hard veto;
    // a configured `ask` remains subject to last-match-wins.
    expect(evaluate([[configured], [later]], capability)).toBe(expected)
  })

  it.each(
    [
      [0, "allow"],
      [1, "deny"],
      [2, "allow"],
      [3, "deny"],
      [4, "allow"]
    ] as const
  )("uses the final match when it sits in ruleset position %i of five", (position, expected) => {
    expect(evaluate(fiveRulesetsWithFinalMatch(position, expected), capability)).toBe(expected)
  })

  it("re-evaluates a replacement denial after an earlier grant is revoked", () => {
    const allowed = [[rule("allow", "fs:read", "/workspace/readme.md")]]
    const revoked = [[rule("deny", "fs:read", "/workspace/readme.md")]]

    expect(evaluate(allowed, capability)).toBe("allow")
    expect(evaluate(revoked, capability)).toBe("deny")
  })

  it("defaults to ask when no rule matches", () => {
    expect(
      evaluate(
        [[rule("allow", "fs:read", "/other/**")]],
        capability
      )
    ).toBe("ask")
    expect(evaluate([], capability)).toBe("ask")
  })
})

describe("Permission construction and PlatformError projection", () => {
  it("copies caller metadata when constructing a permission request", () => {
    const callerMeta = { source: "original" }
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: callerMeta
    })

    callerMeta.source = "mutated"

    expect(required.meta).toEqual({ source: "original" })
  })

  it("preserves a numeric file descriptor in the PlatformError projection", () => {
    const error = permissionDenied(capability, "descriptor denied")
    const projected = toPlatformError({
      module: "FileSystem",
      method: "write",
      pathOrDescriptor: 17,
      error
    })

    expect(projected.reason).toMatchObject({ _tag: "PermissionDenied", pathOrDescriptor: 17 })
    expect(Option.getOrThrow(fromPlatformError(projected))).toBe(error)
  })

  it("does not unwrap an intervening PlatformError cause", () => {
    const projected = toPlatformError({
      module: "FileSystem",
      method: "write",
      error: permissionDenied(capability, "denied")
    })
    const doublyWrapped = systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "write",
      cause: projected
    })

    expect(fromPlatformError(doublyWrapped)).toStrictEqual(Option.none())
  })
})
