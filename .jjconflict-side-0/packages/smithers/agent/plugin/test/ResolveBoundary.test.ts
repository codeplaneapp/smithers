import { Action } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as Hooks from "../src/Hooks.ts"
import type { FlowsPlugin } from "../src/index.ts"
import * as Plugins from "../src/Plugins.ts"
import * as Resolve from "../src/Resolve.ts"

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect as Effect.Effect<A, E>)

const refusal = async (input: unknown, options?: Resolve.Options) =>
  run(Resolve.resolve(input as never, options).pipe(Effect.flip))

describe("bounded plugin admission", () => {
  it("rejects inherited catalog names but accepts the same name when explicitly declared", async () => {
    const inherited = await refusal({ name: "inherited", hooks: { toString: () => Effect.void } })
    expect(inherited).toMatchObject({ code: "unknown_hook", hook: "toString" })

    const catalog = Object.create(null) as Record<string, Hooks.HookKind>
    Object.defineProperty(catalog, "toString", { value: "sequential", enumerable: true })
    const resolved = await run(Resolve.resolve(
      { name: "owned", hooks: { toString: () => Effect.succeed("ok") } } as never,
      { hooks: catalog }
    ))
    expect(resolved.handlers.get("toString")?.[0]?.plugin).toBe("owned")
  })

  it("does not collect an inherited handler for a prototype-named host hook", async () => {
    const catalog = Object.create(null) as Record<string, Hooks.HookKind>
    Object.defineProperty(catalog, "toString", { value: "sequential", enumerable: true })
    Object.defineProperty(catalog, "config", { value: "waterfall", enumerable: true })
    const resolved = await run(Resolve.resolve(
      { name: "owned", hooks: { config: () => Effect.void } } as never,
      { hooks: catalog }
    ))
    expect(resolved.handlers.get("toString")).toBeUndefined()
    expect(Object.getPrototypeOf(resolved.plugins[0]?.hooks)).toBeNull()
  })

  it("keeps canonically distinct Unicode names distinct without accepting malformed text", async () => {
    const resolved = await run(Resolve.resolve([{ name: "é" }, { name: "e\u0301" }]))
    expect(resolved.plugins.map((plugin) => plugin.name)).toEqual(["é", "e\u0301"])
    for (const name of ["", "\ud800", "line\nbreak", "x".repeat(Resolve.maximumPluginNameLength + 1)]) {
      expect(await refusal({ name })).toMatchObject({ code: "invalid_plugin", path: "$.name" })
    }
  })

  it("rejects whitespace-only names and versions at their declared paths", async () => {
    expect(await refusal({ name: " \u00a0" })).toMatchObject({ code: "invalid_plugin", path: "$.name" })
    expect(await refusal({ name: "versioned", version: "\u2003" })).toMatchObject({
      code: "invalid_plugin",
      plugin: "versioned",
      path: "$.version"
    })
  })

  it("validates plugin versions with the bounded name rules and attributes the plugin", async () => {
    for (
      const version of [
        "",
        1,
        "\ud800",
        "line\nbreak",
        "x".repeat(Resolve.maximumPluginNameLength + 1)
      ]
    ) {
      expect(await refusal({ name: "versioned", version })).toMatchObject({
        code: "invalid_plugin",
        plugin: "versioned",
        path: "$.version"
      })
    }
  })

  it("validates structure before filtering and host-catalog names only after selection", async () => {
    const symbolic = { name: "symbolic", [Symbol("field")]: true }
    const bad: ReadonlyArray<unknown> = [
      true,
      0,
      "plugin",
      {},
      { name: "x", unknown: true },
      { name: "x", enforce: "first" },
      { name: "x", apply: 1 },
      { name: "x", layer: {} },
      { name: "x", hooks: new Date() },
      { name: "x", hooks: { config: null } },
      { name: "x", hooks: { config: 1 } },
      { name: "x", hooks: { config: {} } },
      { name: "x", hooks: { config: { handler: 1 } } },
      { name: "x", hooks: { config: { order: "middle", handler: () => Effect.void } } },
      { name: "x", hooks: { config: { handler: () => Effect.void, extra: true } } },
      symbolic
    ]
    for (const input of bad) expect((await refusal(input)).code).toBe("invalid_plugin")

    // Exclusion cannot hide a malformed hook.
    const excluded = await refusal({ name: "excluded", apply: "harness", hooks: { config: 1 } })
    expect(excluded.code).toBe("invalid_plugin")
  })

  it("lets one preset carry host-specific hooks without weakening selected catalog checks", async () => {
    const handler = () => Effect.void
    const harnessPlugin = { name: "h", apply: "harness" as const, hooks: { harnessOnly: handler } }

    const engine = await run(Resolve.resolve(harnessPlugin as never))
    expect(engine.plugins).toEqual([])
    expect(engine.handlers.size).toBe(0)

    const harness = await run(Resolve.resolve(harnessPlugin as never, {
      target: "harness",
      hooks: { ...Hooks.engineHooks, harnessOnly: "sequential" }
    }))
    expect(harness.handlers.get("harnessOnly")?.[0]).toMatchObject({ plugin: "h", hook: "harnessOnly" })

    const selected = await refusal({ name: "selected", hooks: { harnessOnly: handler } })
    expect(selected).toMatchObject({
      code: "unknown_hook",
      message: "plugin \"selected\" declares unknown hook \"harnessOnly\"",
      plugin: "selected",
      hook: "harnessOnly",
      path: "$.hooks.harnessOnly"
    })
  })

  it("never invokes plugin, hook, or option accessors during validation", async () => {
    const getter = vi.fn(() => "secret")
    const plugin = Object.defineProperty({ name: "accessor" }, "hooks", { get: getter, enumerable: true })
    const hook = Object.defineProperty({}, "handler", { get: getter, enumerable: true })
    const options = Object.defineProperty({}, "target", { get: getter, enumerable: true })
    expect((await refusal(plugin)).code).toBe("invalid_plugin")
    expect((await refusal({ name: "hook", hooks: { config: hook } })).code).toBe("invalid_plugin")
    expect((await refusal([], options as Resolve.Options)).code).toBe("invalid_plugin")
    expect(getter).not.toHaveBeenCalled()
  })

  it("maps predicate throws and invalid answers to stable typed failures", async () => {
    const thrown = await refusal({
      name: "throwing",
      apply: () => {
        throw new Error("secret predicate detail")
      }
    })
    expect(thrown).toMatchObject({ code: "apply_failed", plugin: "throwing", path: "$.apply" })
    expect(thrown.message).not.toContain("secret")

    const nonBoolean = await refusal({ name: "non-boolean", apply: () => "yes" as never })
    expect(nonBoolean).toMatchObject({ code: "invalid_plugin", plugin: "non-boolean" })
  })

  it("snapshots the apply config before a predicate can observe caller mutation", async () => {
    const config = { feature: { enabled: true } }
    let observed: unknown
    const resolved = await run(Resolve.resolve({
      name: "conditional",
      apply: (snapshot) => {
        observed = snapshot["feature"]
        expect(Object.isFrozen(snapshot)).toBe(true)
        expect(Object.isFrozen(snapshot["feature"])).toBe(true)
        return true
      }
    }, { config }))
    config.feature.enabled = false
    expect(observed).toEqual({ enabled: true })
    expect(resolved.plugins).toHaveLength(1)
  })

  it("returns a detached catalog with no mutable map or handler records", async () => {
    const original = {
      name: "original",
      enforce: "pre" as const,
      hooks: { configResolved: () => Effect.void }
    }
    const resolved = await run(Resolve.resolve([original]))
    const record = resolved.handlers.get("configResolved")![0]!
    original.name = "mutated"
    original.hooks.configResolved = () => Effect.die("changed")

    expect(resolved.plugins[0]?.name).toBe("original")
    expect(Object.isFrozen(resolved.plugins[0])).toBe(true)
    expect(Object.isFrozen(resolved.plugins[0]?.hooks)).toBe(true)
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(resolved.handlers)).toBe(true)
    expect((resolved.handlers as unknown as { set?: unknown }).set).toBeUndefined()
    expect(Reflect.set(record, "plugin", "injected")).toBe(false)
    expect(Reflect.set(resolved.plugins, "0", { name: "injected" })).toBe(false)

    expect([...resolved.handlers.keys()]).toEqual(["configResolved"])
    expect([...resolved.handlers.values()]).toEqual([[record]])
    expect([...resolved.handlers.entries()]).toEqual([["configResolved", [record]]])
    expect([...resolved.handlers]).toEqual([["configResolved", [record]]])
    const visited: Array<string> = []
    resolved.handlers.forEach((_records, hook, map) => {
      visited.push(hook)
      expect(map).toBe(resolved.handlers)
    })
    expect(visited).toEqual(["configResolved"])
  })

  it("rejects malformed options and hook catalogs", async () => {
    for (
      const options of [
        { target: "worker" },
        { parallelConcurrency: 0 },
        { parallelConcurrency: 1.5 },
        { parallelConcurrency: Resolve.maximumParallelConcurrency + 1 },
        { parallelConcurrency: "two" },
        { hooks: [] },
        { hooks: { config: "sometimes" } },
        { hooks: new Date() },
        { extra: true }
      ] as ReadonlyArray<unknown>
    ) {
      expect(Exit.isFailure(await Effect.runPromiseExit(Resolve.resolve([], options as Resolve.Options)))).toBe(true)
    }
    const symbolic = { config: "waterfall", [Symbol("x")]: "parallel" }
    expect((await refusal([], { hooks: symbolic as never })).code).toBe("invalid_plugin")

    const hiddenCatalog = Object.defineProperty({}, "config", { value: "waterfall", enumerable: false })
    expect((await refusal([], { hooks: hiddenCatalog as never })).code).toBe("invalid_plugin")

    const optionProxy = new Proxy({}, {
      ownKeys: () => {
        throw new Error("options trap")
      }
    })
    const catalogProxy = new Proxy({}, {
      ownKeys: () => {
        throw new Error("catalog trap")
      }
    })
    const pluginProxy = new Proxy({}, {
      ownKeys: () => {
        throw new Error("plugin trap")
      }
    })
    expect((await refusal([], optionProxy as Resolve.Options)).code).toBe("invalid_plugin")
    expect((await refusal([], { hooks: catalogProxy as never })).code).toBe("invalid_plugin")
    expect((await refusal(pluginProxy)).code).toBe("invalid_plugin")
  })

  it("rejects cyclic, repeated, sparse, decorated, and over-deep preset arrays", async () => {
    const cycle: Array<unknown> = []
    cycle.push(cycle)
    const shared: Array<unknown> = [{ name: "shared" }]
    const sparse = new Array(1)
    const decorated = Object.assign([], { extra: true })
    const accessor = [false]
    Object.defineProperty(accessor, "0", { get: () => false, enumerable: true, configurable: true })
    for (const input of [cycle, [shared, shared], sparse, decorated, accessor]) {
      expect((await refusal(input)).code).toBe("invalid_plugin")
    }

    let nested: unknown = { name: "deep" }
    for (let index = 0; index <= Resolve.maximumPluginDepth; index++) nested = [nested]
    expect(await refusal(nested)).toMatchObject({ code: "resource_limit" })
  })

  it("enforces plugin, input-node, and handler ceilings", async () => {
    const atPluginLimit = Array.from({ length: Resolve.maximumPlugins }, (_, index) => ({ name: `p-${index}` }))
    expect((await run(Resolve.resolve(atPluginLimit))).plugins).toHaveLength(Resolve.maximumPlugins)
    expect(await refusal([...atPluginLimit, { name: "too-many" }])).toMatchObject({ code: "resource_limit" })

    const tooManyNodes = Array.from({ length: Resolve.maximumPluginInputNodes }, () => false)
    expect(await refusal(tooManyNodes)).toMatchObject({ code: "resource_limit" })

    const hooks = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`h${index}`, "sequential"])) as Record<
      string,
      Hooks.HookKind
    >
    const handler = () => Effect.void
    const contributors = Array.from({ length: Math.floor(Resolve.maximumHandlers / 5) + 1 }, (_, index) => ({
      name: `handlers-${index}`,
      hooks: Object.fromEntries(Object.keys(hooks).map((hook) => [hook, handler]))
    }))
    expect(await refusal(contributors, { hooks })).toMatchObject({ code: "resource_limit" })

    const excludedHooks = Object.fromEntries(
      Array.from({ length: Resolve.maximumHandlers + 1 }, (_, index) => [`excluded${index}`, handler])
    )
    const excluded = await run(Resolve.resolve({
      name: "excluded-handler-budget",
      apply: "harness",
      hooks: excludedHooks
    } as never))
    expect(excluded.plugins).toEqual([])
  })

  it("accepts the hook object form with and without an explicit order", async () => {
    const handler = () => Effect.void
    const resolved = await run(Resolve.resolve([
      { name: "normal", hooks: { configResolved: { handler } } },
      { name: "pre", hooks: { configResolved: { order: "pre", handler } } }
    ]))
    expect(resolved.handlers.get("configResolved")?.map((entry) => entry.plugin)).toEqual(["pre", "normal"])
  })
})

