/**
 * The content-addressed artifact store: bytes addressed by their own SHA-256
 * digest.
 *
 * It is deliberately *not* the step cache: the step cache maps a step key to a
 * recorded result, while large result bytes live here under their digest. The
 * two tiers remain separate because artifacts must be published before a cache
 * record may reference them. See the package README and
 * {@link https://smithers.sh/docs/concepts/content-addressing | step-key documentation}.
 *
 * @since 1.0.0-rc.0
 */
import { Sha256 } from "@smthrs/crypto"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"
import * as ArtifactStoreMetrics from "./ArtifactStoreMetrics.ts"
import * as ArtifactLocks from "./internal/ArtifactLocks.ts"
import * as ArtifactPath from "./internal/ArtifactPath.ts"

/**
 * Schema for a content address: exactly 64 lowercase hexadecimal SHA-256
 * characters, branded by `@smthrs/crypto`. Re-exported so a consumer never has
 * to reach past this package for the address type it stores under.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 * @slop
 */
export const Digest = Sha256.Digest

/**
 * A content address produced by this store.
 *
 * Read operations accept a plain `string` rather than this brand on purpose: a
 * digest read back out of a durable row is untrusted input, so the store
 * validates it (see {@link ArtifactStoreError}'s `invalid_digest` code) instead
 * of asking every caller to re-brand a persisted column. `put` returns the
 * brand, because it measured the bytes itself.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type Digest = typeof Sha256.Digest.Type

/**
 * Stable error codes returned by artifact store operations.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export const ArtifactStoreErrorCode = Schema.Literals([
  "digest_failed",
  "invalid_configuration",
  "invalid_digest",
  "unavailable",
  "transport_failed"
])

/**
 * Stable error codes returned by artifact store operations.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type ArtifactStoreErrorCode = typeof ArtifactStoreErrorCode.Type

/**
 * A typed failure of the store itself: the host or crypto provider refused an
 * operation, the remote tier refused a request, or the caller supplied invalid
 * configuration or an invalid content address.
 *
 * Distinct from {@link ArtifactMissing} and {@link ArtifactCorruption} on
 * purpose. A miss is an ordinary, expected outcome that a second tier may
 * still satisfy; corruption is an integrity violation of the store's strongest
 * invariant. `invalid_configuration` and `invalid_digest` are permanent;
 * retryability of host, crypto, and transport failures depends on the cause.
 *
 * @category errors
 * @since 1.0.0-rc.0
 * @slop
 */
