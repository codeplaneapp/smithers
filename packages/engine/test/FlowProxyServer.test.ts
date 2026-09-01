// Deep reviewed and polished by a human on 2026-08-10.

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, FileSystem, Layer, Option, Path, Schema, Scope } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiTest } from "effect/unstable/httpapi"
import { RpcTest } from "effect/unstable/rpc"
import { FlowEngine, FlowProxy, FlowProxyServer } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Scope.Scope>) =>
  it.effect(name, () => withCrypto(Effect.scoped(body())))

const EchoActionDeclaration = Action.make("Proxy/Echo/action", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  error: Schema.Literal("invalid")
})
const Echo = Flow.make("Proxy/Echo", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  error: Schema.Literal("invalid"),
  idempotencyKey: ({ value }) => String(value),
  body: (payload) => EchoActionDeclaration.call(payload)
})

const Gate = DurableDeferred.make("Proxy/Gate", { success: Schema.Number })

const SuspendsActionDeclaration = Action.make("Proxy/Suspends/action", {
  payload: { id: Schema.String },
  success: Schema.Number
})
const Suspends = Flow.make("Proxy/Suspends", {
  payload: { id: Schema.String },
  success: Schema.Number,
  idempotencyKey: ({ id }) => id,
  body: (payload) => SuspendsActionDeclaration.call(payload)
})

const flows = [Echo, Suspends] as const

const makeLayer = (echo: (value: number) => Effect.Effect<number, "invalid">) => {
  let calls = 0
  const counted = (value: number) =>
    Effect.suspend(() => {
      calls++
      return echo(value)
    })
  const layer = Layer.mergeAll(
    Layer.mergeAll(EchoActionDeclaration.toLayer(({ value }) => counted(value)), Interpreter.layer(Echo)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ),
    Layer.mergeAll(SuspendsActionDeclaration.toLayer(() => DurableDeferred.await(Gate)), Interpreter.layer(Suspends))
      .pipe(
        Layer.provideMerge(Action.layerImplementations)
      )
  ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
  return { layer, calls: () => calls }
}

describe("FlowProxyServer.layerRpcHandlers", () => {
  effect("dispatches execute requests to the registered flow", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const result = yield* client["Proxy/Echo"]({
        payload: { value: 41 },
        executionId: "echo-1"
      })
      expect(result).toBe(42)
      expect(calls()).toBe(1)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("deduplicates repeated execute requests for one execution id", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const first = yield* client["Proxy/Echo"]({ payload: { value: 1 }, executionId: "dedupe" })
      const second = yield* client["Proxy/Echo"]({ payload: { value: 1 }, executionId: "dedupe" })
      expect([first, second]).toEqual([2, 2])
      // the second request replays the completed execution instead of re-running it
      expect(calls()).toBe(1)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("concurrent execute requests share a single execution", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value * 2))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const call = client["Proxy/Echo"]({ payload: { value: 5 }, executionId: "concurrent" })
      const results = yield* Effect.all([call, call, call], { concurrency: "unbounded" })
      expect(results).toEqual([10, 10, 10])
      expect(calls()).toBe(1)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("surfaces flow failures as typed rpc errors", () => {
    const { layer } = makeLayer(() => Effect.fail("invalid" as const))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const exit = yield* Effect.exit(
        client["Proxy/Echo"]({ payload: { value: 7 }, executionId: "failing" })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain("invalid")
      }
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("discard starts the flow without awaiting it, and resume drives it forward", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      yield* client["Proxy/SuspendsDiscard"]({
        payload: { id: "resume-me" },
        executionId: "resume-me"
      })
      yield* Effect.yieldNow
      const suspended = yield* Suspends.poll("resume-me")
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")

      // resume is a no-op while the deferred is unresolved
      yield* client["Proxy/SuspendsResume"]({ executionId: "resume-me" })
      yield* Effect.yieldNow
      const stillSuspended = yield* Suspends.poll("resume-me")
      expect(Option.isSome(stillSuspended) && stillSuspended.value._tag).toBe("Suspended")

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow: Suspends,
        executionId: "resume-me"
      })
      yield* DurableDeferred.succeed(Gate, { token, value: 9 })
      yield* client["Proxy/SuspendsResume"]({ executionId: "resume-me" })
      let result = yield* Suspends.poll("resume-me")
      for (let i = 0; i < 20 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
        yield* Effect.yieldNow
        result = yield* Suspends.poll("resume-me")
      }
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(9)
      }
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provideMerge(layer)))
    )
  })

  effect("derives the execution identity from the flow's idempotency key when the request omits executionId", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const first = yield* client["Proxy/Echo"]({ payload: { value: 41 } })
      const repeat = yield* client["Proxy/Echo"]({ payload: { value: 41 } })
      expect([first, repeat]).toEqual([42, 42])
      // Echo declares `idempotencyKey: String(value)`, so both requests
      // derive one identity and the second replays instead of re-running.
      expect(calls()).toBe(1)
      // A different payload derives a different identity and runs.
      expect(yield* client["Proxy/Echo"]({ payload: { value: 10 } })).toBe(11)
      expect(calls()).toBe(2)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("resume with an unknown or empty execution id is a no-op success", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      yield* client["Proxy/EchoResume"]({ executionId: "proxy-never-started" })
      yield* client["Proxy/SuspendsResume"]({ executionId: "" })
      // Nothing was started, dispatched, or invented for the unknown id: the
      // engine still reports it as a typed not-found.
      const error = yield* Effect.flip(Echo.poll("proxy-never-started"))
      expect(error).toMatchObject({
        _tag: "@smthrs/flow/FlowExecutionNotFound",
        executionId: "proxy-never-started"
      })
      expect(calls()).toBe(0)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provideMerge(layer)))
    )
  })

  effect("serves prefixed rpc tags when a prefix is configured", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value + 100))
    const group = FlowProxy.toRpcGroup(flows, { prefix: "v1/" })
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(group)
      const result = yield* client["v1/Proxy/Echo"]({
        payload: { value: 1 },
        executionId: "prefixed"
      })
      expect(result).toBe(101)
    }).pipe(
      Effect.provide(
        FlowProxyServer.layerRpcHandlers(flows, { prefix: "v1/" }).pipe(Layer.provide(layer))
      )
    )
  })
})

