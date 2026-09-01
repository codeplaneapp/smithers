/**
 * The dumb-HTTP action-cache protocol: `GET`/`PUT`/`DELETE /ac/{keyDigest}`,
 * mirroring `remote/http/HttpCacheClient.java` in bazelbuild/bazel.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { TestClock } from "effect/testing"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as CacheStore from "../src/CacheStore.ts"
import * as RemoteCacheStore from "../src/RemoteCacheStore.ts"

const entry: CacheStore.CacheEntry = {
  keyDigest: "key-digest",
  result: { ok: true },
  meta: { tier: "sealed" },
  createdAtMs: 7,
  recordedRunId: "run-1",
  recordedEventSeq: 3
}

interface Call {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

const stubClient = (responder: (call: Call) => Response) => {
  const calls: Array<Call> = []
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const call: Call = {
        method: request.method,
        url: url.toString(),
        headers: { ...request.headers } as Record<string, string>,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
      }
      calls.push(call)
      return HttpClientResponse.fromWeb(request, responder(call))
    })
  )
  return { calls, layer: Layer.succeed(HttpClient.HttpClient)(client) }
}

const tierOf = (responder: (call: Call) => Response, options?: RemoteCacheStore.Options) => {
  const stub = stubClient(responder)
  return {
    calls: stub.calls,
    store: Effect.provide(
      RemoteCacheStore.make(options ?? { endpoint: "https://cache.example.com/" }),
      stub.layer
    )
  }
}

const errorOf = (exit: Exit.Exit<unknown, unknown>): CacheStore.CacheStoreError => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: CacheStore.CacheStoreError }).error
}

describe("lookups", () => {
  it.effect("GETs /ac/{keyDigest} and decodes the entry", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }))
      const found = yield* (Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)))
      expect(Option.getOrUndefined(found)).toEqual(entry)
      expect(tier.calls[0]!.method).toBe("GET")
      expect(tier.calls[0]!.url).toBe("https://cache.example.com/ac/key-digest")
    }))

  it.effect("sends the configured credential headers", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }), {
        endpoint: "https://cache.example.com",
        headers: { authorization: "Bearer secret" }
      })
      yield* (Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)))
      expect(tier.calls[0]!.headers["authorization"]).toBe("Bearer secret")
    }))

  it.effect("snapshots credential headers when the store is constructed", () =>
    Effect.gen(function*() {
      const headers = { authorization: "Bearer original" }
      const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }), {
        endpoint: "https://cache.example.com",
        headers
      })
      const store = yield* tier.store
      headers.authorization = "Bearer changed"
      yield* store.get(entry.keyDigest)
      expect(tier.calls[0]!.headers["authorization"]).toBe("Bearer original")
    }))

  it.effect("rejects accessor-backed headers without invoking them", () =>
    Effect.gen(function*() {
      let reads = 0
      const headers = Object.defineProperty({}, "authorization", {
        enumerable: true,
        get: () => {
          reads++
          return "Bearer secret"
        }
      }) as Record<string, string>
      const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }), {
        endpoint: "https://cache.example.com",
        headers
      })
      const exit = yield* Effect.exit(tier.store)
      expect(errorOf(exit).code).toBe("invalid_cache")
      expect(reads).toBe(0)
      expect(tier.calls).toEqual([])
    }))

  it.effect("carries the recorded provenance fence as query parameters", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }))
      yield* (
        Effect.flatMap(
          tier.store,
          (store) => store.get(entry.keyDigest, { recordedBy: { runId: "run-1", eventSeq: 3 } })
        )
      )
      expect(tier.calls[0]!.url).toContain("recordedRunId=run-1")
      expect(tier.calls[0]!.url).toContain("recordedEventSeq=3")
    }))

  it.effect("reports a miss on 404", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 404 }))
      const found = yield* (Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)))
      expect(Option.isNone(found)).toBe(true)
    }))

  it.effect("refuses an empty key without a round trip", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 200 }))
      const exit = yield* (Effect.flatMap(tier.store, (store) => store.get("")).pipe(Effect.exit))
      expect(errorOf(exit).code).toBe("invalid_cache")
      expect(tier.calls).toEqual([])
    }))

  it.effect("refuses every path-escaping or ill-formed key before HTTP", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 204 }))
      const store = yield* tier.store
      const malformed = [
        ".",
        "..",
        "a/b",
        "a%2fb",
        "line\nbreak",
        "\ud800",
        "x".repeat(CacheStore.maximumKeyDigestLength + 1)
      ]
      const exits = yield* Effect.forEach(malformed, (key) =>
        Effect.all([store.get(key), store.evict(key)]).pipe(Effect.exit))
      expect(exits.every(Exit.isFailure)).toBe(true)
      expect(tier.calls).toEqual([])
    }))

  it.effect("enforces maxAgeMs at the exact remote boundary", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(JSON.stringify({ ...entry, createdAtMs: 0 }), { status: 200 }))
      const store = yield* tier.store
      yield* TestClock.adjust("1 second")
      expect(Option.isSome(yield* store.get(entry.keyDigest, { maxAgeMs: 1_000 }))).toBe(true)
      yield* TestClock.adjust("1 millis")
      expect(Option.isNone(yield* store.get(entry.keyDigest, { maxAgeMs: 1_000 }))).toBe(true)
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("rejects every invalid remote age before even a 404 request", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 404 }))
      const store = yield* tier.store
      const invalid = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]
      const exits = yield* Effect.forEach(invalid, (maxAgeMs) =>
        store.get(entry.keyDigest, { maxAgeMs }).pipe(Effect.exit))
      expect(exits.every(Exit.isFailure)).toBe(true)
      expect(tier.calls).toEqual([])
    }))

  it.effect("fails on a non-2xx answer", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 500 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("persistence_failed")
    }))

  it.effect("fails when the transport refuses", () =>
    Effect.gen(function*() {
      const client = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("ECONNREFUSED") })
          })
        )
      )
      const store = Effect.provide(
        RemoteCacheStore.make({ endpoint: "https://cache.example.com" }),
        Layer.succeed(HttpClient.HttpClient)(client)
      )
      const exit = yield* (
        Effect.flatMap(store, (tier) => tier.get(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("persistence_failed")
    }))

  it.effect("fails on a body that is not JSON", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response("not json", { status: 200 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("persistence_failed")
    }))

  it.effect("fails on JSON that is not a cache entry", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(JSON.stringify({ nope: 1 }), { status: 200 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("decode_failed")
    }))

  it.effect("bounds declared and chunked response bodies before decoding", () =>
    Effect.gen(function*() {
      const declared = tierOf(
        () => new Response("{}", { status: 200, headers: { "content-length": "11" } }),
        { endpoint: "https://cache.example.com", maxResponseBytes: 10 }
      )
      const chunked = tierOf(
        () => new Response("x".repeat(11), { status: 200 }),
        { endpoint: "https://cache.example.com", maxResponseBytes: 10 }
      )
      const malformed = tierOf(
        () => new Response("{}", { status: 200, headers: { "content-length": "unknown" } }),
        { endpoint: "https://cache.example.com", maxResponseBytes: 10 }
      )
      const within = tierOf(
        () =>
          new Response(JSON.stringify(entry), {
            status: 200,
            headers: { "content-length": String(JSON.stringify(entry).length) }
          }),
        { endpoint: "https://cache.example.com", maxResponseBytes: 1_000 }
      )
      const exits = yield* Effect.forEach([declared, chunked, malformed], (tier) =>
        Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit))
      expect(exits.map((exit) =>
        errorOf(exit).code
      )).toEqual([
        "persistence_failed",
        "persistence_failed",
        "persistence_failed"
      ])
      expect(Option.isSome(yield* Effect.flatMap(within.store, (store) => store.get(entry.keyDigest)))).toBe(true)
    }))

  it.effect("rejects invalid UTF-8 and a failing response stream", () =>
    Effect.gen(function*() {
      const invalidUtf8 = tierOf(
        () => new Response(new Uint8Array([0xff]), { status: 200 }),
        { endpoint: "https://cache.example.com", maxResponseBytes: 10 }
      )
      const failedStream = tierOf(
        () =>
          new Response(new ReadableStream({ start: (controller) => controller.error(new Error("stream")) }), {
            status: 200
          }),
        { endpoint: "https://cache.example.com", maxResponseBytes: 10 }
      )
      for (const tier of [invalidUtf8, failedStream]) {
        const exit = yield* Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
        expect(errorOf(exit).code).toBe("persistence_failed")
      }
    }))

  it.effect("times out both a stalled request and a stalled response body", () => {
    const stalledRequest = HttpClient.make(() => Effect.never)
    const stalledBody = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(new ReadableStream({ start: () => undefined }), { status: 200 })
      ))
    )
    const runTimeout = (client: HttpClient.HttpClient) =>
      Effect.gen(function*() {
        const store = yield* RemoteCacheStore.make({
          endpoint: "https://cache.example.com",
          requestTimeout: "1 millis"
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)))
        const fiber = yield* store.get(entry.keyDigest).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("2 millis")
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

    return Effect.gen(function*() {
      for (const client of [stalledRequest, stalledBody]) {
        const exit = yield* runTimeout(client)
        expect(errorOf(exit).code).toBe("persistence_failed")
      }
    })
  })

  it.effect("spends one deadline across the request and the response body", () =>
    Effect.gen(function*() {
      // Headers arrive after six tenths of the budget and the body never
      // completes. The deadline is the operation's, so the caller is refused at
      // the value it configured rather than at nearly twice it.
      const client = HttpClient.make((request) =>
        Effect.as(
          Effect.sleep("6 millis"),
          HttpClientResponse.fromWeb(
            request,
            new Response(new ReadableStream({ start: () => undefined }), { status: 200 })
          )
        )
      )
      const store = yield* RemoteCacheStore.make({
        endpoint: "https://cache.example.com",
        requestTimeout: "10 millis"
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)))
      const fiber = yield* store.get(entry.keyDigest).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 millis")
      const exit = fiber.pollUnsafe()
      expect(exit === undefined ? "still running" : errorOf(exit).code).toBe("persistence_failed")
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("accepts an entry recorded under different provenance as the tier's head", () =>
    Effect.gen(function*() {
      // A conforming tier answers a fenced lookup with its head when it holds
      // no row for that provenance, exactly as the SQL tier does, and nothing
      // on the wire separates that from a tier that ignored the parameters.
      const head = { ...entry, recordedRunId: "run-9", recordedEventSeq: 41 }
      const tier = tierOf(() => new Response(JSON.stringify(head), { status: 200 }))
      const found = yield* Effect.flatMap(
        tier.store,
        (store) => store.get(entry.keyDigest, { recordedBy: { runId: "run-1", eventSeq: 3 } })
      )
      expect(Option.getOrThrow(found)).toEqual(head)
    }))

  it.effect("refuses an entry recorded under a different key", () =>
    Effect.gen(function*() {
      // A tier that answers a lookup with someone else's entry would hand the
      // caller a result under the wrong key — the one thing content addressing
      // must never allow.
      const tier = tierOf(() => new Response(JSON.stringify({ ...entry, keyDigest: "other" }), { status: 200 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("decode_failed")
      expect(errorOf(exit).message).toContain("other")
    }))
})

describe("publications", () => {
  it.effect("PUTs the entry and reports Inserted on 201", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 201 }))
      expect(yield* (Effect.flatMap(tier.store, (store) => store.put(entry))))
        .toEqual({ _tag: "Inserted" })
      expect(tier.calls[0]!.method).toBe("PUT")
      expect(JSON.parse(tier.calls[0]!.body)).toEqual(entry)
      expect(tier.calls[0]!.body).toBe(
        "{\"createdAtMs\":7,\"keyDigest\":\"key-digest\",\"meta\":{\"tier\":\"sealed\"},\"recordedEventSeq\":3,\"recordedRunId\":\"run-1\",\"result\":{\"ok\":true}}"
      )
    }))

  it.effect("reports ExistingSame on any other 2xx", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 200 }))
      expect(yield* (Effect.flatMap(tier.store, (store) => store.put(entry))))
        .toEqual({ _tag: "ExistingSame" })
    }))

  it.effect("reports Conflict on 409", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 409 }))
      expect(yield* (Effect.flatMap(tier.store, (store) => store.put(entry))))
        .toEqual({ _tag: "Conflict" })
    }))

  it.effect("fails on any other status", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 500 }))
      const exit = yield* (Effect.flatMap(tier.store, (store) => store.put(entry)).pipe(Effect.exit))
      expect(errorOf(exit).code).toBe("persistence_failed")
    }))

  it.effect("refuses an entry that violates the persistence contract", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 201 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.put({ ...entry, createdAtMs: -1 })).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("invalid_cache")
      expect(tier.calls).toEqual([])
    }))

  it.effect("refuses a result or meta that has no JSON form, without a request or a defect", () =>
    Effect.gen(function*() {
      const cyclic: Record<string, unknown> = { name: "cycle" }
      cyclic["self"] = cyclic
      const malformed: ReadonlyArray<CacheStore.CacheEntry> = [
        { ...entry, result: undefined },
        { ...entry, result: BigInt(1) },
        { ...entry, result: cyclic },
        { ...entry, meta: undefined },
        { ...entry, meta: BigInt(1) },
        { ...entry, meta: cyclic }
      ]
      const tier = tierOf(() => new Response(null, { status: 201 }))
      const exits = yield* (
        Effect.forEach(
          malformed,
          (candidate) => Effect.flatMap(tier.store, (store) => store.put(candidate)).pipe(Effect.exit)
        )
      )

      // `CacheStore.put` already holds this line; the shared tier is the same
      // poisoning boundary and must not differ. A defect (`Die`) is the specific
      // outcome being ruled out: it escapes the typed error channel entirely.
      expect(exits.map((exit) => (Exit.isFailure(exit) ? exit.cause.reasons[0]!._tag : "Success"))).toEqual(
        malformed.map(() => "Fail")
      )
      expect(exits.map((exit) => errorOf(exit).code)).toEqual(malformed.map(() => "invalid_cache"))
      expect(tier.calls).toEqual([])
    }))

  it.effect("refuses an encoded entry larger than the remote wire bound", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 201 }))
      const oversized = {
        ...entry,
        result: "x".repeat(CacheStore.maximumJsonBytes - 2)
      }
      const exit = yield* Effect.flatMap(tier.store, (store) => store.put(oversized)).pipe(Effect.exit)
      expect(errorOf(exit).code).toBe("invalid_cache")
      expect(tier.calls).toEqual([])
    }))
})

describe("configuration", () => {
  const rejects = (options: RemoteCacheStore.Options) =>
    Effect.gen(function*() {
      const stub = stubClient(() => new Response(null))
      const exit = yield* Effect.exit(
        RemoteCacheStore.make(options).pipe(Effect.provide(stub.layer))
      )
      expect(errorOf(exit).code).toBe("invalid_cache")
      expect(stub.calls).toEqual([])
    })

  it.effect.each([
    null,
    {},
    { endpoint: 1 },
    { endpoint: "not a url" },
    { endpoint: "http://cache.example.com" },
    { endpoint: "ftp://cache.example.com" },
    { endpoint: "https://user@cache.example.com" },
    { endpoint: "https://cache.example.com?q=1" },
    { endpoint: "https://cache.example.com#fragment" },
    { endpoint: " https://cache.example.com" },
    { endpoint: `https://cache.example.com/${"x".repeat(16 * 1024)}` },
    { endpoint: "https://cache.example.com/\ud800" },
    { endpoint: "https://cache.example.com/\udc00" },
    { endpoint: "https://cache.example.com", unknown: true },
    { endpoint: "https://cache.example.com", requestTimeout: "0 millis" },
    { endpoint: "https://cache.example.com", requestTimeout: Symbol("bad") },
    {
      endpoint: "https://cache.example.com",
      requestTimeout: new Proxy({}, {
        get: () => {
          throw new Error("hostile")
        }
      })
    },
    { endpoint: "https://cache.example.com", maxResponseBytes: 0 },
    { endpoint: "https://cache.example.com", maxResponseBytes: 1.5 },
    { endpoint: "https://cache.example.com", maxResponseBytes: RemoteCacheStore.maximumEntryBytes + 1 },
    { endpoint: "https://cache.example.com", headers: null },
    { endpoint: "https://cache.example.com", headers: new Date() },
    { endpoint: "https://cache.example.com", headers: { "bad header": "value" } },
    { endpoint: "https://cache.example.com", headers: { authorization: "line\nbreak" } },
    { endpoint: "https://cache.example.com", headers: { authorization: 1 } }
  ] as ReadonlyArray<unknown>)(
    "rejects invalid options %# before I/O",
    (options) => rejects(options as RemoteCacheStore.Options)
  )

  it.effect("rejects symbol and accessor option fields", () =>
    Effect.gen(function*() {
      const symbol = { endpoint: "https://cache.example.com", [Symbol("x")]: true }
      let reads = 0
      const accessor = Object.defineProperty({}, "endpoint", {
        enumerable: true,
        get: () => {
          reads++
          return "https://cache.example.com"
        }
      })
      yield* rejects(symbol as RemoteCacheStore.Options)
      yield* rejects(accessor as RemoteCacheStore.Options)
      expect(reads).toBe(0)
    }))

  it.effect("rejects symbol-bearing header records", () =>
    Effect.gen(function*() {
      const headers = Object.defineProperty({}, Symbol("authorization"), {
        value: "Bearer secret",
        enumerable: true
      })
      yield* rejects({ endpoint: "https://cache.example.com", headers } as RemoteCacheStore.Options)
    }))

  it.effect("accepts HTTPS and loopback HTTP roots with path prefixes", () =>
    Effect.gen(function*() {
      for (
        const endpoint of [
          "https://cache.example.com/base/",
          "https://cache.example.com/base/😀",
          "http://127.0.0.1:1234/base",
          "http://api.localhost:1234/base",
          "http://[::1]:1234/base"
        ]
      ) {
        const tier = tierOf(() => new Response(null, { status: 404 }), { endpoint })
        const store = yield* tier.store
        yield* store.get(entry.keyDigest)
        const root = new URL(endpoint).pathname.replace(/\/+$/, "")
        expect(new URL(tier.calls[0]!.url).pathname).toBe(`${root}/ac/key-digest`)
      }
    }))
})

describe("evictions", () => {
  it.effect("DELETEs /ac/{keyDigest}", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 204 }))
      expect(yield* (Effect.flatMap(tier.store, (store) => store.evict(entry.keyDigest)))).toBe(true)
      expect(tier.calls[0]!.method).toBe("DELETE")
      expect(tier.calls[0]!.url).toBe("https://cache.example.com/ac/key-digest")
    }))

  it.effect("carries the provenance fence as query parameters", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 200 }))
      yield* (
        Effect.flatMap(
          tier.store,
          (store) => store.evict(entry.keyDigest, { ifRecordedBy: { runId: "run-1", eventSeq: 3 } })
        )
      )
      expect(tier.calls[0]!.url).toContain("recordedRunId=run-1")
      expect(tier.calls[0]!.url).toContain("recordedEventSeq=3")
    }))

  it.effect("reports false on 404", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 404 }))
      expect(yield* (Effect.flatMap(tier.store, (store) => store.evict(entry.keyDigest)))).toBe(false)
    }))

  it.effect("fails on any other status", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 500 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.evict(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("persistence_failed")
    }))

  it.effect("refuses an empty key without issuing a DELETE to the /ac/ root", () =>
    Effect.gen(function*() {
      // `get` already refuses an empty key without a round trip; `evict` is the
      // more dangerous half, because a malformed key targets a collection-like
      // endpoint with a destructive verb.
      const tier = tierOf(() => new Response(null, { status: 204 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.evict("")).pipe(Effect.exit)
      )
      // The request log is the load-bearing assertion: a `DELETE` to
      // `https://cache.example.com/ac/`, the collection root, is the outcome
      // being ruled out.
      expect(tier.calls).toEqual([])
      expect(Exit.isFailure(exit)).toBe(true)
      expect(errorOf(exit).code).toBe("invalid_cache")
    }))

  it.effect("refuses a malformed provenance fence without issuing a DELETE", () =>
    Effect.gen(function*() {
      // The fence rides to the server as query parameters, so a fence the SQL
      // tier would reject must not become a request either — the two tiers
      // implement one contract.
      const tier = tierOf(() => new Response(null, { status: 204 }))
      const exit = yield* (
        Effect.flatMap(
          tier.store,
          (store) => store.evict(entry.keyDigest, { ifRecordedBy: { runId: "", eventSeq: -1 } })
        ).pipe(Effect.exit)
      )
      expect(tier.calls).toEqual([])
      expect(errorOf(exit).code).toBe("invalid_cache")
    }))
})

describe("retention", () => {
  it.effect("never sweeps the shared tier and issues no request", () =>
    Effect.gen(function*() {
      // Retention on the shared tier belongs to the server: a client that
      // deleted rows there would drop entries other machines still replay
      // from. The sweep therefore reports nothing removed rather than
      // reaching across.
      const tier = tierOf(() => new Response(null, { status: 204 }))
      const swept = yield* Effect.flatMap(tier.store, (store) => store.sweepExpired(1000))
      expect(swept).toBe(0)
      expect(tier.calls).toEqual([])
    }))

  it.effect("still reports a bound no row could satisfy", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 204 }))
      const exit = yield* Effect.exit(Effect.flatMap(tier.store, (store) => store.sweepExpired(-1)))
      expect(errorOf(exit).code).toBe("invalid_cache")
    }))
})

describe("layer", () => {
  it.effect("provides the remote store under the CacheStore tag", () =>
    Effect.gen(function*() {
      const stub = stubClient(() => new Response(null, { status: 404 }))
      const found = yield* (
        Effect.flatMap(CacheStore.CacheStore, (store) => store.get(entry.keyDigest)).pipe(
          Effect.provide(
            RemoteCacheStore.layer({ endpoint: "https://cache.example.com" }).pipe(Layer.provide(stub.layer))
          )
        )
      )
      expect(Option.isNone(found)).toBe(true)
    }))
})
