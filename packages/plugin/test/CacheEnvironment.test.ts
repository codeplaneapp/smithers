/**
 * Issue #88: `Action.CurrentCacheEnvironment` had zero production
 * providers — the machinery issue #75 added defaulted to the empty
 * environment in every shipped composition, so swapping a model or host
 * plugin left every sealed content digest byte-identical and served the
 * stale cross-run cache entry.
 *
 * The plugin kernel declares an environment only when the application
 * supplies its complete capability identity. Otherwise the engine keeps
 * sealed keys run-local.
 */
import { Action } from "@smthrs/flow"
import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as Kernel from "../src/Kernel.ts"
import * as Plugin from "../src/Plugin.ts"

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect as Effect.Effect<A, E>)

class Marker extends Context.Service<Marker, string>()("CacheEnvironment/Marker") {}

describe("the kernel declares the cache environment (issue #88)", () => {
  it("leaves the environment absent when no complete identity is supplied", async () => {
    const kernel = await run(Kernel.make([
      Plugin.make({ name: "flows-plugin-model-sonnet" }),
      Plugin.make({
        name: "flows-plugin-host-local",
        layer: Layer.succeed(Marker)("host")
      })
    ]))
    const environment = await run(
      Effect.gen(function*() {
        // A plugin-contributed service and the environment resolve from the
        // same merged layer.
        expect(yield* Marker).toBe("host")
        return yield* Action.CurrentCacheEnvironment
      }).pipe(Effect.provide(kernel.layer))
    )
    // Asserted as a whole value, not just `.layers`: `undefined` is the
    // engine's "nothing was declared" state, which scopes sealed cache keys
    // to a single run. A kernel that produced it would be an issue-#88
    // regression that the property access alone would not catch.
    expect(environment).toBeUndefined()
  })

  it("a layer-less plugin list also leaves it absent", async () => {
    const kernel = await run(Kernel.make([Plugin.make({ name: "flows-plugin-hooks-only" })]))
    const environment = await run(
      Effect.gen(function*() {
        return yield* Action.CurrentCacheEnvironment
      }).pipe(Effect.provide(kernel.layer))
    )
    expect(environment).toBeUndefined()
  })

  it("accepts a complete capability and non-plugin layer identity", async () => {
    const kernel = await run(Kernel.make(
      [Plugin.make({ name: "flows-plugin-model-sonnet" })],
      {},
      {
        cacheEnvironment: {
          layers: ["Host=node"],
          capabilities: { fs: ["/workspace/**"] }
        }
      }
    ))
    const environment = await run(
      Effect.gen(function*() {
        return yield* Action.CurrentCacheEnvironment
      }).pipe(Effect.provide(kernel.layer))
    )
    expect(environment).toEqual({
      layers: ["flows-plugin-model-sonnet", "Host=node"],
      capabilities: { fs: ["/workspace/**"] }
    })
  })

  it("uses plugin identities when the additional layer list is empty", async () => {
    const kernel = await run(Kernel.make(
      [Plugin.make({ name: "flows-plugin-model-sonnet" })],
      {},
      { cacheEnvironment: { layers: [], capabilities: {} } }
    ))
    const environment = await run(Action.CurrentCacheEnvironment.pipe(Effect.provide(kernel.layer)))
    expect(environment).toEqual({
      layers: ["flows-plugin-model-sonnet"],
      capabilities: {}
    })
  })
})