describe("cache-environment admission", () => {
  it("decodes, detaches, and deeply freezes cache identity at resolution", async () => {
    const capabilities = { fs: ["/safe/**"] }
    const layers = ["Host=node"]
    const resolved = await run(Resolve.resolve([{ name: "model", version: "1.0.0" }], {
      cacheEnvironment: { layers, capabilities }
    }))
    layers.push("mutated")
    capabilities.fs.push("/**")
    expect(resolved.cacheEnvironment).toEqual({
      layers: ["model@1.0.0", "Host=node"],
      capabilities: { fs: ["/safe/**"] }
    })
    expect(Object.isFrozen(resolved.cacheEnvironment)).toBe(true)
    expect(Object.isFrozen(resolved.cacheEnvironment?.layers)).toBe(true)
    expect(Object.isFrozen(resolved.cacheEnvironment?.capabilities)).toBe(true)
    expect(Object.isFrozen(resolved.cacheEnvironment?.capabilities["fs"])).toBe(true)

    const environment = await run(
      Action.CurrentCacheEnvironment.pipe(Effect.provide(Resolve.layer(resolved)))
    )
    expect(environment).toBe(resolved.cacheEnvironment)
  })

  it("refuses invalid and hostile cache identities without retaining their values", async () => {
    const getter = vi.fn(() => ["secret"])
    const hostile = Object.defineProperty({ layers: [] }, "capabilities", { get: getter, enumerable: true })
    const values = [
      { layers: [""], capabilities: {} },
      { layers: [], capabilities: { "": ["x"] } },
      { layers: [], capabilities: { fs: [""] } },
      { layers: "node", capabilities: {} },
      hostile
    ]
    for (const cacheEnvironment of values) {
      const error = await refusal([], { cacheEnvironment: cacheEnvironment as never })
      expect(error.code).toBe("cache_environment_invalid")
      expect(error.message).not.toContain("secret")
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it("still wraps a validated layer that later fails to construct", async () => {
    const broken = Layer.effectDiscard(Effect.die("layer defect"))
    const resolved = await run(Resolve.resolve([{ name: "broken", layer: broken }]))
    const error = await run(Effect.void.pipe(Effect.provide(Resolve.layer(resolved)), Effect.flip))
    expect(error).toMatchObject({ code: "layer_failed", plugin: "broken" })
  })
})
