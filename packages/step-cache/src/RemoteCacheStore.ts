/**
 * The shared step-result tier: a {@link CacheStore.Service} spoken over HTTP.
 *
 * This is Bazel's *action cache* half of the dumb-HTTP remote cache protocol
 * (`reference/bazel/.../remote/http/HttpCacheClient.java`): "Action cache blobs
 * are stored under the path `/ac/base16-key`", written with `PUT` and read
 * with `GET`. The blob we carry is the JSON encoding of a
 * {@link CacheStore.CacheEntry} rather than a REAPI `ActionResult` proto,
 * because our recorded result and its journal provenance are the thing being
 * shared.
 *
 * The load-bearing protocol constraint lives with the *caller*, not here:
 * every artifact an entry references must be durable in the shared artifact
 * tier before the entry is `put`. Bazel states it at
 * `UploadManifest.java:630-633` — "action results may fail to validate
 * server-side if they are accessed before all blobs they refer to are
 * present". See `docs/specs/Concepts/Remote Cache.md`.
 *
 * The endpoint and its credentials arrive as layer construction options. They
 * are a capability, never an input: they are not hashed into a step key and
 * never journaled (`docs/specs/Specs/Input.md`).
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as CacheStore from "./CacheStore.ts"

/**
 * How to reach the shared step-result tier.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The cache root, e.g. `https://cache.example.com`. `/ac/{keyDigest}` is
   * resolved beneath it. A trailing slash is ignored.
   */
  readonly endpoint: string
  /**
   * Headers sent with every request. This is the credential seam, and it is
   * deliberately construction-time — see the module doc.
   */
  readonly headers?: Record<string, string> | undefined
}

const transportFailure = (operation: string, cause: unknown): CacheStore.CacheStoreError =>
  new CacheStore.CacheStoreError({
    code: "persistence_failed",
    message: `the remote cache tier refused ${operation}`,
    cause
  })

const unexpectedStatus = (operation: string, status: number): CacheStore.CacheStoreError =>
  new CacheStore.CacheStoreError({
    code: "persistence_failed",
    message: `the remote cache tier answered ${operation} with HTTP ${status}`
  })

const isOk = (status: number): boolean => status >= 200 && status < 300

