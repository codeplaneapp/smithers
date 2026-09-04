import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as Config from "../src/Config.ts"
import * as Kernel from "../src/Kernel.ts"

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect as Effect.Effect<A, E>)

describe("plugin configuration snapshots", () => {
  it("detaches caller data before apply and config hooks observe it", async () => {
    const source = { feature: { enabled: true }, values: [{ count: 1 }] }
    const patches = { contributed: { value: 1 } }
    const kernel = await run(Kernel.make([
      {
        name: "snapshot",
        apply: (config) => {
          source.feature.enabled = false
          source.values[0]!.count = 2
          expect(config["feature"]).toEqual({ enabled: true })
          expect(config["values"]).toEqual([{ count: 1 }])
          return true
        },
        hooks: { config: () => Effect.succeed(patches) }
      }
    ], source))
    patches.contributed.value = 2
    expect(kernel.config).toEqual({ feature: { enabled: true }, values: [{ count: 1 }], contributed: { value: 1 } })
    expect(Object.isFrozen(kernel.config)).toBe(true)
    expect(Object.isFrozen((kernel.config["values"] as ReadonlyArray<unknown>)[0])).toBe(true)
  })

  it("refuses prototype-control keys without changing any prototype", async () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const input = JSON.parse(`{"safe":{"${key}":{"enabled":true}}}`)
      const error = await run(Config.resolve(input).pipe(Effect.flip))
      expect(error).toMatchObject({ code: "config_invalid", path: `$.safe.${key}` })
      expect(({} as { enabled?: boolean }).enabled).toBeUndefined()
    }
  })

  it("never executes accessors and sanitizes reflection failures", async () => {
    const getter = vi.fn(() => "secret")
    const input = Object.defineProperty({}, "secret", { get: getter, enumerable: true })
    const error = await run(Config.resolve(input).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "config_invalid", path: "$.secret" })
    expect(error.message).not.toContain("secret")
    expect(getter).not.toHaveBeenCalled()

    const proxy = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("private trap")
      }
    })
    const proxyError = await run(Config.resolve(proxy).pipe(Effect.flip))
    expect(proxyError.code).toBe("config_invalid")
    expect(proxyError.message).not.toContain("private")
  })

  it("refuses cycles, exotic values, undefined members, and non-finite numbers", async () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (
      const value of [
        cycle,
        { value: new Date() },
        { value: new Map() },
        { value: new Set() },
        { value: new Uint8Array([1]) },
        { value: undefined },
        { value: Number.NaN }
      ]
    ) {
      expect((await run(Config.resolve(value as never).pipe(Effect.flip))).code).toBe("config_invalid")
    }
  })

  it("enforces the published depth and byte ceilings", async () => {
    let deep: unknown = 1
    for (let index = 0; index <= Config.maximumConfigDepth; index++) deep = { next: deep }
    expect(await run(Config.resolve({ deep } as never).pipe(Effect.flip))).toMatchObject({ code: "config_invalid" })
    expect(await run(Config.resolve({ large: "x".repeat(Config.maximumConfigBytes) }).pipe(Effect.flip))).toMatchObject(
      {
        code: "config_invalid"
      }
    )
  })

  it("re-admits a merged config so aggregate member bounds cannot be bypassed", () => {
    const base = Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`base${index}`, index]))
    const patch = Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`patch${index}`, index]))
    let error: unknown

    try {
      Config.merge(base, patch)
    } catch (cause) {
      error = cause
    }

    expect(error).toMatchObject({ code: "config_invalid", path: "$" })
  })

  it("still returns a deeply merged and frozen config after result admission", () => {
    const merged = Config.merge(
      { feature: { enabled: true, nested: { left: 1 } }, stable: [1, 2] },
      { feature: { label: "ready", nested: { right: 2 } } }
    )

    expect(merged).toEqual({
      feature: { enabled: true, label: "ready", nested: { left: 1, right: 2 } },
      stable: [1, 2]
    })
    expect(Object.isFrozen(merged)).toBe(true)
    expect(Object.isFrozen(merged["feature"])).toBe(true)
    expect(Object.isFrozen((merged["feature"] as { readonly nested: unknown }).nested)).toBe(true)
  })

  it("stops the config waterfall before a later hook can observe an over-limit merge", async () => {
    const initial = Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`base${index}`, index]))
    const patch = Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`patch${index}`, index]))
    const observedMembers: Array<number> = []
    const error = await run(
      Kernel.make([
        {
          name: "expander",
          hooks: { config: () => Effect.succeed(patch) }
        },
        {
          name: "observer",
          hooks: {
            config: (config) =>
              Effect.sync(() => {
                observedMembers.push(Object.keys(config).length)
                return {}
              })
          }
        }
      ], initial).pipe(Effect.flip)
    )

    // The refusal is attributed to the handler whose patch crossed the bound,
    // and the next handler never runs, so nothing observes the oversized value.
    expect(error).toMatchObject({ code: "config_invalid", path: "$", plugin: "expander", hook: "config" })
    expect(observedMembers).toEqual([])
  })

  it("keeps post-waterfall config failures small, located, and value-free for journalling", async () => {
    const offendingValue = "journal-secret-value"
    const invalid = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, {
      token: offendingValue
    })
    const error = await run(
      Kernel.make([{
        name: "invalid-config",
        hooks: { config: () => Effect.succeed({ invalid } as never) }
      }]).pipe(Effect.flip)
    )
    const encoded = JSON.stringify(error)

    expect(error).toMatchObject({ code: "config_invalid", path: "$.invalid" })
    expect(error.path?.length).toBeGreaterThan(0)
    expect(error.message).toContain("ordinary record")
    // Plugin failures are journalled, so one refusal must not retain a schema
    // tree or other kilobyte-scale diagnostic payload.
    expect(encoded.length).toBeLessThan(512)
    expect(encoded).not.toContain(offendingValue)
  })

  it("deepFreeze is a detached JSON snapshot rather than a shallow caller freeze", () => {
    const source = [{ nested: { value: 1 } }]
    const frozen = Config.deepFreeze(source)
    expect(frozen).not.toBe(source)
    expect(frozen[0]).not.toBe(source[0])
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen[0]?.nested)).toBe(true)
    source[0]!.nested.value = 2
    expect(frozen[0]?.nested.value).toBe(1)
    expect(() => Config.deepFreeze(new Date() as never)).toThrow()
  })
})