export class ArtifactStoreError extends Schema.TaggedError<ArtifactStoreError>()(
  "@smthrs/artifacts/ArtifactStoreError",
  {
    code: ArtifactStoreErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * The typed miss: this tier holds no bytes at the requested address.
 *
 * A miss is not a failure of the store — it is the answer a read-through
 * composition is built to act on, so it is a distinct tag rather than an
 * `unavailable` code that a caller would have to string-match.
 *
 * @category errors
 * @since 1.0.0-rc.0
 * @slop
 */
export class ArtifactMissing extends Schema.TaggedError<ArtifactMissing>()(
  "@smthrs/artifacts/ArtifactMissing",
  {
    code: Schema.Literal("artifact_missing"),
    digest: Digest
  }
) {}

/**
 * Bytes stored at a content address no longer hash to it.
 *
 * Every read is digest-verified, so a truncated blob left by a crashing writer
 * or by disk corruption is refused rather than handed back as if it were the
 * recorded artifact.
 *
 * @category errors
 * @since 1.0.0-rc.0
 * @slop
 */
export class ArtifactCorruption extends Schema.TaggedError<ArtifactCorruption>()(
  "@smthrs/artifacts/ArtifactCorruption",
  {
    code: Schema.Literal("artifact_corruption"),
    recordedDigest: Digest,
    measuredDigest: Digest
  }
) {}

/**
 * Content-addressed blob storage.
 *
 * The contract's ergonomics follow Effect's own `KeyValueStore`
 * (`effect/unstable/persistence/KeyValueStore`): a small set of total
 * operations over one address space, with a single typed error family, so a
 * memory, filesystem, or network implementation is the same shape.
 * `findMissing` is Bazel's `MissingDigestsFinder` — one batched round trip
 * whose result is guaranteed to be a subset of its input — because a
 * per-digest existence probe over a network tier is the wrong shape entirely.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface Service {
  /**
   * Stores `bytes` under their own SHA-256 digest and returns that address.
   * Storing the same bytes twice is idempotent.
   */
  readonly put: (bytes: Uint8Array) => Effect.Effect<Digest, ArtifactStoreError, Crypto.Crypto>
  /**
   * Reads the bytes stored at `digest`, verifying that they still hash to it.
   */
  readonly get: (
    digest: string
  ) => Effect.Effect<Uint8Array, ArtifactMissing | ArtifactCorruption | ArtifactStoreError, Crypto.Crypto>
  /** Whether this tier holds an artifact at `digest`. */
  readonly has: (digest: string) => Effect.Effect<boolean, ArtifactStoreError>
  /**
   * Which of `digests` this tier does not hold. The returned array is
   * guaranteed to be a subset of the input and free of duplicates.
   */
  readonly findMissing: (
    digests: Iterable<string>
  ) => Effect.Effect<Array<string>, ArtifactStoreError>
}

/**
 * Service tag for the content-addressed artifact store.
 *
 * The identity string equals this module's package path, per the house rule
 * that an identity is the defining module path.
 *
 * @category services
 * @since 1.0.0-rc.0
 * @slop
 */
export class ArtifactStore extends Context.Service<ArtifactStore, Service>()("@smthrs/artifacts/ArtifactStore") {}

const error = (code: ArtifactStoreErrorCode, message: string, cause?: unknown): ArtifactStoreError =>
  new ArtifactStoreError({ code, message, ...(cause === undefined ? {} : { cause }) })

const hostFailure = (cause: unknown): ArtifactStoreError =>
  error("unavailable", `the host filesystem refused an artifact operation: ${String(cause)}`, cause)

const digestFailure = (cause: unknown): ArtifactStoreError =>
  error("digest_failed", "the Crypto service failed to compute an artifact digest", cause)

/**
 * A refused byte copy is the host declining an allocation, not a crypto
 * failure: the Crypto service has not been consulted when this fires, so
 * reporting `digest_failed` would point an operator diagnosing memory pressure
 * at the wrong subsystem. The message is constant, and the buffer is never
 * attached.
 */
const snapshotFailure = (cause: unknown): ArtifactStoreError =>
  error("unavailable", "the host could not copy the artifact bytes", cause)

/**
 * Measures one immutable byte snapshot without ever retaining it in an error.
 *
 * @category utilities
 * @since 1.0.0-rc.0
 */
export const measureBytes = (bytes: Uint8Array): Effect.Effect<Digest, ArtifactStoreError, Crypto.Crypto> =>
  Sha256.digest(bytes).pipe(Effect.mapError(digestFailure))

/**
 * Copies a caller-owned buffer when the returned Effect begins.
 *
 * A host that refuses the copy — a detached buffer, an allocation past what the
 * runtime will give — fails as `unavailable`, the code for a host refusal.
 *
 * @category utilities
 * @since 1.0.0-rc.0
 */
export const snapshotBytes = (bytes: Uint8Array): Effect.Effect<Uint8Array, ArtifactStoreError> =>
  Effect.try({
    try: () => new Uint8Array(bytes),
    catch: (cause) => snapshotFailure(cause)
  })

/**
 * Refuses anything other than the canonical SHA-256 address representation.
 *
 * Every implementation validates before logging or interpolating an untrusted
 * value into a path or URL. The failure text is constant and bounded, so even a
 * hostile multi-megabyte value cannot be copied into logs or durable errors.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 * @slop
 */
export const validateDigest = (digest: string): Effect.Effect<Digest, ArtifactStoreError> =>
  typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)
    ? Effect.succeed(digest as Digest)
    : Effect.fail(error("invalid_digest", "artifact digest must be exactly 64 lowercase hexadecimal characters"))

/** Deduplicates a digest iterable while preserving first-seen order. */
const distinct = (digests: Iterable<string>): Array<string> => [...new Set(digests)]