/**
 * Builds a remote cache store over Effect's `HttpClient`.
 *
 * Status mapping for `put`, which is the only operation with a three-way
 * outcome: `201 Created` is `Inserted`, any other 2xx is `ExistingSame` (the
 * server already held an identical entry), and `409 Conflict` is `Conflict`
 * (it held a *different* one). That is the smallest vocabulary that preserves
 * `CacheStore`'s first-writer-wins contract over dumb HTTP.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<CacheStore.Service, never, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const base = options.endpoint.replace(/\/+$/, "")
    const headers = options.headers
    const authorize = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest =>
      headers === undefined ? request : HttpClientRequest.setHeaders(request, headers)
    const acUrl = (keyDigest: string) => `${base}/ac/${encodeURIComponent(keyDigest)}`
    const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
      client.execute(authorize(request)).pipe(Effect.mapError((cause) => transportFailure(operation, cause)))

    const get: CacheStore.Service["get"] = Effect.fn("RemoteCacheStore.get")((keyDigest, getOptions) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ keyDigest })
        yield* CacheStore.validateKey(keyDigest)
        yield* CacheStore.validateFence(getOptions?.recordedBy)
        const recordedBy = getOptions?.recordedBy
        const lookup = HttpClientRequest.get(acUrl(keyDigest))
        const request = recordedBy === undefined
          ? lookup
          : HttpClientRequest.setUrlParams(lookup, {
            recordedRunId: recordedBy.runId,
            recordedEventSeq: String(recordedBy.eventSeq)
          })
        const response = yield* send("a lookup", request)
        if (response.status === 404) return Option.none()
        if (!isOk(response.status)) return yield* Effect.fail(unexpectedStatus("a lookup", response.status))
        const body = yield* response.json.pipe(
          Effect.mapError((cause) => transportFailure("a lookup body", cause))
        )
        const entry = yield* Schema.decodeUnknownEffect(CacheStore.CacheEntry)(body).pipe(
          Effect.mapError((cause) =>
            new CacheStore.CacheStoreError({
              code: "decode_failed",
              message: "the remote cache tier returned an entry that is not a CacheEntry",
              cause
            })
          )
        )
        // A tier that answers a lookup with someone else's entry would hand
        // the caller a result under the wrong key — the one thing content
        // addressing must never allow.
        if (entry.keyDigest !== keyDigest) {
          return yield* Effect.fail(
            new CacheStore.CacheStoreError({
              code: "decode_failed",
              message: `the remote cache tier answered ${keyDigest} with an entry for ${entry.keyDigest}`
            })
          )
        }
        return Option.some(entry)
      })
    )

    const put: CacheStore.Service["put"] = Effect.fn("RemoteCacheStore.put")((entry: CacheStore.CacheEntry) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ keyDigest: entry.keyDigest })
        const encoded = yield* Schema.encodeEffect(CacheStore.CacheEntry)(entry).pipe(
          Effect.mapError((cause) =>
            new CacheStore.CacheStoreError({
              code: "invalid_cache",
              message: "cache entry violates the persistence contract",
              cause
            })
          )
        )
        // The wire bytes are the canonical form itself. Besides refusing
        // values JSON cannot represent, this gives structurally equal entries
        // identical bytes on every host regardless of object insertion order.
        // Validate the two unknown fields before encoding the struct because
        // a struct encoder may omit an `undefined` member.
        yield* CacheStore.encodeCanonical(entry.result, "result")
        yield* CacheStore.encodeCanonical(entry.meta, "meta")
        const body = yield* CacheStore.encodeCanonical(encoded, "cache entry")
        const response = yield* send(
          "a publication",
          HttpClientRequest.put(acUrl(entry.keyDigest)).pipe(
            HttpClientRequest.bodyText(body, "application/json")
          )
        )
        if (response.status === 409) return { _tag: "Conflict" } as const
        if (!isOk(response.status)) return yield* Effect.fail(unexpectedStatus("a publication", response.status))
        return response.status === 201 ? { _tag: "Inserted" } as const : { _tag: "ExistingSame" } as const
      })
    )

    const evict: CacheStore.Service["evict"] = Effect.fn("RemoteCacheStore.evict")((keyDigest, evictOptions) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ keyDigest })
        // An empty key would aim the protocol's one destructive verb at the
        // `/ac/` collection root instead of a single entry, so the preflight
        // that guards `get` guards the DELETE all the more.
        yield* CacheStore.validateKey(keyDigest)
        yield* CacheStore.validateFence(evictOptions?.ifRecordedBy)
        const fenced = evictOptions?.ifRecordedBy
        // The provenance fence rides in the request the same way it rides in
        // the SQL `DELETE`: the server compares before deleting, so a fresher
        // entry recorded by another machine between this caller's lookup and
        // its eviction is never dropped with the poison.
        const deletion = HttpClientRequest.make("DELETE")(acUrl(keyDigest))
        const request = fenced === undefined
          ? deletion
          : HttpClientRequest.setUrlParams(deletion, {
            recordedRunId: fenced.runId,
            recordedEventSeq: String(fenced.eventSeq)
          })
        const response = yield* send("an eviction", request)
        if (response.status === 404) return false
        if (!isOk(response.status)) return yield* Effect.fail(unexpectedStatus("an eviction", response.status))
        return true
      })
    )

    return { get, put, evict }
  })

/**
 * Provides a remote cache store as the `CacheStore` tag.
 *
 * Composing this alone makes every step-cache lookup a network round trip and
 * leaves this machine with no durable record. The intended production shape is
 * `CombinedCacheStore`, with this as its remote tier.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<CacheStore.CacheStore, never, HttpClient.HttpClient> =>
  Layer.effect(CacheStore.CacheStore)(make(options))
