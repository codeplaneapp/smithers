/**
 * @since 0.1.0
 *
 * `@smthrs/platform-bun` — the Bun Host bundle.
 *
 * Bun runs the `@effect/platform-node` adapters unchanged for the filesystem
 * and the child-process spawner, and Effect's own fetch-backed `HttpClient`
 * for the network (`@effect/platform-bun` re-exports all three), so this
 * package adds only one `BunHost.layer` composing the complete closed five-tag
 * Host surface.
 *
 * ```ts
 * import { BunHost } from "@smthrs/platform-bun"
 * ```
 *
 * **Node-only by construction.** The bundle falls back to the
 * `@effect/platform-node` adapters off Bun and resolves `node:` built-ins;
 * `scripts/browser-check.mjs` at the repository root pins that.
 */

/**
 * Bun's `FileSystem`, which is Effect's Node implementation.
 * @slop
 */
export * as BunFileSystem from "./BunFileSystem.ts"

/**
 * The complete closed Host bundle for Bun.
 * @slop
 */
export * as BunHost from "./BunHost.ts"