/**
 * Where the filesystem-backed store keeps its blobs.
 *
 * The directory is workspace-relative rather than absolute so a workspace can
 * be moved or copied whole and still resolve its own artifacts.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface FileSystemOptions {
  /**
   * Where blobs are stored, content-addressed by digest. Workspace-relative;
   * defaults to {@link defaultDirectory}. An `ArtifactSweep` over the same
   * store must be built with this same directory, or it enumerates somewhere
   * the store never publishes.
   */
  readonly directory?: string | undefined
  /** New payload mode, default `0600`, restricted by the umask. Existing blobs are unchanged. */
  readonly fileMode?: number | undefined
  /** New objects and fanout directory mode, default `0700`. Existing directories are unchanged. */
  readonly directoryMode?: number | undefined
  /**
   * `required` reports success only after syncing the blob, its fanout,
   * the objects directory, and every ancestor. `best-effort` is the explicit weaker
   * capability for hosts that cannot sync file or directory handles.
   * Both modes require exclusive writable handles and symlink inspection.
   */
  readonly durability?: "required" | "best-effort" | undefined
  /**
   * `required` uses an atomic lock file to coordinate writers and sweepers
   * across processes. `process` is the explicit weaker browser/test mode.
   *
   * The fence bounds the race rather than eliminating it: the lock is
   * heartbeated every 10 seconds, another process reclaims it once it is 60
   * seconds stale, and acquisition itself gives up after 2 minutes. A holder
   * whose host stalls past the stale bound can therefore be reaped while it is
   * still running.
   *
   * Reclaiming a stale lock is a measurement followed by a separate removal,
   * not one atomic compare-and-swap, so the exposure outlives the stalled
   * holder: two processes that both measure the same lock as stale both go on
   * to reclaim it, and the second reclaims whatever now sits at that path,
   * including the fresh lock the first just took. A release is the same shape,
   * reading the owner and then removing the path. Neither the mtime check nor
   * the backup lease independently protects against loss of mutual exclusion:
   * the check precedes a separate delete, and the gate uses this same protocol.
   * A sweep can delete a successful publication using pre-publication age
   * evidence if another stale reclaimer displaces its lock.
   *
   * It also only fences parties that agree. An `ArtifactSweep` over the same
   * directory must be built with the same `coordination`: a store on `process`
   * paired with a sweep on `required` takes lock files no writer observes, so
   * the fence reads as armed and protects nothing.
   */
  readonly coordination?: "required" | "process" | undefined
}

/**
 * The default objects directory. Workspace-relative, so a workspace carries
 * its own artifacts and a sandbox that mounts the workspace inherits them.
 *
 * Exported because the store and its sweep must name the same directory, and a
 * second private copy of the literal is exactly how they would drift apart.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultDirectory = ".flows/objects"

/**
 * How old a scratch file must be before the sweep treats it as a crash orphan
 * rather than a live writer's in-flight file. A publication writes and renames
 * within one `put`, so an hour is far beyond any live writer's window, and it
 * is sixty times the 60-second bound after which a lock file's own contention
 * path reclaims it, so a lock this old belongs to no living holder either.
 */
const staleScratchMs = 60 * 60 * 1000

/** Whether an entry is scratch the sweep may reclaim once it is stale. */
const isScratch = (entry: string): boolean =>
  entry.includes(".tmp-") || entry.startsWith(`${ArtifactLocks.directoryName}/`)

const isNotFound = (cause: unknown): boolean =>
  cause instanceof PlatformError.PlatformError && cause.reason._tag === "NotFound"

/**
 * Bazel's `DiskCacheClient.toPath` layout: a two-hex-prefix subdirectory
 * "to bypass possible folder file count limits"
 * (class `DiskCacheClient` in `com.google.devtools.build.lib.remote.disk`). The
 * store moved out of `StepBoundary` with a flat `${dir}/${digest}` layout, which puts every
 * artifact a workspace ever spilled into one directory. The rc.0 contract has
 * no compatibility shim for the provisional flat layout; old addresses are
 * cache misses that re-publish.
 */
const fanout = (directory: string, digest: string): { readonly parent: string; readonly path: string } => {
  const parent = `${directory}/${digest.slice(0, 2)}`
  return { parent, path: `${parent}/${digest}` }
}

