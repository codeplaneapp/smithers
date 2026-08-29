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
 * ## Chunked uploads
 *
 * With `chunkBytes` set, a blob past that size travels as a sequence of
 * `PUT /cas/{digest}` requests carrying `Content-Range: bytes {a}-{b}/{total}`,
 * preceded by a `HEAD /cas/{digest}` existence probe and a
 * `Content-Range: bytes *\/{total}` probe with an empty body. This is the
 * resumable-upload shape HTTP already has: the range probe asks what prefix
 * the tier holds and `308` means "keep going", with a `Range: bytes=0-{last}`
 * header on the probe or on a chunk answer moving the offset.
 *
 * Only a `308` continues the sequence, and the completing chunk's `2xx` is
 * confirmed with `HEAD` before `put` reports the digest as published. A `2xx`
 * anywhere else, to the empty probe or to a chunk the tier is still owed bytes
 * after, reads as a tier that ignored `Content-Range` and stored the body it
 * was handed, which is what plain WebDAV `PUT` does. That tier, the one that
 * answers `411` or `416`, and the one whose `HEAD` will not confirm the stored
 * length all get the same treatment: one whole-blob `PUT`, which overwrites
 * the partial body the sequence left behind. So the blob always lands whole,
 * and the cost of turning the dial on against a server that never learned
 * about it is round trips, never a digest published over bytes the server does
 * not hold.
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
 * How eagerly a composition materializes shared blobs into its local store.
 *
 * @category models
 * @since 0.1.0
 */
export type DownloadPolicy = "all" | "toplevel" | "minimal"

/**
 * Every download policy, in materialization order.
 *
 * @category models
 * @since 0.1.0
 */
export const downloadPolicies: ReadonlyArray<DownloadPolicy> = ["all", "toplevel", "minimal"]

/**
 * A remote artifact tier, which is an ordinary store that also states how
 * eagerly a composition reading through it should materialize blobs locally.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service extends ArtifactStore.Service {
  readonly downloadPolicy: DownloadPolicy
}

/**
 * Reads the download policy a store declares, or `undefined` for a store that
 * declares none — every local store, and any foreign implementation.
 *
 * @category getters
 * @since 0.1.0
 */
