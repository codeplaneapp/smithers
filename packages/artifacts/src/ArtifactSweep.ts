/**
 * The sweep half of artifact garbage collection: enumerate this host's blobs
 * and delete one, fenced by its age.
 *
 * This surface is deliberately NOT part of `ArtifactStore.Service`. The store
 * contract is shared by memory, filesystem, and network tiers, and a remote
 * tier can neither enumerate its address space nor accept a delete — Bazel
 * draws the same line: its disk-cache collector
 * (`reference/bazel/.../remote/disk/DiskCacheGarbageCollector.java`) walks the
 * local directory, while the remote tier owns its own retention. Only the
 * host-local filesystem store implements this.
 *
 * The *policy* — which digests are live, how old a dead blob must be before it
 * goes — belongs to the engine composition, which is the only place the
 * durable roots (attempt rows, cache entries) are visible. This module ships
 * mechanics alone, mirroring the store/boundary split
 * (`docs/specs/Concepts/Remote Cache.md`).
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as ArtifactStore from "./ArtifactStore.ts"
import * as ArtifactLocks from "./internal/ArtifactLocks.ts"

/**
 * One enumerated blob: its content address, when it was last written or
 * freshened, and its size.
 *
 * `modifiedAtMs` is the age evidence a sweep fences on — the same signal git
 * (`git prune --expire`) and Bazel's disk-cache collector read, because it is
 * the one timestamp a filesystem maintains without any bookkeeping of ours.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface BlobStat {
  readonly digest: string
  readonly modifiedAtMs: number
  readonly sizeBytes: number
}

/**
 * Fencing predicate for a sweep deletion.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RemoveOptions {
  /**
   * Deletes the blob only while its mtime is still at or before this bound.
   * A blob freshened after the caller computed its live set — a concurrent
   * `put` re-referencing the same bytes — fails the fence and survives, the
   * same shape as `CacheStore.evict`'s `ifRecordedBy`: the guard rides in the
   * delete, never in a prior read alone.
   */
  readonly ifUnmodifiedSinceMs?: number | undefined
}

/**
 * Host-local blob enumeration and fenced deletion.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Service {
  /**
   * Every content-addressed blob this host's store currently holds. In-flight
   * `.tmp-*` scratch files, foreign files, and blobs whose age cannot be
   * measured are excluded — what the sweep cannot judge it must not touch.
   */
  readonly inventory: Effect.Effect<Array<BlobStat>, ArtifactStore.ArtifactStoreError>
  /**
   * Deletes the blob at `digest`, returning whether bytes were removed. A
   * missing blob reports `false` rather than failing, so a crashed and
   * re-run sweep converges instead of erroring on its own progress.
   */
  readonly remove: (
    digest: string,
    options?: RemoveOptions
  ) => Effect.Effect<boolean, ArtifactStore.ArtifactStoreError>
}

/**
 * Service tag for host-local artifact sweeping.
 *
 * The identity string equals this module's package path, per the house rule
 * that a new identity is the defining module path.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class ArtifactSweep extends Context.Service<ArtifactSweep, Service>()("@smthrs/artifacts/ArtifactSweep") {}

const error = (message: string, cause?: unknown): ArtifactStore.ArtifactStoreError =>
  new ArtifactStore.ArtifactStoreError({
    code: "unavailable",
    message,
    ...(cause === undefined ? {} : { cause })
  })

const hostFailure = (cause: unknown): ArtifactStore.ArtifactStoreError =>
  error(`the host filesystem refused a sweep operation: ${String(cause)}`, cause)

const isNotFound = (cause: unknown): boolean =>
  cause instanceof PlatformError.PlatformError && cause.reason._tag === "NotFound"

/** The default objects directory, shared with `ArtifactStore.makeFileSystem`. */
const defaultDirectory = ".flows/objects"

