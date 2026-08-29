/**
 * The dumb-HTTP CAS protocol: `GET`/`PUT`/`HEAD /cas/{digest}` and
 * `POST /cas/findMissing`, mirroring
 * `reference/bazel/.../remote/http/HttpCacheClient.java`.
 */
import { describe, expect, it } from "@effect/vitest"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as RemoteArtifacts from "../src/RemoteArtifacts.ts"
import { bytes, sha256, text, withCrypto } from "./Crypto.ts"

const artifact = "a shared artifact"
const digest = sha256(bytes(artifact))

interface Call {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** Records every request and answers it from a caller-supplied responder. */
const stubClient = (
  responder: (call: Call) => Response | Promise<Response>
) => {
  const calls: Array<Call> = []
  const client = HttpClient.make((request, url) =>
    Effect.promise(async () => {
      const body = request.body._tag === "Uint8Array" ? text(request.body.body)! : ""
      const call: Call = {
        method: request.method,
        url: url.toString(),
        headers: { ...request.headers } as Record<string, string>,
        body
      }
      calls.push(call)
      return HttpClientResponse.fromWeb(request, await responder(call))
    })
  )
  return { calls, layer: Layer.succeed(HttpClient.HttpClient)(client) }
}

const remote = (
  responder: (call: Call) => Response | Promise<Response>,
  options?: Omit<RemoteArtifacts.Options, "endpoint"> & { readonly endpoint?: string }
) => {
  const stub = stubClient(responder)
  return {
    calls: stub.calls,
    store: Effect.provide(
      RemoteArtifacts.make({ endpoint: options?.endpoint ?? "https://cache.example.com/", ...options }),
      stub.layer
    )
  }
}

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: unknown }).error
}

describe("construction", () => {
  it.effect.each([NaN, Infinity, -1, 1.5])(
    "refuses invalid maxDownloadBytes %s",
    (maxDownloadBytes) =>
      Effect.gen(function*() {
        const tier = remote(() => new Response(null, { status: 200 }), { maxDownloadBytes })
        const exit = yield* tier.store.pipe(Effect.exit)
        expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
        expect(tier.calls).toEqual([])
      })
  )

  it.effect.each(["not a duration", "Infinity", "0 millis", "-1 millis"])(
    "refuses invalid downloadTimeout %s",
    (downloadTimeout) =>
      Effect.gen(function*() {
        const tier = remote(() => new Response(null, { status: 200 }), {
          downloadTimeout: downloadTimeout as never
        })
        const exit = yield* tier.store.pipe(Effect.exit)
        expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
        expect(tier.calls).toEqual([])
      })
  )
})

describe("uploads", () => {
  it.effect.each([
    "http://cache.example.com",
    "https://user:secret@cache.example.com",
    "https://cache.example.com?tenant=one",
    "https://cache.example.com#fragment",
    "not a URL"
  ])("refuses unsafe endpoint %s before sending credentials", (endpoint) =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }), {
        endpoint,
        headers: { authorization: "Bearer secret" }
      })
      const exit = yield* tier.store.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(tier.calls).toEqual([])
    }))

  it.effect("PUTs the bytes to /cas/{digest} and returns the measured address", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 201 }))
      const published = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))))
      expect(published).toBe(digest)
      expect(tier.calls[0]!.method).toBe("PUT")
      // The trailing slash on the configured endpoint is ignored.
      expect(tier.calls[0]!.url).toBe(`https://cache.example.com/cas/${digest}`)
      expect(tier.calls[0]!.body).toBe(artifact)
    }))

  it.effect("sends the configured credential headers", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }), { headers: { authorization: "Bearer secret" } })
      yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))))
      expect(tier.calls[0]!.headers["authorization"]).toBe("Bearer secret")
    }))

  it.effect("fails on a non-2xx answer", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 500 }))
      const exit = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))).pipe(Effect.exit)
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("fails when the transport itself refuses", () =>
    Effect.gen(function*() {
      const client = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("ECONNREFUSED") })
          })
        )
      )
      const store = Effect.provide(
        RemoteArtifacts.make({ endpoint: "https://cache.example.com" }),
        Layer.succeed(HttpClient.HttpClient)(client)
      )
      const exit = yield* withCrypto(Effect.flatMap(store, (tier) => tier.put(bytes(artifact))).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))
})

