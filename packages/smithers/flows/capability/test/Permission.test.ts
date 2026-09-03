import { Option, Schema } from "effect"
import { systemError } from "effect/PlatformError"
import { describe, expect, it } from "vitest"
import { Capability, CapabilityPattern, maxMatchWork } from "../src/Capability.ts"
import {
  evaluate,
  fromPlatformError,
  PermissionDenied,
  permissionDenied,
  PermissionRequired,
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

  it("treats rulesets[0] as configured policy when the same rulesets are reordered", () => {
    const denied = [rule("deny", "fs:read", "/workspace/readme.md")]
    const allowed = [rule("allow", "fs:read", "/workspace/readme.md")]
    const asked = [rule("ask", "fs:read", "/workspace/readme.md")]

    expect(evaluate([denied, asked, allowed], capability)).toBe("deny")
    expect(evaluate([allowed, denied, asked], capability)).toBe("ask")
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

  it("vetoes a decision when any rule cannot be matched within the work budget", () => {
    const big = new Capability(
      { action: "proc:spawn", resource: "x".repeat(100_000) },
      { disableChecks: true }
    )
    const allow = new Rule({
      effect: "allow",
      pattern: new CapabilityPattern({ action: "proc:spawn", resource: "*" })
    })
    const deny = new Rule({
      effect: "deny",
      pattern: new CapabilityPattern({ action: "proc:spawn", resource: `${"x".repeat(170)}*` })
    })

    expect(deny.pattern.resource.length * big.resource.length).toBeGreaterThan(maxMatchWork)
    expect(evaluate([[deny], [allow]], big)).toBe("deny")
    expect(evaluate([[allow, deny]], big)).toBe("deny")
  })

  it("does not veto for an over-budget rule whose action does not select the capability", () => {
    const big = new Capability(
      { action: "proc:spawn", resource: "x".repeat(100_000) },
      { disableChecks: true }
    )
    const deny = new Rule({
      effect: "deny",
      pattern: new CapabilityPattern({ action: "fs:read", resource: `${"x".repeat(170)}*` })
    })
    const allow = new Rule({
      effect: "allow",
      pattern: new CapabilityPattern({ action: "proc:spawn", resource: "*" })
    })

    expect(evaluate([[deny], [allow]], big)).toBe("allow")
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

  it("takes a deeply independent metadata snapshot", () => {
    const callerMeta = { a: { b: 1 } }
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: callerMeta
    })

    callerMeta.a.b = 2

    expect(required.meta).toEqual({ a: { b: 1 } })
  })

  it("drops an undefined metadata property before encoding", () => {
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: { cwd: undefined }
    })
    const encoded = Schema.encodeUnknownSync(PermissionRequired)(required)

    expect(required.meta).toEqual({})
    expect(required.meta).not.toHaveProperty("cwd")
    expect(encoded.meta).toEqual({})
    expect(encoded.meta).not.toHaveProperty("cwd")
  })

  it("drops nested undefined metadata properties", () => {
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: { spawn: { cwd: undefined } }
    })

    expect(required.meta).toEqual({ spawn: {} })
  })

  it("rejects undefined metadata array elements rather than changing them to null", () => {
    expect(() =>
      permissionRequired({
        requestId: "request-1",
        capability,
        tier: "compensable",
        meta: { list: [undefined] }
      })
    ).toThrow(/list/)
  })

  it("rejects bigint metadata at construction and names the field", () => {
    expect(() =>
      permissionRequired({
        requestId: "request-1",
        capability,
        tier: "compensable",
        meta: { offendingBigint: 1n }
      })
    ).toThrow(/offendingBigint/)
  })

  it.each([
    ["offendingFunction", () => undefined],
    ["offendingDate", new Date("2026-08-31T00:00:00.000Z")]
  ])("rejects non-JSON metadata at construction and names %s", (key, value) => {
    expect(() =>
      permissionRequired({
        requestId: "request-1",
        capability,
        tier: "compensable",
        meta: { [key]: value }
      })
    ).toThrow(new RegExp(key))
  })

  it("rejects a Date value instead of flattening the non-plain object", () => {
    expect(() =>
      permissionRequired({
        requestId: "request-1",
        capability,
        tier: "compensable",
        meta: { dateValue: new Date("2026-08-31T00:00:00.000Z") }
      })
    ).toThrow(/dateValue/)
  })

  it("deep-freezes the metadata snapshot", () => {
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: { k: 0, nested: { value: 1 }, list: [{ value: 2 }] }
    })

    expect(Object.isFrozen(required.meta)).toBe(true)
    expect(Object.isFrozen(required.meta.nested)).toBe(true)
    const list = required.meta.list
    expect(Array.isArray(list)).toBe(true)
    if (!Array.isArray(list)) throw new Error("expected metadata list")
    expect(Object.isFrozen(list)).toBe(true)
    expect(Object.isFrozen(list[0])).toBe(true)
    expect(() => {
      ;(required.meta as Record<string, unknown>).k = 1
    }).toThrow()
  })

  it("makes the metadata slot non-writable", () => {
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: { source: "original" }
    })

    expect(() => {
      ;(required as any).meta = { unsafe: 1n }
    }).toThrow()
    expect(required.meta).toEqual({ source: "original" })
    expect(() => Schema.encodeUnknownSync(PermissionRequired)(required)).not.toThrow()
  })

  it("does not retain the caller's capability in a permission request", () => {
    const callerCapability = new Capability({ action: "fs:read", resource: "/a" })
    const required = permissionRequired({
      requestId: "request-1",
      capability: callerCapability,
      tier: "sealed"
    })
    ;(callerCapability as any).resource = "/b"

    expect(required.capability.resource).toBe("/a")
  })

  it("does not retain the caller's capability in a permission denial", () => {
    const callerCapability = new Capability({ action: "fs:read", resource: "/a" })
    const denied = permissionDenied(callerCapability, "no")
    ;(callerCapability as any).resource = "/b"

    expect(denied.capability.resource).toBe("/a")
  })

  it.each([
    permissionRequired({ requestId: "request-1", capability, tier: "sealed" }),
    permissionDenied(capability, "no")
  ])("makes a permission failure's capability slot non-writable", (error) => {
    expect(() => {
      ;(error as any).capability = new Capability({ action: "fs:read", resource: "/replacement" })
    }).toThrow()
    expect(error.capability.resource).toBe("/workspace/readme.md")
  })

  it.each([
    permissionRequired({ requestId: "request-1", capability, tier: "sealed" }),
    permissionDenied(capability, "no")
  ])("makes a permission failure's carried capability immutable", (error) => {
    expect(() => {
      ;(error.capability as any).resource = "/replacement"
    }).toThrow()
    expect(error.capability.resource).toBe("/workspace/readme.md")
  })

  it("reports cyclic metadata as a schema failure instead of overflowing", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const cyclicArray: Array<unknown> = []
    cyclicArray.push(cyclicArray)

    expect(() => permissionRequired({ requestId: "request-1", capability, tier: "sealed", meta: cyclic })).toThrow(
      /Expected JSON value/
    )
    expect(() => permissionRequired({ requestId: "request-2", capability, tier: "sealed", meta: { cyclicArray } }))
      .toThrow(/Expected JSON value/)
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
