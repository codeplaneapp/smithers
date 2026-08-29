/**
 * The content-addressed artifact store: bytes addressed by their own digest.
 *
 * `ArtifactStore` is the "content-addressed store for artifacts" the `Cache`
 * service owns in `docs/specs/Specs/Object Model.md`. It is the other half of
 * the step cache: `@smthrs/step-cache` maps a step key to a recorded result,
 * and a recorded result references its large outputs by digest rather than
 * inlining them (`docs/specs/Specs/Input.md`, "large values enter by digest").
 *
 * The package name says what it stores, per the naming rule in
 * `docs/specs/Concepts/Journal Split.md`. It depends on `effect` and
 * `@smthrs/crypto` and nothing else, owns no SQL, and bundles for the browser:
 * host access is Effect's `FileSystem` and `HttpClient` tags, both of which the
 * capability kernel decorates in place.
 *
 * ```ts
 * import { ArtifactStore, CombinedArtifacts, RemoteArtifacts } from "@smthrs/artifacts"
 * import * as Effect from "effect/Effect"
 * import * as FileSystem from "effect/FileSystem"
 *
 * const layer = CombinedArtifacts.layer({
 *   local: Effect.map(FileSystem.FileSystem, (fs) => ArtifactStore.makeFileSystem(fs)),
 *   remote: RemoteArtifacts.make({ endpoint: "https://cache.example.com" })
 * })
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category services
 * @since 0.1.0
 * @slop
 */
export * as ArtifactStore from "./ArtifactStore.ts"

/**
 * @category metrics
 * @since 0.1.0
 * @slop
 */
export * as ArtifactStoreMetrics from "./ArtifactStoreMetrics.ts"

/**
 * @category services
 * @since 0.1.0
 * @slop
 */
export * as ArtifactSweep from "./ArtifactSweep.ts"

/**
 * @category services
 * @since 0.1.0
 * @slop
 */
export * as CombinedArtifacts from "./CombinedArtifacts.ts"

/**
 * @category services
 * @since 0.1.0
 * @slop
 */
export * as RemoteArtifacts from "./RemoteArtifacts.ts"
