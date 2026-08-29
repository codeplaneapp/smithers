import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import { PermissionDenied } from "@smthrs/capability/Permission"
import { Effect, Fiber, Option } from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientErrorModule from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { GrantStore, type Service } from "../src/GrantStore.ts"
import * as HttpClient from "../src/HttpClient.ts"

const itEffect = <E>(name: string, effect: () => Effect.Effect<void, E>) => it.effect(name, () => effect())

const store = (checks: Array<Capability.Capability>, allowed = true) =>
  GrantStore.of({
    check: (capability) => {
      checks.push(capability)
      return allowed
        ? Effect.void
        : Effect.fail(new PermissionDenied({ code: "permission_denied", capability, reason: "denied by test" }))
    },
    reply: () => Effect.die("not used by HTTP decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const host = (calls: Array<string>) =>
  EffectHttpClient.make((request) =>
    Effect.sync(() => {
      calls.push(request.url)
      return { status: 200, headers: {}, request } as HttpClientResponse.HttpClientResponse
    })
  )

/** A host client that bounces `first.test` once to `second.test`. */
const redirecting = (calls: Array<string>) =>
  EffectHttpClient.make((request) =>
    Effect.sync(() => {
      calls.push(request.url)
      return (request.url.includes("first")
        ? { status: 302, headers: { location: "https://second.test/next" }, request }
        : { status: 200, headers: {}, request }) as HttpClientResponse.HttpClientResponse
    })
  )

/** The guarded client, decorating a host client in place under Effect's tag. */
const protectedClient = <A, E>(
  effect: Effect.Effect<A, E, EffectHttpClient.HttpClient>,
  client: EffectHttpClient.HttpClient,
  grants: Service
) =>
  effect.pipe(
    Effect.provide(HttpClient.layer),
    Effect.provideService(EffectHttpClient.HttpClient, client),
    Effect.provideService(GrantStore, grants)
  )

const denial = (error: unknown) => Option.getOrThrow(HttpClient.fromHttpClientError(error as never))

describe("HttpClient", () => {
  itEffect("maps GET and HEAD to net:get and every other method to net:post", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"] as const
    return Effect.forEach(methods, (method) =>
      Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        yield* client.execute(HttpClientRequest.make(method)("https://example.test/path"))
      })).pipe(
        Effect.asVoid,
        (effect) => protectedClient(effect, host(calls), store(checks)),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(checks.map((capability) => capability.action)).toEqual([
              "net:get",
              "net:get",
              "net:post",
              "net:post",
              "net:post",
              "net:post",
              "net:post",
              "net:post"
            ])
            expect(calls).toHaveLength(methods.length)
          })
        )
      )
  })

  itEffect("normalizes the URL host to lowercase and retains a nondefault port", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      yield* client.get("https://API.Example.Test:8443/v1")
      expect(checks).toEqual([{ action: "net:get", resource: "api.example.test:8443" }])
    }).pipe((effect) => protectedClient(effect, host(calls), store(checks)))
  })

  itEffect("maps a model call to model:call without granting general net:post", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      yield* client.execute(HttpClientRequest.post("https://API.Example.Test/v1/messages")).pipe(
        HttpClient.withModelCall("anthropic/claude")
      )
      expect(checks).toEqual([
        { action: "model:call", resource: "api.example.test/anthropic/claude" }
      ])
      expect(calls).toEqual(["https://API.Example.Test/v1/messages"])
    }).pipe((effect) => protectedClient(effect, host(calls), store(checks)))
  })

  itEffect("fails a relative or unparsable URL with a typed denial before the host client", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const failure = yield* Effect.flip(client.get("/relative"))
      expect(denial(failure)).toBeInstanceOf(PermissionDenied)
      expect(checks).toEqual([])
      expect(calls).toEqual([])
    }).pipe((effect) => protectedClient(effect, host(calls), store(checks)))
  })

  itEffect("does not delegate a denied request", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const failure = yield* Effect.flip(client.post("https://example.test/write"))
      expect(failure).toMatchObject({ _tag: "HttpClientError", reason: { _tag: "TransportError" } })
      expect(denial(failure)).toMatchObject({
        code: "permission_denied",
        capability: { action: "net:post", resource: "example.test" },
        reason: "denied by test"
      })
      expect(checks).toEqual([{ action: "net:post", resource: "example.test" }])
      expect(calls).toEqual([])
    }).pipe((effect) => protectedClient(effect, host(calls), store(checks, false)))
  })

  itEffect("rechecks a redirect target, because the guard sits under the redirect loop", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      yield* client.get("https://first.test/start")
      expect(checks).toEqual([
        { action: "net:get", resource: "first.test" },
        { action: "net:get", resource: "second.test" }
      ])
      expect(calls).toEqual(["https://first.test/start", "https://second.test/next"])
    }).pipe((effect) => protectedClient(effect, redirecting(calls), store(checks)))
  })

  itEffect("denies a redirect to an unauthorized host after allowing the first hop", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    const onlyFirst = GrantStore.of({
      check: (capability) => {
        checks.push(capability)
        return capability.resource === "first.test"
          ? Effect.void
          : Effect.fail(new PermissionDenied({ code: "permission_denied", capability, reason: "off-limits host" }))
      },
      reply: () => Effect.die("not used by HTTP decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const failure = yield* Effect.flip(client.get("https://first.test/start"))
      expect(denial(failure)).toMatchObject({
        capability: { action: "net:get", resource: "second.test" },
        reason: "off-limits host"
      })
      expect(checks.map((capability) => capability.resource)).toEqual(["first.test", "second.test"])
      // The second hop never left the host: only the authorized URL was fetched.
      expect(calls).toEqual(["https://first.test/start"])
    }).pipe((effect) => protectedClient(effect, redirecting(calls), onlyFirst))
  })

  itEffect("leaves a native transport failure untouched", () => {
    const checks: Array<Capability.Capability> = []
    const failing = EffectHttpClient.make((request) =>
      Effect.fail(
        new HttpClientErrorModule.HttpClientError({
          reason: new HttpClientErrorModule.TransportError({ request, cause: new Error("socket reset") })
        })
      )
    )
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const failure = yield* Effect.flip(client.get("https://example.test/health"))
      expect(failure).toMatchObject({ _tag: "HttpClientError", reason: { _tag: "TransportError" } })
      expect(HttpClient.fromHttpClientError(failure)).toEqual(Option.none())
      expect(String(failure.reason.cause)).toContain("socket reset")
    }).pipe((effect) => protectedClient(effect, failing, store(checks)))
  })

  itEffect("stays interruptible through the guard", () => {
    const checks: Array<Capability.Capability> = []
    const never = EffectHttpClient.make(() => Effect.never)
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const fiber = yield* Effect.forkChild(client.get("https://example.test/slow"), { startImmediately: true })
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(checks).toEqual([{ action: "net:get", resource: "example.test" }])
    }).pipe((effect) => protectedClient(effect, never, store(checks)))
  })

  itEffect("answers the stub with an unavailable-host transport failure", () =>
    Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const failure = yield* Effect.flip(client.get("https://example.test/path"))
      expect(String(failure.reason.cause)).toContain("HTTP is unavailable on this host")
    }).pipe(Effect.provide(HttpClient.layerNoop())))

  it("re-exports Effect's own tag rather than declaring a second one", () => {
    expect(HttpClient.HttpClient).toBe(EffectHttpClient.HttpClient)
    expect(HttpClient.make).toBe(EffectHttpClient.make)
  })
})