export const downloadPolicyOf = (store: ArtifactStore.Service): DownloadPolicy | undefined => {
  const declared = (store as { readonly downloadPolicy?: unknown }).downloadPolicy
  return typeof declared === "string" && (downloadPolicies as ReadonlyArray<string>).includes(declared)
    ? declared as DownloadPolicy
    : undefined
}

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
  /**
   * Above this many bytes an upload travels as a sequence of `Content-Range`
   * `PUT`s instead of one whole-blob body, and a transfer that died partway
   * resumes from the prefix the tier kept rather than starting over. See
   * {@link module:RemoteArtifacts | the chunked upload protocol} below.
   *
   * Absent by default: every upload is one whole-blob `PUT`, which is what
   * Bazel's dumb-HTTP client does and what every deployment already serving
   * this protocol expects. Set it when a proxy caps request bodies, or when
   * artifacts are large enough that losing a transfer is expensive.
   */
  readonly chunkBytes?: number | undefined
  /**
   * How eagerly a composition reading through this tier materializes blobs
   * into its local store. This is Bazel's `--remote_download_{all,toplevel,
   * minimal}` dial (`RemoteOutputChecker`), and it lives here because the
   * shared tier is the thing being conserved.
   *
   * - `all` (the default) prefetches every referenced blob when a replay is
   *   admitted, so the replay reads local bytes.
   * - `toplevel` prefetches nothing and materializes a blob into the local
   *   store on the first read that actually needs it.
   * - `minimal` prefetches nothing and materializes nothing: a read is served
   *   straight from the shared tier and the local store never grows.
   *
   * `CombinedArtifacts.get` honors the last two; `@smthrs/engine-store`'s
   * `ArtifactSync.hydrate` honors the first.
   */
  readonly downloadPolicy?: DownloadPolicy | undefined
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
): Effect.Effect<Service, ArtifactStore.ArtifactStoreError, HttpClient.HttpClient> =>
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
    const chunkBytes = options.chunkBytes
    if (chunkBytes !== undefined && (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0)) {
      return yield* Effect.fail(invalidOption("chunkBytes", chunkBytes))
    }
    const downloadPolicy = options.downloadPolicy ?? "all"
    if (!(downloadPolicies as ReadonlyArray<string>).includes(downloadPolicy)) {
      return yield* Effect.fail(invalidOption("downloadPolicy", downloadPolicy))
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

    /** One whole-blob `PUT`: the protocol every dumb-HTTP CAS already speaks. */
    const uploadWhole = (digest: string, bytes: Uint8Array) =>
      Effect.gen(function*() {
        const response = yield* send(
          "an upload",
          HttpClientRequest.put(casUrl(digest)).pipe(
            HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream")
          )
        )
        if (!isOk(response)) return yield* Effect.fail(unexpectedStatus("an upload", response.status))
      })

    /**
     * The byte after the prefix a `Range: bytes=0-{last}` header reports, or
     * `undefined` when the answer names no prefix. Only a prefix starting at
     * zero is usable: a tier holding a middle span has nothing this client can
     * continue from, so it is treated as holding nothing.
     */
    const resumeOffset = (response: HttpClientResponse.HttpClientResponse): number | undefined => {
      const header = response.headers["range"]
      if (header === undefined) return undefined
      const match = /^bytes=0-(\d+)$/.exec(header.trim())
      if (match === null) return undefined
      return Number(match[1]) + 1
    }

    /** A tier that refuses ranged bodies, in the two ways HTTP has to say so. */
    const rejectsRanges = (status: number): boolean => status === 411 || status === 416

    /**
     * Whether the tier holds exactly `total` bytes under `digest`, read from
     * the `Content-Length` of a `HEAD` answer.
     *
     * This is the only claim about a chunked transfer this client will make on
     * its own behalf. A tier that answers `HEAD` without a length is not
     * refused — it simply proves nothing, so the caller sends the blob whole.
     */
    const holdsWhole = (digest: string, total: number) =>
      Effect.map(send("an existence probe", HttpClientRequest.head(casUrl(digest))), (response) => {
        if (!isOk(response)) return false
        const declared = response.headers["content-length"]
        return declared !== undefined && Number(declared) === total
      })

    /**
     * Sends `bytes` as `Content-Range` chunks, resuming from whatever prefix
     * the tier reports. Answers `false` when the tier has not proved it stored
     * the whole blob, which is the caller's signal to send it whole.
     *
     * A `2xx` answer is never by itself proof of that. A tier that ignores
     * `Content-Range`, such as plain WebDAV `PUT`, which Bazel documents as a
     * supported dumb-HTTP cache, answers every request in this sequence `201`
     * while storing only the last body it was handed, which for the probe is
     * zero bytes. So only a `308` continues the sequence, and the completing
     * chunk's `2xx` is confirmed with `HEAD` before the caller is told the
     * digest is published. Everything else falls back, and the whole-blob
     * `PUT` overwrites whatever partial body the sequence left behind.
     */
    const uploadChunked = (digest: string, bytes: Uint8Array, chunk: number) =>
      Effect.gen(function*() {
        const total = bytes.byteLength
        const ranged = (range: string, body: Uint8Array) =>
          send(
            "an upload",
            HttpClientRequest.put(casUrl(digest)).pipe(
              HttpClientRequest.bodyUint8Array(body, "application/octet-stream"),
              HttpClientRequest.setHeader("content-range", range)
            )
          )
        // A blob the tier already holds whole costs one `HEAD` and no body.
        // Asking first is also what makes the probe's answer readable: a `2xx`
        // to it can no longer mean "already there", so the one reading left is
        // a tier that ignored the header and stored the empty body.
        if (yield* holdsWhole(digest, total)) return true
        // The probe carries no bytes: it exists to learn where to start, so
        // that an interrupted transfer costs one round trip rather than the
        // whole blob again.
        const probe = yield* ranged(`bytes */${total}`, new Uint8Array(0))
        if (isOk(probe) || rejectsRanges(probe.status)) return false
        if (probe.status !== 308 && probe.status !== 404) {
          return yield* Effect.fail(unexpectedStatus("an upload probe", probe.status))
        }
        let offset = probe.status === 308 ? resumeOffset(probe) ?? 0 : 0
        while (offset < total) {
          const end = Math.min(offset + chunk, total)
          const answer = yield* ranged(`bytes ${offset}-${end - 1}/${total}`, bytes.subarray(offset, end))
          if (answer.status !== 308) {
            // The completing chunk may answer `2xx`; anything before it may
            // not, because a tier that is still owed bytes and reports success
            // is a tier that is not reading the header. Both are checked
            // against what the tier actually holds below.
            if (end === total && isOk(answer)) break
            if (isOk(answer) || rejectsRanges(answer.status)) return false
            return yield* Effect.fail(unexpectedStatus("an upload", answer.status))
          }
          // A tier that reports a longer prefix than this chunk delivered has
          // more than we just sent, so the next chunk starts there. Never
          // backwards: an answer naming a shorter prefix would loop forever.
          offset = Math.max(end, resumeOffset(answer) ?? 0)
        }
        return yield* holdsWhole(digest, total)
      })

    const put: ArtifactStore.Service["put"] = Effect.fn("RemoteArtifacts.put")((bytes: Uint8Array) =>
      Effect.gen(function*() {
        const digest = yield* measure(bytes)
        yield* Effect.annotateCurrentSpan({ digest })
        if (chunkBytes === undefined || bytes.byteLength <= chunkBytes) {
          yield* uploadWhole(digest, bytes)
          return digest
        }
        const transferred = yield* uploadChunked(digest, bytes, chunkBytes)
        if (!transferred) yield* uploadWhole(digest, bytes)
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

    return { put, get, has, findMissing, downloadPolicy }
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
