/**
 * `@smthrs/platform-bun`, the Bun Host bundle.
 *
 * `BunHost.layer` composes the closed five-tag Host surface for Bun out of
 * `@effect/platform-bun`'s child-process spawner and fetch-backed `HttpClient`,
 * Effect's runtime-independent `Path`, the Bun `Jj` adapter from
 * `@smthrs/jj`, and `@smthrs/platform-node`'s `AtomicFileSystem`, which is the
 * very layer the Node bundle puts in its own filesystem slot.
 *
 * Two host prerequisites come with it: `@effect/platform-bun`, which both this
 * barrel and `@smthrs/platform-bun/BunHost` import at module load, and a
 * CPython 3 interpreter for the filesystem slot's descriptor-relative helper.
 *
 * @since 1.0.0-rc.0
 */

/**
 * Bun's `FileSystem`, which is `@smthrs/platform-node`'s atomic filesystem.
 * @slop
 */
export * as BunFileSystem from "./BunFileSystem.ts"

/**
 * The complete closed Host bundle for Bun.
 * @slop
 */
export * as BunHost from "./BunHost.ts"
