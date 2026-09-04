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
  it("constructs immutable, narrowly-scoped dependency selectors", () => {
    const selector = Target.subtree("//packages/...", "lib")
    expect(selector).toEqual({
      _tag: "TargetDependencySelector",
      pattern: "//packages/...",
      target: "lib"
    })
    expect(Object.isFrozen(selector)).toBe(true)
    expect(Target.isDependencySelector(selector)).toBe(true)
    for (
      const [pattern, target] of [
        ["packages/...", "lib"],
        ["//packages/*", "lib"],
        ["//packages/...", ""],
        ["//packages/...", "bad/name"]
      ]
    ) {
      expect(() => Target.subtree(pattern!, target!)).toThrow()
    }
  })

  it("rejects malformed dependency selectors without invoking proxy traps", () => {
    let invoked = false
    const proxy = new Proxy({ _tag: "TargetDependencySelector", pattern: "//...", target: "lib" }, {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      }
    })
    expect(Target.isDependencySelector(proxy)).toBe(false)
    expect(invoked).toBe(false)
    expect(Target.isDependencySelector(null)).toBe(false)
    expect(Target.isDependencySelector({ _tag: "Other", pattern: "//...", target: "lib" })).toBe(false)
    expect(Target.isDependencySelector({
      _tag: "TargetDependencySelector",
      pattern: `//${"x".repeat(4_096)}/...`,
      target: "lib"
    })).toBe(false)
    expect(Target.isDependencySelector({
      _tag: "TargetDependencySelector",
      pattern: "//...",
      target: "x".repeat(257)
    })).toBe(false)
  })

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

  /**
   * A marker whose metadata is well formed except for one field. `{ target:
   * "forged" }` is refused by the first field it reads, so every collection
   * field below it went unchecked; each case here starts from real metadata
   * and breaks exactly one thing, which is the shape a forgery that copied a
   * genuine target and edited it would have.
   */
  const forged = (overrides: Readonly<Record<string, unknown>>): unknown => {
    const marker = (): void => undefined
    Object.defineProperty(marker, Target.TargetTypeId, {
      configurable: false,
      enumerable: false,
      value: { ...Target.metadata(Leaf({})), ...overrides },
      writable: false
    })
    return marker
  }

  it.each([
    ["accepts metadata copied from a real target", {}, true],
    ["refuses a kinds field that is not an array", { kinds: "build" }, false],
    ["refuses a kind the build system does not define", { kinds: ["deploy"] }, false],
    ["refuses a hole where a kind should be", { kinds: [, "build"] }, false],
    ["refuses a verb gate that is not an array of kinds", { verbGate: "build" }, false],
    ["refuses a verb gate naming an undefined kind", { verbGate: ["deploy"] }, false],
    ["refuses outputs that are not an object", { outputs: "dist" }, false],
    ["refuses outputs without a string cwd", { outputs: { cwd: 1, paths: [] } }, false],
    ["refuses outputs whose paths are not strings", { outputs: { cwd: ".", paths: [1] } }, false],
    ["accepts well-formed outputs and verb gate", {
      outputs: { cwd: ".", paths: ["dist/index.js"] },
      verbGate: ["build"]
    }, true]
  ])("%s", (_description, overrides, accepted) => {
    expect(Target.isTarget(forged(overrides))).toBe(accepted)
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
    const declaredSelector = Target.subtree("//packages/...", "lib")
    const mappedSelector = Target.subtree("//apps/...", "lib")
    const Parent = Target.make("RuleTestMappedDependencies", {
      attrs: Schema.Struct({ dependency: Target.Target, selector: Target.DependencySelector }),
      kinds: ["build", "lint"],
      attrsForKind: (kind, attrs) => kind === "lint" ? { dependency: mapped, selector: mappedSelector } : attrs,
      implementation: () => Target.notImplemented("RuleTestMappedDependencies")
    })

    const metadata = Target.metadata(Parent({ dependency: declared, selector: declaredSelector }))
    expect(metadata.dependencies).toEqual([declared])
    expect(metadata.dependencySelectors).toEqual([declaredSelector])
    expect(metadata.forKind("build").dependencies).toEqual([declared])
    expect(metadata.forKind("build").dependencySelectors).toEqual([declaredSelector])
    expect(metadata.forKind("lint").dependencies).toEqual([mapped])
    expect(metadata.forKind("lint").dependencySelectors).toEqual([mappedSelector])
  })

  it("deduplicates structurally equal dependency selectors", () => {
    const Holder = Target.make("RuleTestSelectorDeduplication", {
      attrs: Schema.Struct({ dependencies: Schema.Array(Target.Dependency) }),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestSelectorDeduplication")
    })
    const metadata = Target.metadata(Holder({
      dependencies: [
        Target.subtree("//packages/...", "lib"),
        Target.subtree("//packages/...", "lib")
      ]
    }))
    expect(metadata.dependencySelectors).toEqual([Target.subtree("//packages/...", "lib")])
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

  it("keeps implementation identity stable across separately created, textually identical definitions", () => {
    // Content-key material: the same definition evaluated by two processes
    // (here, two separate function objects with one source) must agree, or a
    // cache filled by one run is unreadable by the next.
    const first = Target.make("RuleTestStableIdentity", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestStableIdentity")
    })
    const second = Target.make("RuleTestStableIdentity", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestStableIdentity")
    })
    expect(Target.metadata(first({})).implementationDigest).toBe(Target.metadata(second({})).implementationDigest)
    const changed = Target.make("RuleTestStableIdentity", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestStableIdentityChanged")
    })
    expect(Target.metadata(changed({})).implementationDigest).not.toBe(Target.metadata(first({})).implementationDigest)
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
