/**
 * The shared artifact tier: an {@link ArtifactStore.Service} spoken over HTTP.
 *
 * The wire protocol mirrors Bazel's dumb-HTTP remote cache
 * (`reference/bazel/.../remote/http/HttpCacheClient.java`), which documents it
 * as: "CAS (Content Addressable Storage) blobs are stored under the path
 * `/cas/base16-key`", uploaded with `PUT`, downloaded with `GET`. We add
 * `HEAD /cas/{digest}` for a single existence probe and
 * `POST /cas/findMissing` for the batched one, because Bazel's HTTP client has
 * no `findMissingDigests` at all — it answers "everything is missing" and
 * re-uploads — and a batched probe is the whole reason
 * `MissingDigestsFinder` exists in the gRPC client.
 *
 * Transport is Effect's own `HttpClient` tag. There is no lower transport in
 * this repository, and there does not need to be one: the kernel already
 * decorates that tag with `net:get`/`net:post` capability checks, so a remote
 * artifact fetch is permission-checked like every other egress.
 *
 * The endpoint and its credentials arrive as **layer construction options**.
 * They are a capability, never an input: they are not hashed into a step key,
 * not journaled, and not part of any recorded result — see
 * `docs/specs/Specs/Input.md` ("secrets are never input") and
 * `docs/specs/Concepts/Remote Cache.md`.
 *
 * @since 0.1.0
 */
import { Sha256 } from "@smthrs/crypto"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as ArtifactStore from "./ArtifactStore.ts"

/**
 * How to reach the shared artifact tier.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  /**
   * The cache root, e.g. `https://cache.example.com`. `/cas/{digest}` and
   * `/cas/findMissing` are resolved beneath it. A trailing slash is ignored.
   */
  readonly endpoint: string
  /**
   * Headers sent with every request — an `Authorization` bearer token, a
   * tenant header, whatever the deployment's gateway wants. This is the
   * credential seam, and it is deliberately construction-time: a credential
   * that arrived as a step input would be hashed into a step key and persisted
   * everywhere the journal goes.
   */
  readonly headers?: Record<string, string> | undefined
  /**
   * The deadline on a single download, from the request leaving to the last
   * body byte arriving. A shared tier that stops answering must fail the read
   * rather than park it forever — the combined composition treats a remote
   * failure as a miss it can live with, but it can do nothing with a read
   * that never returns. Defaults to 60 seconds, Bazel's `--remote_timeout`
   * default for the same REST protocol
   * (`reference/bazel/.../remote/options/RemoteOptions.java`: "For the REST
   * cache, this is both the connect and the read timeout").
   */
  readonly downloadTimeout?: Duration.Input | undefined
  /**
   * The largest download this client will buffer, in bytes. The body is read
   * incrementally and abandoned the moment it exceeds the bound — and refused
   * outright when `Content-Length` already declares the excess — so a
   * mis-serving or hostile cache cannot make this process buffer and hash an
   * arbitrarily large body before the digest check refuses it. Defaults to
   * 256 MiB.
   */
  readonly maxDownloadBytes?: number | undefined
}

/**
 * The default download deadline. 60 seconds is Bazel's `--remote_timeout`
 * default, governing the same dumb-HTTP cache protocol.
 */
const defaultDownloadTimeout = Duration.seconds(60)

/**
 * The default bound on a downloaded blob: 256 MiB. Artifacts are spilled step
 * values, not media libraries; a body past this size is far more likely a
 * mis-serving cache than a legitimate blob, and the dial is per-store for a
 * deployment that knows better.
 */
const defaultMaxDownloadBytes = 256 * 1024 * 1024

const transportFailure = (operation: string, cause: unknown): ArtifactStore.ArtifactStoreError =>
  new ArtifactStore.ArtifactStoreError({
    code: "transport_failed",
    message: `the remote artifact tier refused ${operation}: ${String(cause)}`,
    cause
  })

const unexpectedStatus = (operation: string, status: number): ArtifactStore.ArtifactStoreError =>
  new ArtifactStore.ArtifactStoreError({
    code: "transport_failed",
    message: `the remote artifact tier answered ${operation} with HTTP ${status}`
  })

const invalidOption = (name: string, value: unknown): ArtifactStore.ArtifactStoreError =>
  new ArtifactStore.ArtifactStoreError({
    code: "transport_failed",
    message: `invalid remote artifact option ${name}: ${String(value)}`
  })

/** The batched-probe response body. */
const FindMissingResponse = Schema.Struct({ missing: Schema.Array(Schema.String) })