/**
 * Builds the filesystem-backed artifact store.
 *
 * Host access arrives through Effect's `FileSystem` tag, which the capability
 * kernel decorates in place — the same seam every host implementation (node,
 * bun, browser, sandbox) already provides.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const makeFileSystem = (fs: FileSystem.FileSystem, options: FileSystemOptions = {}): Service => {
  const directory = (options.directory ?? defaultDirectory).replace(/([^/])\/+$/, "$1")
  const durability = options.durability ?? "required"
  const coordination = options.coordination ?? "required"
  const fileMode = options.fileMode ?? 0o600
  const directoryMode = options.directoryMode ?? 0o700
  // Every attempt draws a new token; exclusivity, not unpredictability, protects
  // an existing entry. Bound retries so a hostile directory cannot hang put.
  const freshTempToken = Effect.map(
    Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true }),
    (drawn) => drawn.toString(36)
  )
  /**
   * Best-effort reclamation of scratch files orphaned by a crash: `.tmp-*`
   * payloads left between the temp write and the rename, and `.locks/*` files
   * left by a holder that was hard-killed. Nothing else ever observes either —
   * reads resolve only canonical paths, and a lock is reclaimed on contention
   * alone, so a digest nobody publishes again keeps its lock file forever —
   * which is how the objects directory would accumulate dead files unboundedly.
   * The sweep runs once per store, on the first publication, and is
   * conservative: a scratch file younger than the stale bound may belong to a
   * live writer or lock holder in another process, and one whose age cannot be
   * measured says nothing about its owner, so both survive. Every step is
   * best-effort — a missing directory or failing host never fails the
   * publication.
   *
   * It measures and then removes, which is not atomic, so a lock file replaced
   * between those two steps is removed on the strength of its predecessor's
   * age. The hour-long threshold is what keeps that narrow: a live holder
   * heartbeats its lock every 10 seconds, so only a path abandoned for an hour
   * is ever a candidate, and only a reclaim landing inside that one gap loses
   * its lock. It is the same non-atomic reclamation `FileSystemOptions`'
   * `coordination` documents, applied to the files that reclamation leaves
   * behind.
   *
   * This is a sweep of scratch files, not garbage collection. Reclaiming
   * *published* artifacts is `ArtifactSweep` driven by an explicit
   * `ArtifactGc.gc()` call in `@smthrs/engine-store`, never folded in here.
   */
  let sweepDone = false
  const sweepOrphanedTemps = Effect.gen(function*() {
    if (sweepDone) return
    sweepDone = true
    const checkRoot = yield* ArtifactPath.guard(fs, directory)
    const parents = yield* fs.readDirectory(directory)
    const now = yield* Clock.currentTimeMillis
    for (const parent of parents) {
      if (!/^[0-9a-f]{2}$/.test(parent) && parent !== ArtifactLocks.directoryName) continue
      const parentPath = `${directory}/${parent}`
      yield* checkRoot
      const checkParent = yield* ArtifactPath.guard(fs, parentPath).pipe(Effect.option)
      if (Option.isNone(checkParent)) continue
      const entries = yield* fs.readDirectory(parentPath).pipe(Effect.orElseSucceed(() => [] as Array<string>))
      for (const entry of entries) {
        if (entry.includes("/") || entry.includes("\\") || !isScratch(`${parent}/${entry}`)) continue
        const orphanPath = `${parentPath}/${entry}`
        yield* Effect.gen(function*() {
          const checkFile = yield* ArtifactPath.guard(fs, orphanPath, "File")
          const info = yield* fs.stat(orphanPath)
          const mtime = Option.getOrUndefined(info.mtime)
          if (mtime === undefined || now - mtime.getTime() < staleScratchMs) return
          yield* checkRoot
          yield* checkParent.value
          yield* checkFile
          yield* fs.remove(orphanPath)
        }).pipe(Effect.ignore)
      }
    }
  }).pipe(Effect.ignore)

  /**
   * Flushes a freshly written temp file before it is renamed into place.
   *
   * Bazel does exactly this in `DiskCacheClient.saveFile`: "fsync temp before
   * we rename it to avoid data loss in the case of machine crashes (the OS may
   * reorder the writes and the rename)". Scratch files sync on their retained
   * handle; this helper syncs published blobs and directories. Best-effort
   * durability tolerates sync refusals, but still requires exclusive creation.
   */
  const syncPath = (path: string, flag: "r" | "r+"): Effect.Effect<void, ArtifactStoreError> => {
    const sync = Effect.scoped(Effect.flatMap(fs.open(path, { flag }), (file) => file.sync)).pipe(
      Effect.mapError(hostFailure)
    )
    return durability === "best-effort" ? Effect.ignore(sync) : sync
  }
  // A directory sync persists its children, not its own name in its parent.
  // Repeat the whole ancestry even on dedupe: an existing directory may have
  // been created by an interrupted publication in another store or process.
  // Syncing objects also persists the lock directory created by withDigest.
  const syncDirectoryAncestry = Effect.gen(function*() {
    const path = yield* Path.Path
    let current = directory
    while (true) {
      yield* syncPath(current, "r")
      const parent = path.dirname(current)
      if (parent === current) return
      current = parent
    }
  }).pipe(Effect.provide(Path.layer))

  const put: Service["put"] = Effect.fn("ArtifactStore.put")((bytes: Uint8Array) =>
    Effect.flatMap(
      snapshotBytes(bytes),
      (snapshot) =>
        Effect.flatMap(measureBytes(snapshot), (digest) =>
          Effect.gen(function*() {
            yield* ArtifactPath.guard(fs, directory).pipe(Effect.mapError(hostFailure))
            yield* fs.makeDirectory(directory, { recursive: true, mode: directoryMode }).pipe(
              Effect.mapError(hostFailure)
            )
            const checkRoot = yield* ArtifactPath.guard(fs, directory).pipe(Effect.mapError(hostFailure))
            if (coordination === "required") {
              yield* ArtifactPath.guard(fs, `${directory}/${ArtifactLocks.directoryName}`).pipe(
                Effect.mapError(hostFailure)
              )
            }
            return yield* ArtifactLocks.withDigest(
              fs,
              directory,
              digest,
              Effect.gen(function*() {
                yield* Effect.annotateCurrentSpan({ digest })
                const blob = fanout(directory, digest)
                yield* checkRoot.pipe(Effect.mapError(hostFailure))
                yield* ArtifactPath.guard(fs, blob.parent).pipe(Effect.mapError(hostFailure))
                yield* fs.makeDirectory(blob.parent, { mode: directoryMode, recursive: true }).pipe(
                  Effect.mapError(hostFailure)
                )
                const checkParent = yield* ArtifactPath.guard(fs, blob.parent).pipe(Effect.mapError(hostFailure))
                const checkBlob = yield* ArtifactPath.guard(fs, blob.path, "File").pipe(Effect.mapError(hostFailure))
                const stored = yield* fs.exists(blob.path).pipe(Effect.mapError(hostFailure))
                // Existence alone is not validity: a truncated blob left by a crashing
                // writer or by disk corruption would otherwise be trusted forever at
                // write time while `get` digest-verifies and refuses — a permanent
                // failure with no repair path even though this process holds the correct
                // bytes. The existing blob is digest-verified on EVERY put (an
                // unreadable blob counts as corrupt), and only a verified match skips
                // the write; a mismatch falls through to the atomic rewrite below,
                // healing the address. Verification is deliberately not memoized: the
                // objects directory is workspace-shared, so a blob can change behind
                // this store's back, and a remembered proof let a later `put` report
                // success over corrupt bytes without repairing them — `get` would then
                // refuse the digest forever even though every `put` held the cure.
                // Re-verifying costs a constant factor, never a new asymptote: a `put`
                // already pays one O(blob size) hash to measure its own input.
                let verified = stored &&
                  (yield* fs.readFile(blob.path).pipe(
                    Effect.flatMap((existing) => Effect.map(measureBytes(existing), (measured) => measured === digest)),
                    Effect.catch(() => Effect.succeed(false))
                  ))
                if (verified) {
                  // Freshen the blob's mtime on a dedupe hit — git's loose-object
                  // freshening, and the touch Bazel's `DiskCacheClient` performs on a
                  // cache hit. The mtime is the age evidence a mark/sweep collector
                  // fences its deletions on (`ArtifactSweep`), so a re-publication of
                  // old bytes must read as a recent reference or the grace period
                  // cannot protect the entry recorded moments later. Best-effort on
                  // hosts without `utimes` (the browser filesystem): a failed freshen
                  // over a blob that still exists keeps the dedupe skip and accepts
                  // git's freshen-versus-prune race; a failed freshen over a blob that
                  // VANISHED — a sweep won it — falls through to the atomic rewrite
                  // below, healing the address.
                  const now = yield* Clock.currentTimeMillis
                  const timestamp = new Date(now)
                  yield* checkRoot.pipe(Effect.mapError(hostFailure))
                  yield* checkParent.pipe(Effect.mapError(hostFailure))
                  yield* checkBlob.pipe(Effect.mapError(hostFailure))
                  const alive = yield* fs.utimes(blob.path, timestamp, timestamp).pipe(
                    Effect.as(true),
                    Effect.catch(() => fs.exists(blob.path).pipe(Effect.catch(() => Effect.succeed(true))))
                  )
                  if (!alive) {
                    verified = false
                  }
                  if (verified) {
                    yield* syncPath(blob.path, "r+")
                    yield* syncPath(blob.parent, "r")
                  }
                }
                if (!verified) {
                  // Atomic publication: a plain write to the canonical address could be
                  // observed — or survive a crash — as a partial file that every later
                  // read of this digest would trust. The payload lands at a temp path in
                  // the same fanout directory (so the rename never crosses a filesystem)
                  // and is renamed into place; an existing blob is rewritten only when
                  // its bytes no longer match its address.
                  yield* sweepOrphanedTemps
                  yield* Effect.scoped(Effect.gen(function*() {
                    for (let attempt = 0; attempt < 16; attempt++) {
                      yield* checkRoot
                      yield* checkParent
                      const tempPath = `${blob.path}.tmp-${yield* freshTempToken}-${attempt}`
                      const file = yield* fs.open(tempPath, { flag: "wx", mode: fileMode }).pipe(
                        Effect.map(Option.some),
                        Effect.catch((cause) =>
                          cause.reason._tag === "AlreadyExists"
                            ? Effect.succeed(Option.none())
                            : Effect.fail(cause)
                        )
                      )
                      if (Option.isNone(file)) continue
                      // Install cleanup only after exclusive acquisition. Never unlink
                      // a colliding entry, which may belong to another writer.
                      const checkTemp = yield* ArtifactPath.guard(fs, tempPath, "File", yield* file.value.stat)
                      yield* Effect.gen(function*() {
                        if (snapshot.byteLength > 0) yield* file.value.writeAll(snapshot)
                        yield* durability === "best-effort" ? Effect.ignore(file.value.sync) : file.value.sync
                        yield* checkRoot
                        yield* checkParent
                        yield* checkTemp
                        yield* fs.rename(tempPath, blob.path)
                        yield* syncPath(blob.parent, "r")
                      }).pipe(Effect.onError(() =>
                        Effect.gen(function*() {
                          yield* checkRoot
                          yield* checkParent
                          yield* checkTemp
                          yield* fs.remove(tempPath)
                        }).pipe(Effect.ignore)
                      ))
                      return
                    }
                    return yield* Effect.fail(
                      error("unavailable", "artifact scratch creation exhausted collision retries")
                    )
                  })).pipe(Effect.mapError(hostFailure))
                }
                yield* syncDirectoryAncestry
                yield* Metric.update(ArtifactStoreMetrics.puts, 1)
                return digest
              }),
              hostFailure,
              coordination
            )
          }))
    )
  )

  const get: Service["get"] = Effect.fn("ArtifactStore.get")((digest: string) =>
    Effect.gen(function*() {
      const validated = yield* validateDigest(digest)
      yield* Effect.annotateCurrentSpan({ digest: validated })
      const blob = fanout(directory, validated)
      const bytes = yield* fs.readFile(blob.path).pipe(
        Effect.catch((cause): Effect.Effect<Uint8Array, ArtifactMissing | ArtifactStoreError> => {
          const missing = new ArtifactMissing({ code: "artifact_missing", digest: validated })
          if (isNotFound(cause)) return Effect.fail(missing)
          return fs.exists(blob.path).pipe(
            Effect.mapError((probeCause) => hostFailure({ read: cause, existenceProbe: probeCause })),
            Effect.flatMap((present): Effect.Effect<Uint8Array, ArtifactMissing | ArtifactStoreError> =>
              Effect.fail(present ? hostFailure(cause) : missing)
            )
          )
        })
      )
      const measured = yield* measureBytes(bytes)
      if (measured !== validated) {
        return yield* Effect.fail(
          new ArtifactCorruption({
            code: "artifact_corruption",
            recordedDigest: validated,
            measuredDigest: measured
          })
        )
      }
      yield* Metric.update(ArtifactStoreMetrics.gets, 1)
      return bytes
    })
  )

  const has: Service["has"] = Effect.fn("ArtifactStore.has")((digest: string) =>
    Effect.gen(function*() {
      const validated = yield* validateDigest(digest)
      yield* Effect.annotateCurrentSpan({ digest: validated })
      return yield* fs.exists(fanout(directory, validated).path).pipe(Effect.mapError(hostFailure))
    })
  )

  const findMissing: Service["findMissing"] = Effect.fn("ArtifactStore.findMissing")((digests: Iterable<string>) =>
    Effect.gen(function*() {
      const requested = distinct(digests)
      yield* Effect.annotateCurrentSpan({ count: requested.length })
      yield* Effect.forEach(requested, validateDigest, { discard: true })
      const present = yield* Effect.forEach(requested, has, { concurrency: 16 })
      return requested.filter((_, index) => !present[index])
    })
  )

  return { put, get, has, findMissing }
}