describe("downloads", () => {
  it.effect("GETs /cas/{digest} and verifies the address", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(artifact))
      expect(text(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest))))).toBe(artifact)
      expect(tier.calls[0]!.method).toBe("GET")
    }))

  it.effect("reports a typed miss on 404", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 404 }))
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactMissing)._tag).toBe("@smthrs/artifacts/ArtifactMissing")
    }))

  it.effect("refuses content that does not hash to the requested address", () =>
    Effect.gen(function*() {
      // The shared tier is the least trusted store there is: a mis-serving or
      // compromised cache must never be able to substitute content.
      const tier = remote(() => new Response("something else entirely"))
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      const failure = errorOf(exit) as ArtifactStore.ArtifactCorruption
      expect(failure._tag).toBe("@smthrs/artifacts/ArtifactCorruption")
      expect(failure.recordedDigest).toBe(digest)
    }))

  it.effect("fails on a non-2xx answer", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 503 }))
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("fails a download that exceeds its deadline instead of waiting forever", () =>
    Effect.gen(function*() {
      // Headers arrive but the body never does. The deadline covers the whole
      // exchange, so the read fails typed instead of parking forever on a tier
      // that stopped answering.
      const tier = remote(
        () => new Response(new ReadableStream({ start() {} })),
        { downloadTimeout: "50 millis" }
      )
      const request = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true })
        )
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("50 millis")
      const exit = yield* Fiber.join(request)
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("refuses a body that exceeds the size bound without buffering it whole", () =>
    Effect.gen(function*() {
      let pulls = 0
      const tier = remote(
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulls++
                controller.enqueue(new Uint8Array(1024))
              }
            })
          ),
        { maxDownloadBytes: 4096 }
      )
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
      // The endless body was abandoned one chunk past the bound, not slurped:
      // the guard runs against the stream, not against a completed buffer.
      expect(pulls).toBeLessThan(64)
    }))

  it.effect("refuses a declared oversize before reading a single body byte", () =>
    Effect.gen(function*() {
      let pulls = 0
      const tier = remote(
        () =>
          new Response(
            // A zero high-water mark keeps the stream from priming its queue at
            // construction, so a pull can only come from an actual body read.
            new ReadableStream(
              {
                pull(controller) {
                  pulls++
                  controller.enqueue(new Uint8Array(8))
                }
              },
              { highWaterMark: 0 }
            ),
            { headers: { "content-length": "1048576" } }
          ),
        { maxDownloadBytes: 1024 }
      )
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
      expect(pulls).toBe(0)
    }))

  it.effect("treats an empty 2xx body as empty content, refused by the digest check", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }))
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      const failure = errorOf(exit) as ArtifactStore.ArtifactCorruption
      expect(failure._tag).toBe("@smthrs/artifacts/ArtifactCorruption")
      expect(failure.measuredDigest).toBe(sha256(bytes("")))
    }))

  it.effect("fails when the response body cannot be read", () =>
    Effect.gen(function*() {
      const tier = remote(() =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("truncated"))
            }
          })
        )
      )
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))
})

describe("existence probes", () => {
  it.effect("HEADs /cas/{digest}", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }))
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.has(digest)))).toBe(true)
      expect(tier.calls[0]!.method).toBe("HEAD")
    }))

  it.effect("answers false on 404", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 404 }))
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.has(digest)))).toBe(false)
    }))

  it.effect("fails on any other status", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 403 }))
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.has(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))
})

describe("the batched probe", () => {
  const other = sha256(bytes("another artifact"))

  it.effect("POSTs /cas/findMissing and returns what the tier reported", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(JSON.stringify({ missing: [other] }), { status: 200 }))
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.findMissing([digest, other, other]))))
        .toEqual([other])
      expect(tier.calls[0]!.method).toBe("POST")
      expect(tier.calls[0]!.url).toBe("https://cache.example.com/cas/findMissing")
      // Duplicates never reach the wire.
      expect(JSON.parse(tier.calls[0]!.body)).toEqual({ digests: [digest, other] })
    }))

  it.effect("never asks about nothing", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 500 }))
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.findMissing([])))).toEqual([])
      expect(tier.calls).toEqual([])
    }))

  it.effect("drops digests the caller never asked about", () =>
    Effect.gen(function*() {
      // "The returned set is guaranteed to be a subset of `digests`"
      // (`MissingDigestsFinder`). A server that answered otherwise would make
      // the caller upload bytes it never probed for.
      const tier = remote(() => new Response(JSON.stringify({ missing: [other, "unrequested"] }), { status: 200 }))
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.findMissing([digest, other]))))
        .toEqual([other])
    }))

  it.effect("fails on a non-2xx answer", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 502 }))
      const exit = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.findMissing([digest])).pipe(Effect.exit)
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("fails on a body that is not JSON", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response("not json at all", { status: 200 }))
      const exit = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.findMissing([digest])).pipe(Effect.exit)
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("fails on JSON that is not a findMissing answer", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(JSON.stringify({ absent: [] }), { status: 200 }))
      const exit = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.findMissing([digest])).pipe(Effect.exit)
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))
})

describe("the address guard", () => {
  // A digest reaches a read straight out of a durable row, so it is untrusted
  // input, and here it is interpolated into a URL path. An address carrying a
  // separator or a `..` would point this client at a different resource on the
  // configured endpoint — so it is refused before any request goes out, by the
  // same guard the filesystem tier applies.
  const unusable = ["", "../ac/other-key", "sub/dir", "..", "back\\slash"]
  for (const digest of unusable) {
    it.effect(`refuses ${JSON.stringify(digest)} without a round trip`, () =>
      Effect.gen(function*() {
        const tier = remote(() => new Response(null, { status: 200 }))
        const store = yield* withCrypto(tier.store)
        const refused = (operation: Effect.Effect<unknown, unknown, Crypto.Crypto>) =>
          withCrypto(operation.pipe(Effect.exit)).pipe(
            Effect.map((exit) => (errorOf(exit) as ArtifactStore.ArtifactStoreError).code)
          )
        expect(yield* refused(store.get(digest))).toBe("invalid_digest")
        expect(yield* refused(store.has(digest))).toBe("invalid_digest")
        expect(yield* refused(store.findMissing([digest]))).toBe("invalid_digest")
        expect(tier.calls).toEqual([])
      }))
  }
})

describe("layer", () => {
  it.effect("provides the remote store under the ArtifactStore tag", () =>
    Effect.gen(function*() {
      const stub = stubClient(() => new Response(null, { status: 201 }))
      const published = yield* withCrypto(
        Effect.flatMap(ArtifactStore.ArtifactStore, (store) => store.put(bytes(artifact))).pipe(
          Effect.provide(
            RemoteArtifacts.layer({ endpoint: "https://cache.example.com" }).pipe(Layer.provide(stub.layer))
          )
        )
      )
      expect(published).toBe(digest)
    }))
})
