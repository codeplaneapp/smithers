/**
 * The two-tier artifact protocol the step cache rides on: publish before the
 * entry, fetch on demand after it.
 *
 * This is the seam that makes a shared cache safe. A cache entry references
 * its large outputs by digest, so an entry that becomes observable while one
 * of those artifacts is still missing hands the next machine a hit it cannot
 * materialize. Bazel states the constraint at
 * `reference/bazel/.../remote/UploadManifest.java:630-633` — "action results
 * may fail to validate server-side if they are accessed before all blobs they
 * refer to are present" — and enforces it by ordering:
 * `findMissingDigests` → upload the missing → upload the `ActionResult` LAST.
 * {@link Service.publish} is that ordering, and `ActionPersistence` calls it
 * before `CacheStore.put`.
 *
 * The read direction is the same protocol in reverse and is deliberately
 * *lazy*: a replay fetches an artifact when materialization actually needs it,
 * not eagerly at lookup, so a metadata-only replay state is representable. The
 * dial that decides which outputs a build wants materialized at all — Bazel's
 * `RemoteOutputChecker` and its `--remote_download_{all,toplevel,minimal}`
 * policy — is out of scope and ticketed
 * (`.smithers/tickets/remote-cache-download-policy.md`).
 *
 * Governing design: `docs/specs/Concepts/Remote Cache.md`.
 *
 * @since 0.1.0
 */
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/**
 * A referenced artifact could not be made durable in the shared tier, so the
 * cache entry that references it must not be published.
 *
 * Failing here is the point: silently publishing the entry anyway is exactly
 * the state the REAPI ordering constraint exists to prevent.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export class ArtifactPublicationFailed extends Schema.TaggedError<ArtifactPublicationFailed>()(
  "@smthrs/engine-store/ArtifactPublicationFailed",
  {
    code: Schema.Literal("artifact_publication_failed"),
    digests: Schema.Array(Schema.String),
    message: Schema.String,
    cause: Schema.optional(
      Schema.Union([
        ArtifactStore.ArtifactStoreError,
        ArtifactStore.ArtifactMissing,
        ArtifactStore.ArtifactCorruption
      ])
    )
  }
) {}

/**
 * The two directions of the artifact protocol: {@link Service.publish} before a
 * cache entry becomes observable, {@link Service.hydrate} when a replay needs
 * bytes this host does not have.
 *
 * The asymmetry in their error types is the design: publishing may fail,
 * because publishing an entry whose artifacts are missing is the unsafe state;
 * hydrating never fails, because a shared tier that is down should cost a run
 * a cache hit, not the run itself.
 *
 * @since 0.1.0
 * @category services
 * @slop
 */
export interface Service {
  /**
   * Makes every digest durable in the shared tier, in REAPI order:
   * `findMissing`, upload what is missing, then confirm nothing is missing
   * any more. Returns only once the shared tier can serve all of them.
   */
  readonly publish: (
    digests: ReadonlyArray<string>
  ) => Effect.Effect<void, ArtifactPublicationFailed, Crypto.Crypto>
  /**
   * Fetches the digests this host is missing from the shared tier and writes
   * them into the local store, reporting whether every digest is now locally
   * resolvable.
   *
   * Best-effort by construction: `false` means "replay still cannot be
   * satisfied", which the caller turns into a real execution. A shared tier
   * that is down must never fail a run that can simply do the work.
   */
  readonly hydrate: (
    digests: ReadonlyArray<string>
  ) => Effect.Effect<boolean, never, Crypto.Crypto>
}

/**
 * Service tag for the two-tier artifact protocol.
 *
 * @since 0.1.0
 * @category services
 * @slop
 */
export class ArtifactSync extends Context.Service<ArtifactSync, Service>()("@smthrs/engine-store/ArtifactSync") {}