describe("serving a flow is executing it", () => {
  // Serving happens on the side of the boundary that drives the body, so the
  // compile-time gate on a missing action implementation has to hold here
  // too. A type test: `tsc -p tsconfig.test.json` in `pnpm run check` fails on
  // a red assertion whether or not the suite is run.
  it("requires the action implementations of every flow it serves", () => {
    type Served = Layer.Services<ReturnType<typeof FlowProxyServer.layerRpcHandlers<typeof flows>>>

    expectTypeOf<Action.Requirement<"Proxy/Echo/action">>().toExtend<Served>()
    expectTypeOf<Action.Requirement<"Proxy/Suspends/action">>().toExtend<Served>()

    const engineOnly = Interpreter.layer(Echo).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    const unmet = Effect.void.pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(engineOnly)))
    )

    // An engine and a table satisfy everything except the implementations, and
    // those are exactly what is left over.
    expectTypeOf<Effect.Services<typeof unmet>>().toEqualTypeOf<
      Action.Requirement<"Proxy/Echo/action"> | Action.Requirement<"Proxy/Suspends/action">
    >()

    // Never invoked: the assertion is that this expression does not compile.
    // `Effect.runPromise` is the point — the Promise boundary is what refuses
    // an Effect whose requirements are unmet.
    // @ts-expect-error -- the served bodies name two actions, and nothing in
    // this composition implements either.
    const unimplemented = () => Effect.runPromise(unmet)

    expectTypeOf(unimplemented).toBeFunction()
  })

  it("has them erased by the composition the suites serve with", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value))
    const served = Effect.void.pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )

    expectTypeOf<Effect.Services<typeof served>>().toEqualTypeOf<never>()
  })
})

const HttpTestServices = Layer.mergeAll(
  Path.layer,
  Etag.layerWeak,
  HttpPlatform.layer
).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

class ProxyApi extends HttpApi.make("proxy").add(
  FlowProxy.toHttpApiGroup("flows", flows)
) {}

describe("FlowProxyServer.layerHttpApi", () => {
  const client = HttpApiTest.groups(ProxyApi, ["flows"])

  const provide =
    (layer: Layer.Layer<any, never, never>) => <A, E>(self: Effect.Effect<A, E, any>): Effect.Effect<A, E, never> =>
      self.pipe(
        Effect.provide(
          FlowProxyServer.layerHttpApi(ProxyApi, "flows", flows).pipe(
            Layer.provideMerge(layer)
          )
        ),
        Effect.provide(HttpTestServices)
      ) as Effect.Effect<A, E, never>

  effect("routes the execute endpoint to the flow handler", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    return Effect.gen(function*() {
      const api = yield* client
      const result = yield* api.flows["Proxy/Echo"]({
        payload: { payload: { value: 1 }, executionId: "http-execute" }
      })
      expect(result).toBe(2)
      expect(calls()).toBe(1)
    }).pipe(provide(layer))
  })

  effect("returns the declared error from the execute endpoint", () => {
    const { layer } = makeLayer(() => Effect.fail("invalid" as const))
    return Effect.gen(function*() {
      const api = yield* client
      const exit = yield* Effect.exit(
        api.flows["Proxy/Echo"]({
          payload: { payload: { value: 2 }, executionId: "http-error" }
        })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain("invalid")
      }
    }).pipe(provide(layer))
  })

  effect("discard and resume endpoints drive a suspended execution", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value))
    return Effect.gen(function*() {
      const api = yield* client
      yield* api.flows["Proxy/SuspendsDiscard"]({
        payload: { payload: { id: "http-resume" }, executionId: "http-resume" }
      })
      yield* Effect.yieldNow
      const suspended = yield* Suspends.poll("http-resume")
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow: Suspends,
        executionId: "http-resume"
      })
      yield* DurableDeferred.succeed(Gate, { token, value: 3 })
      yield* api.flows["Proxy/SuspendsResume"]({ payload: { executionId: "http-resume" } })
      let result = yield* Suspends.poll("http-resume")
      for (let i = 0; i < 20 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
        yield* Effect.yieldNow
        result = yield* Suspends.poll("http-resume")
      }
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(3)
      }
    }).pipe(provide(layer))
  })
})

