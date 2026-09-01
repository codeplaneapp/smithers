/**
 * Two artifact tiers composed into one: local first, remote second, with
 * write-back into the local tier.
 *
 * This is the shape of Bazel's `CombinedCache`
 * (`reference/bazel/.../remote/CombinedCache.java`): a read consults the disk
 * cache, falls back to the remote cache only on a miss, and *uploads what it
 * found back into the disk cache* so the next read is local
 * (`downloadActionResultFromRemote`, lines 230-303). A write goes to both.
 *
 * Deviation from Bazel: policy is declared once by the remote tier rather than
 * threaded through every call. `downloadPolicy` controls prefetch and local
 * materialization; composing only the local tier opts out of shared storage.
 *
 * @since 1.0.0-rc.0
 */
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as ArtifactStore from "./ArtifactStore.ts"
import * as RemoteArtifacts from "./RemoteArtifacts.ts"

/**
 * The two tiers to compose.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface Options {
  /** The fast, machine-local tier. Every read tries this one first. */
  readonly local: ArtifactStore.Service
  /** The shared tier. Consulted only on a local miss; written through on put. */
  readonly remote: ArtifactStore.Service
  /**
   * How long a `put` waits for its opportunistic upload to the shared tier
   * before abandoning it. The local digest is already in hand when the upload
   * starts, so the deadline bounds only how long a stalled remote can delay
   * the answer — an abandoned upload is dropped exactly like a refused one.
   * Defaults to 60 seconds, Bazel's `--remote_timeout` default
   * (`reference/bazel/.../remote/options/RemoteOptions.java`).
   */
  readonly uploadTimeout?: Duration.Input | undefined
  /**
   * How eagerly a read materializes a blob into the local tier. Defaults to
   * the policy the remote tier declares (`RemoteArtifacts.Options.downloadPolicy`),
   * and to `all` for a remote tier that declares none.
   *
   * `all` and `toplevel` both write a fetched blob back into the local tier, so
   * the second read is local; they differ only in whether
   * `@smthrs/engine-store`'s `ArtifactSync.hydrate` prefetches. `minimal`
   * serves the bytes without writing them back, so a host that must not
   * accumulate other machines' artifacts never does.
   */
  readonly downloadPolicy?: RemoteArtifacts.DownloadPolicy | undefined
}

/**
 * The default deadline on the opportunistic upload. 60 seconds is Bazel's
 * `--remote_timeout` default for its remote cache calls.
 */
const defaultUploadTimeout = Duration.seconds(60)

