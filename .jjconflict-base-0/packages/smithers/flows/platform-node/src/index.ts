/**
 * `@smthrs/platform-node`, the Node.js Host bundle.
 *
 * `@effect/platform-node` already ships `FileSystem`, `Path`,
 * `ChildProcessSpawner`, and an Undici-backed `HttpClient` for Node, and
 * `NodeHost.layer` composes the complete closed five-tag Host surface out of
 * them plus the Node `Jj` adapter, which lives in `@smthrs/jj`.
 *
 * Three modules here are implementation rather than composition, because the
 * guarantees Smithers makes about a host are not ones Effect's adapters make on
 * their own. `AtomicFileSystem` performs every filesystem operation relative to
 * a pinned directory descriptor, so a symlink swapped in after authorization
 * cannot redirect it; `ProcessReaper` kills the process groups a crashed
 * incarnation of this host abandoned; `HostLiveness` answers whether a recorded
 * run owner is still running here.
 *
 * `AtomicFileSystem` is `NodeHost`'s filesystem slot, and it executes its
 * syscalls through a CPython 3 helper, so a POSIX host with `python3` at
 * `/usr/bin/python3` is a prerequisite. The layer BUILDS without one and then
 * fails every guarded filesystem call closed with `PermissionDenied`. Windows is
 * unsupported.
 *
 * @since 0.1.0
 */

/** The complete closed Host bundle for Node. */
export * as NodeHost from "./NodeHost.ts"

/** Whether a recorded run owner is still alive on this host. */
export * as HostLiveness from "./HostLiveness.ts"

/** Reaping the process groups a dead incarnation of this host abandoned. */
export * as ProcessReaper from "./ProcessReaper.ts"