/**
 * Builds the filesystem-backed sweep surface over the same objects directory
 * an `ArtifactStore.makeFileSystem` publishes into.
 *
 * Enumeration is conservative by construction. Only paths in the store's
 * canonical fanout shape — `xx/<digest>` with `xx` equal to the digest's
 * two-hex prefix — are blobs; anything else in the directory (a temp file, a
 * foreign file, a fanout directory itself) is skipped, never deleted. A blob
 * that vanishes between listing and stat was removed by someone else and is
 * likewise skipped.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeFileSystem = (
  fs: FileSystem.FileSystem,
  options: ArtifactStore.FileSystemOptions = {}
): Service => {
  const directory = options.directory ?? defaultDirectory
  const blobPath = (digest: string): string => `${directory}/${digest.slice(0, 2)}/${digest}`

  const inventory: Service["inventory"] = Effect.gen(function*() {
    // A store that never published anything has no directory; that is an
    // empty inventory, not a failure.
    const entries = yield* fs.readDirectory(directory, { recursive: true }).pipe(
      Effect.catch((cause) =>
        isNotFound(cause)
          ? Effect.succeed([] as ReadonlyArray<string>)
          : Effect.fail(hostFailure(cause))
      )
    )
    const blobs: Array<BlobStat> = []
    for (const entry of entries) {
      if (entry.includes(".tmp-")) continue
      const separator = entry.indexOf("/")
      if (separator === -1) continue
      const fan = entry.slice(0, separator)
      const digest = entry.slice(separator + 1)
      if (!/^[0-9a-f]{64}$/.test(digest) || fan !== digest.slice(0, 2)) continue
      // The stat is per-candidate and tolerant: a blob another process
      // removed between the listing and here simply is not in the
      // inventory, and one whose mtime the host cannot report offers no
      // age evidence, so the sweep must never judge it.
      const info = yield* fs.stat(`${directory}/${entry}`).pipe(Effect.option)
      if (Option.isNone(info) || info.value.type !== "File") continue
      const mtime = Option.getOrUndefined(info.value.mtime)
      if (mtime === undefined) continue
      blobs.push({
        digest,
        modifiedAtMs: mtime.getTime(),
        sizeBytes: Number(info.value.size)
      })
    }
    return blobs
  })

  const remove: Service["remove"] = Effect.fn("ArtifactSweep.remove")((digest, removeOptions) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({ digest })
      yield* ArtifactStore.validateDigest(digest)
      return yield* ArtifactLocks.withDigest(
        fs,
        digest,
        Effect.gen(function*() {
          const path = blobPath(digest)
          const bound = removeOptions?.ifUnmodifiedSinceMs
          if (bound !== undefined) {
            const info = yield* fs.stat(path).pipe(Effect.option)
            // Already gone is a completed deletion, and an unmeasurable mtime is
            // no proof of age: both refuse rather than delete.
            if (Option.isNone(info)) return false
            const mtime = Option.getOrUndefined(info.value.mtime)
            if (mtime === undefined || mtime.getTime() > bound) return false
          }
          return yield* fs.remove(path).pipe(
            Effect.as(true),
            // The blob may have been removed between the fence and here; only a
            // refusal over bytes that still exist is a host failure.
            Effect.catch((cause) =>
              fs.exists(path).pipe(
                Effect.mapError((probeCause) => hostFailure({ remove: cause, existenceProbe: probeCause })),
                Effect.flatMap((present) => present ? Effect.fail(hostFailure(cause)) : Effect.succeed(false))
              )
            )
          )
        })
      )
    })
  )

  return { inventory, remove }
}

/**
 * Provides the filesystem-backed sweep surface.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerFileSystem = (
  options: ArtifactStore.FileSystemOptions = {}
): Layer.Layer<ArtifactSweep, never, FileSystem.FileSystem> =>
  Layer.effect(ArtifactSweep)(Effect.map(FileSystem.FileSystem, (fs) => makeFileSystem(fs, options)))

/**
 * Builds a sweep surface whose every operation fails as unavailable, with
 * per-method overrides.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => ({
  inventory: Effect.fail(error("inventory is unavailable")),
  remove: Effect.fn("ArtifactSweep.remove")(() => Effect.fail(error("remove is unavailable"))),
  ...overrides
})

/**
 * Provides a no-op sweep surface.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ArtifactSweep> =>
  Layer.succeed(ArtifactSweep)(makeNoop(overrides))