describe("FlowProxy.toHttpApiGroup path lowering", () => {
  it("keeps case-distinct and reserved-character tags in distinct path segments", () => {
    const CaseUpper = Flow.make("Proxy/Collide", {
      payload: { value: Schema.Number },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const caseLower = Flow.make("proxy/collide", {
      payload: { value: Schema.Number },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const group = FlowProxy.toHttpApiGroup("collide", [CaseUpper, caseLower])
    const endpoints = group.endpoints as Record<string, { readonly path: string; readonly method: string }>

    expect(Object.keys(endpoints).sort()).toEqual([
      "Proxy/Collide",
      "Proxy/CollideDiscard",
      "Proxy/CollideResume",
      "proxy/collide",
      "proxy/collideDiscard",
      "proxy/collideResume"
    ])
    expect(endpoints["Proxy/Collide"]!.path).toMatch(/^\/flow-[0-9a-f]+$/)
    expect(endpoints["Proxy/Collide"]!.path).not.toBe(endpoints["proxy/collide"]!.path)
    expect(endpoints["Proxy/CollideDiscard"]!.path).not.toBe(endpoints["proxy/collideDiscard"]!.path)
    expect(endpoints["Proxy/CollideResume"]!.path).not.toBe(endpoints["proxy/collideResume"]!.path)
    expect(endpoints["Proxy/Collide"]!.path.slice(1)).not.toContain("/")

    const Reserved = Flow.make("Proxy/%?#/\ud83d\ude80", {
      payload: {},
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const reserved = FlowProxy.toHttpApiGroup("reserved", [Reserved])
    const reservedEndpoints = reserved.endpoints as Record<string, { readonly path: string }>
    expect(reservedEndpoints["Proxy/%?#/\ud83d\ude80"]!.path).toMatch(/^\/flow-[0-9a-f]+$/)
  })

  it("refuses operation names that suffix expansion makes ambiguous", () => {
    const Foo = Flow.make("Foo", {
      payload: {},
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const FooDiscard = Flow.make("FooDiscard", {
      payload: {},
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    expect(() => FlowProxy.toRpcGroup([Foo, FooDiscard])).toThrow(FlowProxy.FlowProxyCollision)
    expect(() => FlowProxy.toHttpApiGroup("ambiguous", [Foo, FooDiscard])).toThrow(
      FlowProxy.FlowProxyCollision
    )
  })

  it("refuses ill-formed UTF-16 tags before constructing a route", () => {
    for (const tag of ["Proxy/\ud800A", "Proxy/\ud800\uffff", "Proxy/\udc00"]) {
      const Invalid = Flow.make(tag, {
        payload: {},
        success: Schema.Void,
        body: () => Node.succeed(undefined)
      })
      expect(() => FlowProxy.toHttpApiGroup("invalid", [Invalid])).toThrow(
        FlowProxy.FlowProxyCollision
      )
    }
  })
})

describe("FlowProxyServer over a real HTTP listener", () => {
  effect("round-trips execute through a live server, with wire identity deduplication", () => {
    // Unlike `HttpApiTest`, this serves the API on a real Node listener on an
    // ephemeral port and calls it through a real fetch-backed client: the
    // payload and result cross genuine wire serialization.
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    const served = HttpRouter.serve(
      HttpApiBuilder.layer(ProxyApi).pipe(
        Layer.provide(
          FlowProxyServer.layerHttpApi(ProxyApi, "flows", flows).pipe(Layer.provideMerge(layer))
        )
      )
    ).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
    return Effect.gen(function*() {
      const client = yield* HttpApiClient.make(ProxyApi)
      const result = yield* client.flows["Proxy/Echo"]({
        payload: { payload: { value: 41 }, executionId: "wire-execute" }
      })
      expect(result).toBe(42)
      expect(calls()).toBe(1)
      // The same wire identity dedupes across a second real HTTP request.
      const repeat = yield* client.flows["Proxy/Echo"]({
        payload: { payload: { value: 41 }, executionId: "wire-execute" }
      })
      expect(repeat).toBe(42)
      expect(calls()).toBe(1)
    }).pipe(Effect.provide(served))
  })
})
