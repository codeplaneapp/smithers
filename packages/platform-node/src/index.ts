/**
 * @since 0.1.0
 *
 * `@smthrs/platform-node` — the Node.js Host bundle.
 *
 * `@effect/platform-node` already ships `FileSystem`, `Path`,
 * `ChildProcessSpawner`, and an Undici-backed `HttpClient` for Node, so this
 * package adds only what Smithers defines on top: one `NodeHost.layer` that
 * composes the complete closed five-tag Host surface — including the Node
 * `Jj` adapter, which lives in `@smthrs/jj`.
 *
 * ```ts
 * import { NodeHost } from "@smthrs/platform-node"
 * ```
 *
 * **Node-only by construction.** The bundle resolves `node:child_process` and
 * friends; `scripts/browser-check.mjs` at the repository root pins that.
 */

/** The complete closed Host bundle for Node. */
export * as NodeHost from "./NodeHost.ts"

/** Whether a recorded run owner is still alive on this host. */
export * as HostLiveness from "./HostLiveness.ts"

/** Reaping the process groups a dead incarnation of this host abandoned. */
export * as ProcessReaper from "./ProcessReaper.ts"