/**
 * A 2xx is success, a 404 is a miss, and everything else is a transport
 * failure. Bazel's HTTP client takes the same three-way split; it is the only
 * classification a dumb-HTTP cache can support, because there is no richer
 * error envelope on the wire.
 */
const isOk = (response: HttpClientResponse.HttpClientResponse): boolean =>
  response.status >= 200 && response.status < 300

/**
 * Builds a remote artifact store over Effect's `HttpClient`.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  options: Options
): Effect.Effect<ArtifactStore.Service, ArtifactStore.ArtifactStoreError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const endpoint = yield* Effect.try({
      try: () => new URL(options.endpoint),
      catch: (cause) => transportFailure("an invalid endpoint", cause)
    })
    if (endpoint.protocol !== "https:") {
      return yield* Effect.fail(transportFailure("a non-HTTPS endpoint", options.endpoint))
    }
    if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") {
      return yield* Effect.fail(
        transportFailure("an endpoint containing credentials, a query, or a fragment", options.endpoint)
      )
    }
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "")
    const base = endpoint.toString().replace(/\/+$/, "")
    const headers = options.headers
    const authorize = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest =>
      headers === undefined ? request : HttpClientRequest.setHeaders(request, headers)
    // The address is a URL path segment, so it is refused before it is
    // interpolated and percent-encoded when it is: an address carrying a
    // separator or a `..` would otherwise point this client at a different
    // resource on the configured endpoint. `ArtifactStore.validateDigest` is
    // the same guard the filesystem tier applies to the same untrusted input —
    // a digest read back out of a durable row.
    const casUrl = (digest: string) => `${base}/cas/${encodeURIComponent(digest)}`
    const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
      client.execute(authorize(request)).pipe(Effect.mapError((cause) => transportFailure(operation, cause)))
    const measure = (bytes: Uint8Array): Effect.Effect<ArtifactStore.Digest, never, Crypto.Crypto> =>
      Schema.decodeUnknownEffect(Sha256)(bytes).pipe(Effect.orDie)
    const parsedDownloadDeadline = Duration.fromInput(options.downloadTimeout ?? defaultDownloadTimeout)
    if (
      Option.isNone(parsedDownloadDeadline) ||
      !Number.isFinite(Duration.toMillis(parsedDownloadDeadline.value)) ||
      Duration.toMillis(parsedDownloadDeadline.value) <= 0
    ) {
      return yield* Effect.fail(invalidOption("downloadTimeout", options.downloadTimeout))
    }
    const downloadDeadline = parsedDownloadDeadline.value
    const maxDownloadBytes = options.maxDownloadBytes ?? defaultMaxDownloadBytes
    if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes <= 0) {
      return yield* Effect.fail(invalidOption("maxDownloadBytes", maxDownloadBytes))
    }
    const downloadTooLarge = (received: number): ArtifactStore.ArtifactStoreError =>
      new ArtifactStore.ArtifactStoreError({
        code: "transport_failed",
        message:
          `the remote artifact tier answered a download with ${received} bytes, past the ${maxDownloadBytes}-byte bound`
      })
    const downloadTimedOut = (): ArtifactStore.ArtifactStoreError =>
      new ArtifactStore.ArtifactStoreError({
        code: "transport_failed",
        message: `the remote artifact tier did not finish a download within ${Duration.format(downloadDeadline)}`
      })
    /**
     * Reads a download body incrementally, refusing it the moment it exceeds
     * the size bound; a `Content-Length` that already declares the excess is
     * refused before a single body byte is read. Streaming instead of
     * buffering the whole body means the guard fires at most one chunk past
     * the bound, never after an arbitrarily large response is in memory.
     */
    const readBounded = (response: HttpClientResponse.HttpClientResponse) =>
      Effect.gen(function*() {
        const declared = response.headers["content-length"]
        if (declared !== undefined && Number(declared) > maxDownloadBytes) {
          return yield* Effect.fail(downloadTooLarge(Number(declared)))
        }
        const chunks: Array<Uint8Array> = []
        let received = 0
        yield* Stream.runForEach(response.stream, (chunk: Uint8Array) =>
          Effect.suspend(() => {
            received += chunk.byteLength
            if (received > maxDownloadBytes) return Effect.fail(downloadTooLarge(received))
            chunks.push(chunk)
            return Effect.void
          })).pipe(
            Effect.catchTag("HttpClientError", (cause) =>
              // An absent body is zero bytes, not a transport refusal: the
              // digest check in `get` is the arbiter of whether empty content
              // is the requested artifact.
              cause.reason._tag === "EmptyBodyError"
                ? Effect.void
                : Effect.fail(transportFailure("a download body", cause)))
          )
        const bytes = new Uint8Array(received)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        return bytes
      })
    /** The network half of `get`: request, status split, bounded body read. */
    const download = (digest: string) =>
      Effect.gen(function*() {
        const response = yield* send("a download", HttpClientRequest.get(casUrl(digest)))
        if (response.status === 404) {
          return yield* Effect.fail(new ArtifactStore.ArtifactMissing({ code: "artifact_missing", digest }))
        }
        if (!isOk(response)) return yield* Effect.fail(unexpectedStatus("a download", response.status))
        return yield* readBounded(response)
      })

    const put: ArtifactStore.Service["put"] = Effect.fn("RemoteArtifacts.put")((bytes: Uint8Array) =>
      Effect.gen(function*() {
        const digest = yield* measure(bytes)
        yield* Effect.annotateCurrentSpan({ digest })
        const response = yield* send(
          "an upload",
          HttpClientRequest.put(casUrl(digest)).pipe(
            HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream")
          )
        )
        if (!isOk(response)) return yield* Effect.fail(unexpectedStatus("an upload", response.status))
        return digest
      })
    )

    const get: ArtifactStore.Service["get"] = Effect.fn("RemoteArtifacts.get")((digest: string) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ digest })
        yield* ArtifactStore.validateDigest(digest)
        // The deadline covers the whole exchange — request, headers, body —
        // because a tier that stalls mid-body is exactly as unanswering as
        // one that never accepts the connection.
        const bytes = yield* download(digest).pipe(
          Effect.timeout(downloadDeadline),
          Effect.catchTag("TimeoutError", () => Effect.fail(downloadTimedOut()))
        )
        // The shared tier is the least trusted store there is: it is written
        // by machines this one has never met. Verifying the address here means
        // a mis-serving or compromised cache can waste a round trip but can
        // never substitute content.
        const measured = yield* measure(bytes)
        if (measured !== digest) {
          return yield* Effect.fail(
            new ArtifactStore.ArtifactCorruption({
              code: "artifact_corruption",
              recordedDigest: digest,
              measuredDigest: measured
            })
          )
        }
        return bytes
      })
    )

    const has: ArtifactStore.Service["has"] = Effect.fn("RemoteArtifacts.has")((digest: string) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ digest })
        yield* ArtifactStore.validateDigest(digest)
        const response = yield* send("an existence probe", HttpClientRequest.head(casUrl(digest)))
        if (response.status === 404) return false
        if (!isOk(response)) return yield* Effect.fail(unexpectedStatus("an existence probe", response.status))
        return true
      })
    )

    const findMissing: ArtifactStore.Service["findMissing"] = Effect.fn("RemoteArtifacts.findMissing")(
      (digests: Iterable<string>) =>
        Effect.gen(function*() {
          const requested = [...new Set(digests)]
          yield* Effect.annotateCurrentSpan({ count: requested.length })
          if (requested.length === 0) return []
          // The batch travels in a JSON body rather than a path, but an
          // unusable address is still an unusable address, and the local tier
          // refuses the same batch wholesale rather than probing part of it.
          for (const digest of requested) yield* ArtifactStore.validateDigest(digest)
          const response = yield* send(
            "a batched existence probe",
            HttpClientRequest.post(`${base}/cas/findMissing`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ digests: requested })
            )
          )
          if (!isOk(response)) {
            return yield* Effect.fail(unexpectedStatus("a batched existence probe", response.status))
          }
          const body = yield* response.json.pipe(
            Effect.mapError((cause) => transportFailure("a batched existence probe body", cause))
          )
          const decoded = yield* Schema.decodeUnknownEffect(FindMissingResponse)(body).pipe(
            Effect.mapError((cause) => transportFailure("a batched existence probe body", cause))
          )
          // "The returned set is guaranteed to be a subset of `digests`"
          // (`MissingDigestsFinder`). Bazel gets that from the server; we
          // enforce it on this side too, because a server that answered with
          // an unrequested digest would otherwise make the caller upload bytes
          // it never asked about.
          const asked = new Set(requested)
          return decoded.missing.filter((digest) => asked.has(digest))
        })
    )

    return { put, get, has, findMissing }
  })

/**
 * Provides a remote artifact store as the `ArtifactStore` tag.
 *
 * Composing this *alone* makes every artifact read and write a network round
 * trip. The intended production shape is
 * {@link CombinedArtifacts.layer | CombinedArtifacts}, with this as its remote
 * tier.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (
  options: Options
): Layer.Layer<ArtifactStore.ArtifactStore, ArtifactStore.ArtifactStoreError, HttpClient.HttpClient> =>
  Layer.effect(ArtifactStore.ArtifactStore)(make(options))