/**
 * Composes a local and a remote artifact store.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const make = (
  options: Options
): Effect.Effect<RemoteArtifacts.Service, ArtifactStore.ArtifactStoreError> =>
  Effect.gen(function*() {
    const { local, remote } = options
    const parsedUploadTimeout = Duration.fromInput(options.uploadTimeout ?? defaultUploadTimeout)
    if (
      Option.isNone(parsedUploadTimeout) ||
      !Number.isFinite(Duration.toMillis(parsedUploadTimeout.value)) ||
      Duration.toMillis(parsedUploadTimeout.value) <= 0
    ) {
      return yield* Effect.fail(
        new ArtifactStore.ArtifactStoreError({
          code: "invalid_configuration",
          message: "invalid combined artifact option: uploadTimeout"
        })
      )
    }
    const uploadTimeout = parsedUploadTimeout.value
    const downloadPolicy = options.downloadPolicy ?? RemoteArtifacts.downloadPolicyOf(remote) ?? "all"
    if (!Schema.is(RemoteArtifacts.DownloadPolicy)(downloadPolicy)) {
      return yield* Effect.fail(
        new ArtifactStore.ArtifactStoreError({
          code: "invalid_configuration",
          message: "invalid combined artifact option: downloadPolicy"
        })
      )
    }
    /**
     * In-flight uploads, keyed by digest. Two settles in one process that spill
     * the same artifact would otherwise both push the same bytes over the
     * network; the second joins the first's `Deferred` instead. The map holds
     * only in-flight work — the entry is removed before the deferred is
     * completed, so a later `put` of the same digest starts a fresh upload
     * rather than replaying a stale outcome.
     */
    const uploads = new Map<string, Deferred.Deferred<ArtifactStore.Digest, ArtifactStore.ArtifactStoreError>>()
    const uploadInterrupted = (): ArtifactStore.ArtifactStoreError =>
      new ArtifactStore.ArtifactStoreError({
        code: "unavailable",
        message: "the shared upload was interrupted before it settled"
      })
    const uploadOnce = (digest: ArtifactStore.Digest, bytes: Uint8Array) =>
      Effect.suspend(() => {
        const joined = uploads.get(digest)
        if (joined !== undefined) return Deferred.await(joined)
        // Registration and settlement are atomic against interruption. The
        // upload itself stays interruptible — that is how the deadline in `put`
        // cuts it short — but everything around it runs masked: interruption
        // striking between registering the deferred and resolving it would
        // otherwise orphan the entry, and every later `put` of the digest would
        // join a deferred nobody will ever complete.
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function*() {
            const deferred = yield* Deferred.make<ArtifactStore.Digest, ArtifactStore.ArtifactStoreError>()
            uploads.set(digest, deferred)
            return yield* restore(remote.put(bytes)).pipe(
              Effect.onExit((exit) => {
                uploads.delete(digest)
                // An interrupted upload resolves the deferred with a typed
                // failure, never with the interruption itself: interruption
                // would tear down every innocent waiter, while a typed refusal
                // is exactly the outcome `put` already drops. The map entry is
                // gone either way, so the next `put` of the digest retries
                // with a fresh upload.
                return Exit.hasInterrupts(exit)
                  ? Deferred.fail(deferred, uploadInterrupted())
                  : Deferred.done(deferred, exit)
              })
            )
          })
        )
      })

    const put: ArtifactStore.Service["put"] = Effect.fn("CombinedArtifacts.put")((bytes: Uint8Array) =>
      Effect.flatMap(ArtifactStore.snapshotBytes(bytes), (snapshot) =>
        Effect.gen(function*() {
          // Local first, and its digest is the answer: the local tier is the one
          // this machine's replays resolve against, so a remote tier that is down
          // must not stop an artifact from being recorded locally.
          const digest = yield* local.put(snapshot)
          yield* Effect.annotateCurrentSpan({ digest })
          // Which means the upload is opportunistic, and a refusal is dropped
          // rather than propagated. Failing here would fail whatever produced the
          // bytes — a step's `settle`, say — because a *cache* was unreachable,
          // which is the opposite of the line above. Nothing depends on this
          // upload: what actually guarantees a shared cache entry's blobs are
          // durable is the publication protocol's `findMissing` → upload →
          // confirm, run before the entry is published. A dropped upload here
          // costs that protocol one re-upload, never correctness. The deadline
          // keeps it opportunistic in time as well: a remote that stalls instead
          // of refusing must not hold the local answer hostage, so the upload is
          // interrupted after `uploadTimeout` and abandoned like any refusal.
          yield* uploadOnce(digest, snapshot).pipe(
            Effect.timeout(uploadTimeout),
            Effect.ignore
          )
          return digest
        }))
    )

    const get: ArtifactStore.Service["get"] = Effect.fn("CombinedArtifacts.get")((digest: string) =>
      Effect.flatMap(ArtifactStore.validateDigest(digest), (validated) =>
        Effect.annotateCurrentSpan({ digest: validated }).pipe(Effect.andThen(
          local.get(validated).pipe(
            // A local miss AND local corruption both fall through to the remote
            // tier. Corruption is the interesting one: the write-back below hands
            // the correct bytes to `local.put`, whose own digest verification finds
            // the mismatched blob and atomically rewrites it, so a read-through
            // heals a corrupt local address instead of failing on it forever.
            Effect.catchTags({
              "@smthrs/artifacts/ArtifactMissing": () =>
                Effect.void,
              "@smthrs/artifacts/ArtifactCorruption": () => Effect.void
            }),
            Effect.flatMap((cached) =>
              cached !== undefined
                ? Effect.succeed(cached)
                // `minimal` reads through without materializing: the caller gets
                // the bytes, the local tier stays exactly as small as it was, and
                // the next read pays the network again. Every other policy writes
                // back, which is what makes the second read local and what heals a
                // corrupt local address.
                : downloadPolicy === "minimal"
                ? remote.get(validated)
                : Effect.tap(remote.get(validated), (bytes) => local.put(bytes))
            )
          )
        )))
    )

    const has: ArtifactStore.Service["has"] = Effect.fn("CombinedArtifacts.has")((digest: string) =>
      Effect.flatMap(ArtifactStore.validateDigest(digest), (validated) =>
        Effect.annotateCurrentSpan({ digest: validated }).pipe(
          Effect.andThen(
            Effect.flatMap(
              local.has(validated),
              (present) =>
                present ? Effect.succeed(true) : remote.has(validated)
            )
          )
        ))
    )

    const findMissing: ArtifactStore.Service["findMissing"] = Effect.fn("CombinedArtifacts.findMissing")(
      (digests: Iterable<string>) =>
        Effect.gen(function*() {
          // The iterable is materialized once: it may be single-pass, and both the
          // annotation and the local probe need it.
          const requested = [...new Set(digests)]
          const validated: Array<ArtifactStore.Digest> = []
          for (const digest of requested) {
            validated.push(yield* ArtifactStore.validateDigest(digest))
          }
          // Missing means missing from BOTH tiers, and the remote probe is asked
          // only about what the local tier could not answer — one network round
          // trip, over the smallest possible set. The result stays a subset of the
          // input because each stage filters the previous stage's output.
          return yield* Effect.annotateCurrentSpan({ count: validated.length }).pipe(
            Effect.andThen(
              Effect.flatMap(
                local.findMissing(validated),
                (missingLocally) =>
                  missingLocally.length === 0 ? Effect.succeed(missingLocally) : remote.findMissing(missingLocally)
              )
            )
          )
        })
    )

    return { put, get, has, findMissing, downloadPolicy }
  })

