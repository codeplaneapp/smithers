/**
 * The content-addressed artifact store: bytes addressed by their own SHA-256
 * digest.
 *
 * This is the "content-addressed store for artifacts" the `Cache` service owns
 * in `docs/specs/Specs/Object Model.md`. It is deliberately *not* the step
 * cache: the step cache maps a step key to a recorded result, and a recorded
 * result may reference artifacts by digest. The two tiers are separate because
 * their publication order matters — see `docs/specs/Concepts/Remote Cache.md`.
 *
 * The package is named for what it stores, per the naming rule in
 * `docs/specs/Concepts/Journal Split.md`.
 *
 * Governing designs: `docs/specs/Specs/Input.md` (large values enter by
 * digest), `docs/specs/Concepts/Step Keys.md`, and
 * `docs/specs/Concepts/Remote Cache.md`.
 *
 * @since 0.1.0
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
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"
import * as ArtifactStoreMetrics from "./ArtifactStoreMetrics.ts"
import * as ArtifactLocks from "./internal/ArtifactLocks.ts"

/**
 * Schema for a content address: exactly 64 lowercase hexadecimal SHA-256
 * characters, branded by `@smthrs/crypto`. Re-exported so a consumer never has
 * to reach past this package for the address type it stores under.
 *
 * @category schemas
 * @since 0.1.0
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
 * @since 0.1.0
 * @slop
 */
export type Digest = typeof Sha256.Digest.Type

/**
 * Stable error codes returned by artifact store operations.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ArtifactStoreErrorCode = Schema.Literals([
  "invalid_digest",
  "unavailable",
  "transport_failed"
])

/**
 * Stable error codes returned by artifact store operations.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ArtifactStoreErrorCode = typeof ArtifactStoreErrorCode.Type

/**
 * A transient or configuration failure of the store itself: the host refused
 * the I/O, the remote tier refused the request, or the caller supplied
 * something that is not a content address.
 *
 * Distinct from {@link ArtifactMissing} and {@link ArtifactCorruption} on
 * purpose. A miss is an ordinary, expected outcome that a second tier may
 * still satisfy; corruption is an integrity violation of the store's strongest
 * invariant; this is neither, and stays retryable.
 *
 * @category errors
 * @since 0.1.0
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
 * @since 0.1.0
 * @slop
 */
