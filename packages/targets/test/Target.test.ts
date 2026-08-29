import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Target from "../src/Target.ts"

const Leaf = Target.make("RuleTestLeaf", {
  attrs: Schema.Struct({}),
  kinds: ["build"],
  implementation: () => Target.notImplemented("RuleTestLeaf")
})

describe("Target metadata traversal", () => {
  it("recognizes only an own, immutable, well-formed target marker", () => {
    const target = Leaf({})
    expect(Target.isTarget(target)).toBe(true)

    let invoked = false
    const accessor = (): void => undefined
    Object.defineProperty(accessor, Target.TargetTypeId, {
      configurable: false,
      enumerable: false,
      get: () => {
        invoked = true
        return Target.metadata(target)
      }
    })
    expect(Target.isTarget(accessor)).toBe(false)
    expect(invoked).toBe(false)

    const malformed = (): void => undefined
    Object.defineProperty(malformed, Target.TargetTypeId, {
      configurable: false,
      enumerable: false,
      value: { target: "forged" },
      writable: false
    })
    expect(Target.isTarget(malformed)).toBe(false)
    expect(() => Target.metadata(malformed as never)).toThrow(/not a well-formed smithers build target/)
  })

  it("rejects target proxies without invoking their traps", () => {
    let invoked = false
    const proxy = new Proxy(Leaf({}), {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      },
      has: () => {
        invoked = true
        return true
      }
    })
    expect(Target.isTarget(proxy)).toBe(false)
    expect(invoked).toBe(false)
  })

  it("defaults arbitrary target implementations to non-cacheable", () => {
    expect(Target.metadata(Leaf({})).cacheable).toBe(false)
  })

  it("requires a target implementation to opt into cache replay explicitly", () => {
    const Deterministic = Target.make("RuleTestDeterministic", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      cache: true,
      implementation: () => Target.notImplemented("RuleTestDeterministic")
    })
    expect(Target.metadata(Deterministic({})).cacheable).toBe(true)
  })

  it("re-derives dependencies from verb-effective attrs", () => {
    const declared = Leaf({})
    const mapped = Leaf({})
    const Parent = Target.make("RuleTestMappedDependencies", {
      attrs: Schema.Struct({ dependency: Target.Target }),
      kinds: ["build", "lint"],
      attrsForKind: (kind, attrs) => kind === "lint" ? { dependency: mapped } : attrs,
      implementation: () => Target.notImplemented("RuleTestMappedDependencies")
    })

    const metadata = Target.metadata(Parent({ dependency: declared }))
    expect(metadata.dependencies).toEqual([declared])
    expect(metadata.forKind("build").dependencies).toEqual([declared])
    expect(metadata.forKind("lint").dependencies).toEqual([mapped])
  })

  it("does not recurse forever through a cyclic array", () => {
    const cyclic: Array<unknown> = []
    cyclic.push(cyclic)
    const Holder = Target.make("RuleTestCycle", {
      attrs: Schema.Struct({ value: Schema.Unknown }),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestCycle")
    })

    expect(() => Holder({ value: cyclic })).not.toThrow()
  })

  it("refuses a Proxy without executing its traversal traps", () => {
    let invoked = false
    const proxy = new Proxy({}, {
      ownKeys: () => {
        invoked = true
        return []
      }
    })
    const Holder = Target.make("RuleTestProxy", {
      attrs: Schema.Struct({ value: Schema.Unknown }),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestProxy")
    })

    expect(() => Holder({ value: proxy })).toThrow(/must not contain a Proxy/)
    expect(invoked).toBe(false)
  })

  it("changes implementation identity when a runtime contract changes", () => {
    const implementation = () => Target.notImplemented("RuleTestSchemaIdentity")
    const StringResult = Target.make("RuleTestSchemaIdentity", {
      attrs: Schema.Struct({ value: Schema.String }),
      kinds: ["build"],
      success: Schema.String,
      error: Schema.String,
      implementation
    })
    const NumberResult = Target.make("RuleTestSchemaIdentity", {
      attrs: Schema.Struct({ value: Schema.String }),
      kinds: ["build"],
      success: Schema.Number,
      error: Schema.String,
      implementation
    })

    expect(Target.metadata(StringResult({ value: "x" })).implementationDigest)
      .not.toBe(Target.metadata(NumberResult({ value: "x" })).implementationDigest)
  })

  it("changes implementation identity when cache admission policy changes", () => {
    const definition = (cache: boolean) =>
      Target.make("RuleTestCacheIdentity", {
        attrs: Schema.Struct({}),
        kinds: ["build"],
        cache,
        implementation: () => Target.notImplemented("RuleTestCacheIdentity")
      })
    expect(Target.metadata(definition(false)({})).implementationDigest)
      .not.toBe(Target.metadata(definition(true)({})).implementationDigest)
  })

  it("changes implementation identity when declared captures change", () => {
    const definition = (tool: string) =>
      Target.make("RuleTestCapturedIdentity", {
        attrs: Schema.Struct({}),
        kinds: ["build"],
        implementation: Node.capture({ tool }, () => Target.notImplemented(tool))
      })

    expect(Target.metadata(definition("first")({})).implementationDigest)
      .not.toBe(Target.metadata(definition("second")({})).implementationDigest)
  })
})