/**
 * Provides a combined artifact store as the `ArtifactStore` tag.
 *
 * Both tiers are supplied as *effects* rather than layers because they inhabit
 * the same tag: composing two `Layer<ArtifactStore>` would just shadow one
 * with the other. Pair `ArtifactStore.makeFileSystem` (wrapped in
 * `Effect.sync`) or `Effect.map(FileSystem.FileSystem, ...)` with
 * `RemoteArtifacts.make`.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export interface LayerOptions<EL, RL, ER, RR> {
  readonly local: Effect.Effect<ArtifactStore.Service, EL, RL>
  readonly remote: Effect.Effect<ArtifactStore.Service, ER, RR>
  readonly uploadTimeout?: Duration.Input | undefined
  readonly downloadPolicy?: RemoteArtifacts.DownloadPolicy | undefined
}

/**
 * Provides a local-first artifact store backed by local and remote effects.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = <EL, RL, ER, RR>(
  options: LayerOptions<EL, RL, ER, RR>
): Layer.Layer<ArtifactStore.ArtifactStore, EL | ER | ArtifactStore.ArtifactStoreError, RL | RR> =>
  Layer.effect(ArtifactStore.ArtifactStore)(
    Effect.flatMap(
      Effect.all({ local: options.local, remote: options.remote }),
      ({ local, remote }) =>
        make({
          local,
          remote,
          uploadTimeout: options.uploadTimeout,
          downloadPolicy: options.downloadPolicy
        })
    )
  )