export class ArtifactMissing extends Schema.TaggedError<ArtifactMissing>()(
  "@smthrs/artifacts/ArtifactMissing",
  {
    code: Schema.Literal("artifact_missing"),
    digest: Schema.String
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
 * @since 0.1.0
 * @slop
 */
export class ArtifactCorruption extends Schema.TaggedError<ArtifactCorruption>()(
  "@smthrs/artifacts/ArtifactCorruption",
  {
    code: Schema.Literal("artifact_corruption"),
    recordedDigest: Schema.String,
    measuredDigest: Schema.String
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
 * @since 0.1.0
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
 * @since 0.1.0
 * @slop
 */
export class ArtifactStore extends Context.Service<ArtifactStore, Service>()("@smthrs/artifacts/ArtifactStore") {}

const error = (code: ArtifactStoreErrorCode, message: string, cause?: unknown): ArtifactStoreError =>
  new ArtifactStoreError({ code, message, ...(cause === undefined ? {} : { cause }) })

const hostFailure = (cause: unknown): ArtifactStoreError =>
  error("unavailable", `the host filesystem refused an artifact operation: ${String(cause)}`, cause)

/**
 * Refuses a content address that cannot safely be used as a path segment.
 *
 * Every implementation interpolates the address into a location — a filesystem
 * path under the objects directory, a `/cas/{digest}` URL — so an address that
 * is empty, carries a separator, or is a directory traversal would address
 * something else entirely. Rejecting is cheap and closes that door once for all
 * of them, which is why this is exported rather than repeated per backend.
 *
 * The 64-hex *shape* is deliberately NOT enforced. Digests reach `get` from
 * durable rows written by older layers and by foreign boundary
 * implementations; refusing to look one up would reclassify an ordinary miss as
 * a caller error, and the digest verification on read is the check that
 * actually protects the caller.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const validateDigest = (digest: string): Effect.Effect<void, ArtifactStoreError> =>
  digest.length > 0 && !digest.includes("/") && !digest.includes("\\") && digest !== "." && digest !== ".."
    ? Effect.void
    : Effect.fail(error("invalid_digest", `${JSON.stringify(digest)} is not a usable content address`))

/** Deduplicates a digest iterable while preserving first-seen order. */
const distinct = (digests: Iterable<string>): Array<string> => [...new Set(digests)]

/**
 * Where the filesystem-backed store keeps its blobs.
 *
 * The directory is workspace-relative rather than absolute so a workspace can
 * be moved or copied whole and still resolve its own artifacts.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface FileSystemOptions {
  /**
   * Where blobs are stored, content-addressed by digest. Workspace-relative;
   * defaults to `.flows/objects`.
   */
  readonly directory?: string | undefined
  /**
   * `required` reports success only after syncing both the blob and the
   * containing fanout directory. `best-effort` is the explicit weaker
   * capability for hosts such as browser filesystems that cannot open file
   * handles for syncing.
   */
  readonly durability?: "required" | "best-effort" | undefined
}

/**
 * The default objects directory. Workspace-relative, so a workspace carries
 * its own artifacts and a sandbox that mounts the workspace inherits them.
 */
const defaultDirectory = ".flows/objects"

/**
 * How old a `.tmp-*` file must be before the sweep treats it as a crash orphan
 * rather than a live writer's in-flight scratch file. A publication writes and
 * renames within one `put`, so an hour is far beyond any live writer's window.
 */
const staleTempMs = 60 * 60 * 1000

/**
 * Bazel's `DiskCacheClient.toPath` layout: a two-hex-prefix subdirectory
 * "to bypass possible folder file count limits"
 * (`reference/bazel/.../remote/disk/DiskCacheClient.java`). The store moved out
 * of `StepBoundary` with a flat `${dir}/${digest}` layout, which puts every
 * artifact a workspace ever spilled into one directory. There is no
 * compatibility shim for the flat layout: nothing is released yet, so the old
 * addresses are simply cache misses that re-publish.
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
 * @since 0.1.0
 * @slop
 */
export const makeFileSystem = (fs: FileSystem.FileSystem, options: FileSystemOptions = {}): Service => {
  const directory = options.directory ?? defaultDirectory
  const durability = options.durability ?? "required"
  /**
   * Distinguishes concurrent temp paths for the same digest across writers.
   * The counter separates in-flight writers of this service instance; the
   * random token separates instances — the objects directory is
   * workspace-shared, so two processes publishing the same digest would
   * otherwise both write `<blob>.tmp-0`, clobber each other's completed temp
   * file, and publish torn bytes at the canonical content address. The token
   * never enters any persisted identity, so its randomness is invisible to
   * replay.
   *
   * It is drawn from Effect's `Random` — the sanctioned swappable port for
   * nondeterminism — rather than ambient `Math.random`, and memoized on first
   * publication so one token per service instance is all it costs and
   * `makeFileSystem` itself stays synchronous.
   */
  let tempToken: string | undefined
  const freshTempToken: Effect.Effect<string> = Effect.suspend(() =>
    tempToken === undefined
      ? Effect.map(
        Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true }),
        (drawn) => {
          tempToken = drawn.toString(36).slice(0, 10).padEnd(10, "0")
          return tempToken
        }
      )
      : Effect.succeed(tempToken)
  )
  let tempSequence = 0
  /**
   * Best-effort reclamation of temp files orphaned by a crash between the temp
   * write and the rename: nothing else ever observes them — reads resolve only
   * canonical paths — so without a sweep the objects directory accumulates
   * dead `.tmp-*` files unboundedly. The sweep runs once per store, on the
   * first publication, and is conservative: a temp younger than the stale
   * bound may belong to a live writer in another process, and one whose age
   * cannot be measured says nothing about its writer, so both survive. Every
   * step is best-effort — a missing directory or failing host never fails the
   * publication.
   *
   * This is a sweep of scratch files, not garbage collection. Reclaiming
   * *published* artifacts is `ArtifactSweep` driven by an explicit
   * `ArtifactGc.gc()` call in `@smthrs/engine-store` — an explicit verb per
   * `docs/specs/Concepts/Reconciliation.md`, never folded in here.
   */
  let sweepDone = false
  const sweepOrphanedTemps = Effect.gen(function*() {
    if (sweepDone) return
    sweepDone = true
    const entries = yield* fs.readDirectory(directory, { recursive: true }).pipe(
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>))
    )
    const now = yield* Clock.currentTimeMillis
    for (const entry of entries) {
      if (!entry.includes(".tmp-")) continue
      const orphanPath = `${directory}/${entry}`
      const info = yield* fs.stat(orphanPath).pipe(Effect.option)
      if (Option.isNone(info)) continue
      const mtime = Option.getOrUndefined(info.value.mtime)
      if (mtime === undefined || now - mtime.getTime() < staleTempMs) continue
      yield* fs.remove(orphanPath).pipe(Effect.ignore)
    }
  })
  /**
   * Flushes a freshly written temp file before it is renamed into place.
   *
   * Bazel does exactly this in `DiskCacheClient.saveFile`: "fsync temp before
   * we rename it to avoid data loss in the case of machine crashes (the OS may
   * reorder the writes and the rename)". Hosts such as browser filesystems
   * that cannot open writable handles must select the explicit `best-effort`
   * capability. Required durability propagates every open or sync refusal
   * instead of claiming a durable write.
   */
  const syncPath = (path: string, flag: "r" | "r+"): Effect.Effect<void, ArtifactStoreError> => {
    const sync = Effect.scoped(Effect.flatMap(fs.open(path, { flag }), (file) => file.sync)).pipe(
      Effect.mapError(hostFailure)
    )
    return durability === "best-effort" ? Effect.ignore(sync) : sync
  }
  const measure = (bytes: Uint8Array): Effect.Effect<Digest, never, Crypto.Crypto> =>
    Schema.decodeUnknownEffect(Sha256)(bytes).pipe(Effect.orDie)

  const put: Service["put"] = Effect.fn("ArtifactStore.put")((bytes: Uint8Array) =>
    Effect.flatMap(measure(bytes), (digest) =>
      ArtifactLocks.withDigest(
        fs,
        digest,
        Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({ digest })
          const blob = fanout(directory, digest)
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
              Effect.flatMap((existing) => Effect.map(measure(existing), (measured) => measured === digest)),
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
            const alive = yield* fs.utimes(blob.path, now, now).pipe(
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
            yield* fs.makeDirectory(blob.parent, { recursive: true }).pipe(Effect.mapError(hostFailure))
            yield* sweepOrphanedTemps
            const tempPath = `${blob.path}.tmp-${yield* freshTempToken}-${tempSequence++}`
            // A failed publication removes its own scratch file; a crash cannot,
            // which is what the sweep above reclaims.
            yield* fs.writeFile(tempPath, bytes).pipe(
              Effect.andThen(syncPath(tempPath, "r+")),
              Effect.andThen(fs.rename(tempPath, blob.path)),
              Effect.andThen(syncPath(blob.parent, "r")),
              Effect.mapError(hostFailure),
              Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignore))
            )
          }
          yield* Metric.update(ArtifactStoreMetrics.puts, 1)
          return digest
        })
      ))
  )

  const get: Service["get"] = Effect.fn("ArtifactStore.get")((digest: string) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({ digest })
      yield* validateDigest(digest)
      const blob = fanout(directory, digest)
      const present = yield* fs.exists(blob.path).pipe(Effect.mapError(hostFailure))
      if (!present) {
        return yield* Effect.fail(new ArtifactMissing({ code: "artifact_missing", digest }))
      }
      const bytes = yield* fs.readFile(blob.path).pipe(Effect.mapError(hostFailure))
      const measured = yield* measure(bytes)
      if (measured !== digest) {
        return yield* Effect.fail(
          new ArtifactCorruption({
            code: "artifact_corruption",
            recordedDigest: digest,
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
      yield* Effect.annotateCurrentSpan({ digest })
      yield* validateDigest(digest)
      return yield* fs.exists(fanout(directory, digest).path).pipe(Effect.mapError(hostFailure))
    })
  )

  const findMissing: Service["findMissing"] = Effect.fn("ArtifactStore.findMissing")((digests: Iterable<string>) =>
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

  return { put, get, has, findMissing }
}

/**
 * Provides the filesystem-backed artifact store.
 *
 * @category layers
 * @since 0.1.0
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
 * @since 0.1.0
 * @slop
 */
export const makeMemory = (): Service => {
  const blobs = new Map<string, Uint8Array>()
  const measure = (bytes: Uint8Array): Effect.Effect<Digest, never, Crypto.Crypto> =>
    Schema.decodeUnknownEffect(Sha256)(bytes).pipe(Effect.orDie)
  const has: Service["has"] = Effect.fn("ArtifactStore.has")((digest: string) =>
    Effect.annotateCurrentSpan({ digest }).pipe(
      Effect.andThen(Effect.map(validateDigest(digest), () => blobs.has(digest)))
    )
  )
  return {
    put: Effect.fn("ArtifactStore.put")((bytes: Uint8Array) =>
      Effect.map(measure(bytes), (digest) => {
        // A defensive copy, never the caller's reference: the caller is free
        // to reuse its buffer after `put` returns, and an aliased array would
        // let that mutation corrupt the stored content for its digest.
        blobs.set(digest, bytes.slice())
        return digest
      }).pipe(
        Effect.tap((digest) => Effect.annotateCurrentSpan({ digest })),
        Effect.tap(() => Metric.update(ArtifactStoreMetrics.puts, 1))
      )
    ),
    get: Effect.fn("ArtifactStore.get")((digest: string) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ digest })
        yield* validateDigest(digest)
        const bytes = blobs.get(digest)
        if (bytes === undefined) {
          return yield* Effect.fail(new ArtifactMissing({ code: "artifact_missing", digest }))
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
 * @since 0.1.0
 * @slop
 */
export const layerMemory: Layer.Layer<ArtifactStore> = Layer.effect(ArtifactStore)(Effect.sync(makeMemory))

/**
 * Builds an artifact store whose every operation fails as unavailable, with
 * per-method overrides.
 *
 * @category constructors
 * @since 0.1.0
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
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ArtifactStore> =>
  Layer.succeed(ArtifactStore)(makeNoop(overrides))