/**
 * The single-tier implementation: there is no shared artifact store, so there
 * is nothing to publish and nothing to fetch.
 *
 * This is the default `ActionPersistence` falls back to when the tag is
 * absent, which is what keeps a purely local composition free of any
 * remote-cache machinery.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const makeLocal = (): Service => ({
  publish: Effect.fn("ArtifactSync.publish")(() => Effect.void),
  hydrate: Effect.fn("ArtifactSync.hydrate")((digests) => Effect.succeed(digests.length === 0))
})

/**
 * Provides the single-tier (no shared artifact store) protocol.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layerLocal: Layer.Layer<ArtifactSync> = Layer.succeed(ArtifactSync)(makeLocal())

/**
 * Builds the two-tier protocol over a local and a shared artifact store.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (options: {
  readonly local: ArtifactStore.Service
  readonly remote: ArtifactStore.Service
}): Service => {
  const { local, remote } = options
  const publicationFailed = (
    digests: ReadonlyArray<string>,
    message: string,
    cause?: ArtifactStore.ArtifactStoreError | ArtifactStore.ArtifactMissing | ArtifactStore.ArtifactCorruption
  ) => new ArtifactPublicationFailed({ code: "artifact_publication_failed", digests, message, cause })
  return {
    publish: Effect.fn("ArtifactSync.publish")(function*(digests) {
      if (digests.length === 0) return
      const missing = yield* remote.findMissing(digests).pipe(
        Effect.mapError((cause) => publicationFailed(digests, "the shared tier refused a probe", cause))
      )
      for (const digest of missing) {
        const bytes = yield* local.get(digest).pipe(
          Effect.mapError((cause) =>
            // The blob is referenced by evidence this host just produced, so
            // it should be in this host's own store. If it is not, the
            // evidence is not publishable — and saying so is far better than
            // publishing an entry nobody can replay.
            publicationFailed([digest], "this host cannot read the artifact it recorded", cause)
          )
        )
        yield* remote.put(bytes).pipe(
          Effect.mapError((cause) => publicationFailed([digest], "the shared tier refused an upload", cause))
        )
      }
      if (missing.length === 0) return
      // The confirming re-probe is not paranoia: a tier that accepted the
      // upload but did not durably store it is exactly the state that makes a
      // published entry unreplayable, and it is cheap to rule out — one
      // batched round trip over the set we just wrote.
      const stillMissing = yield* remote.findMissing(missing).pipe(
        Effect.mapError((cause) => publicationFailed(missing, "the shared tier refused a probe", cause))
      )
      if (stillMissing.length > 0) {
        return yield* Effect.fail(
          publicationFailed(stillMissing, "the shared tier did not retain the uploaded artifacts")
        )
      }
    }),
    hydrate: Effect.fn("ArtifactSync.hydrate")(function*(digests) {
      const missing = yield* local.findMissing(digests).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (missing === undefined) return false
      for (const digest of missing) {
        // Read-through, one artifact at a time and only on demand: the remote
        // read is digest-verified by `RemoteArtifacts`, and the local `put`
        // re-addresses the bytes, so a tier serving wrong content cannot get
        // them written into this workspace.
        const written = yield* remote.get(digest).pipe(
          Effect.flatMap((bytes) => local.put(bytes)),
          Effect.option
        )
        if (written._tag === "None") return false
      }
      return true
    })
  }
}

/**
 * Provides the two-tier protocol, taking the local store from the
 * `ArtifactStore` tag and the shared store from the supplied effect.
 *
 * The two tiers cannot both be layers: they inhabit the same tag, so composing
 * them would shadow one with the other.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layer = <E, R>(
  remote: Effect.Effect<ArtifactStore.Service, E, R>
): Layer.Layer<ArtifactSync, E, ArtifactStore.ArtifactStore | R> =>
  Layer.effect(ArtifactSync)(
    Effect.gen(function*() {
      const local = yield* ArtifactStore.ArtifactStore
      const shared = yield* remote
      return make({ local, remote: shared })
    })
  )