/**
 * Provides the filesystem-backed artifact store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layerFileSystem = (
  options: FileSystemOptions = {}
): Layer.Layer<ArtifactStore, never, FileSystem.FileSystem> =>
  Layer.effect(ArtifactStore)(Effect.map(FileSystem.FileSystem, (fs) => makeFileSystem(fs, options)))

/**
 * Builds an in-memory artifact store, for tests and for a browser host with no
 * durable filesystem yet.
 *
 * Reads are not digest-verified here, and that is not an oversight: the map is
 * keyed by the digest this store measured when it accepted the bytes, and both
 * boundaries copy — `put` stores a copy of the caller's array and `get` hands
 * out a copy of the stored one — so no reference a caller can still mutate
 * aliases the stored content, and there is no window in which the address and
 * the content can disagree. The filesystem and remote implementations verify
 * because their address spaces are genuinely shared.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const makeMemory = (): Service => {
  const blobs = new Map<string, Uint8Array>()
  const has: Service["has"] = Effect.fn("ArtifactStore.has")((digest: string) =>
    Effect.flatMap(validateDigest(digest), (validated) =>
      Effect.annotateCurrentSpan({ digest: validated }).pipe(
        Effect.as(blobs.has(validated))
      ))
  )
  return {
    put: Effect.fn("ArtifactStore.put")((bytes: Uint8Array) =>
      Effect.flatMap(snapshotBytes(bytes), (snapshot) =>
        Effect.map(measureBytes(snapshot), (digest) => {
          // A defensive copy, never the caller's reference: the caller is free
          // to reuse its buffer after `put` returns, and an aliased array would
          // let that mutation corrupt the stored content for its digest.
          blobs.set(digest, snapshot)
          return digest
        })).pipe(
          Effect.tap((digest) => Effect.annotateCurrentSpan({ digest })),
          Effect.tap(() => Metric.update(ArtifactStoreMetrics.puts, 1))
        )
    ),
    get: Effect.fn("ArtifactStore.get")((digest: string) =>
      Effect.gen(function*() {
        const validated = yield* validateDigest(digest)
        yield* Effect.annotateCurrentSpan({ digest: validated })
        const bytes = blobs.get(validated)
        if (bytes === undefined) {
          return yield* Effect.fail(new ArtifactMissing({ code: "artifact_missing", digest: validated }))
        }
        yield* Metric.update(ArtifactStoreMetrics.gets, 1)
        // A copy for the same reason `put` stores one: handing out the stored
        // array would let one reader's mutation corrupt every later read of
        // the digest.
        return bytes.slice()
      })
    ),
    has,
    findMissing: Effect.fn("ArtifactStore.findMissing")((digests: Iterable<string>) =>
      Effect.gen(function*() {
        const requested = distinct(digests)
        yield* Effect.annotateCurrentSpan({ count: requested.length })
        const missing: Array<string> = []
        for (const digest of requested) {
          if (!(yield* has(digest))) missing.push(digest)
        }
        return missing
      })
    )
  }
}

/**
 * Provides an in-memory artifact store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layerMemory: Layer.Layer<ArtifactStore> = Layer.effect(ArtifactStore)(Effect.sync(makeMemory))

/**
 * Builds an artifact store whose every operation fails as unavailable, with
 * per-method overrides.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string) => Effect.fail(error("unavailable", `${method} is unavailable`))
  return {
    put: Effect.fn("ArtifactStore.put")(() => unavailable("put")),
    get: Effect.fn("ArtifactStore.get")(() => unavailable("get")),
    has: Effect.fn("ArtifactStore.has")(() => unavailable("has")),
    findMissing: Effect.fn("ArtifactStore.findMissing")(() => unavailable("findMissing")),
    ...overrides
  }
}

/**
 * Provides a no-op artifact store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ArtifactStore> =>
  Layer.succeed(ArtifactStore)(makeNoop(overrides))
