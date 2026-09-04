/**
 * Aggregate Node.js Host bundle.
 *
 * This module defines the `NodeHost` service union and a single `layer` that
 * provides the closed Host surface backed by Node: `@effect/platform-node`'s
 * filesystem, child-process spawner and Undici `HttpClient`, Effect's `Path`,
 * and the Node `Jj` adapter from its own package. Use the layer when a Node
 * program wants every host capability from one place; use the individual
 * modules when a program should only be able to reach part of the host.
 *
 * There is no Node HTTP module either: outgoing requests are Effect's
 * `HttpClient`, and `@effect/platform-node` already ships the Undici-backed
 * implementation. Undici follows no redirect unless a redirect interceptor is
 * installed, so every hop stays visible to `@smthrs/kernel`'s decorator.
 *
 * There is no Node shell module: running a command is Effect's
 * `ChildProcessSpawner`, and `@effect/platform-node` already ships the
 * implementation.
 *
 * @since 0.1.0
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import type { Jj, JjError } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import type * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as AtomicFileSystem from "./AtomicFileSystem.ts"
import * as ProcessReaper from "./ProcessReaper.ts"

/**
 * The Node platform modules Effect ships, re-exported so a program that wants
 * only part of the host has one place to reach for them. `NodeJj` belongs to
 * `@smthrs/jj`; import it from there.
 *
 * `NodeCrypto` is here for a different reason than the rest. `Crypto` is not a
 * Host service — it carries no host authority the kernel could attenuate, so
 * it is not in {@link NodeHost} and not in the closed list — but every durable
 * composition needs one, and a program that already depends on this package
 * for its host should not have to add a second dependency for the digest.
 *
 * @category re-exports
 * @since 0.1.0
 */
export { AtomicFileSystem, NodeChildProcessSpawner, NodeCrypto, NodeFileSystem, NodeHttpClient, ProcessReaper }

/**
 * The union of host services provided by the Node host layer.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeHost = FileSystem | Path.Path | ChildProcessSpawner | Jj | HttpClient

/** The two services `NodeChildProcessSpawner` resolves paths and files with. */
const platform = Layer.mergeAll(AtomicFileSystem.layer, Path.layer)

/**
 * What a caller may configure about a contained Node host.
 *
 * `platform` is deliberately absent. `ContainedSpawner.Options` declares it so a
 * caller that supplies its own spawner can describe one, but here the spawner
 * IS Effect's Node spawner, which detaches by `process.platform` whatever a
 * record claims. A caller-supplied `"win32"` on a POSIX host would therefore
 * record `pgid: null` for a child that really does lead a group, and
 * {@link ProcessReaper.reap} would retire that record as `no-group` and leave
 * the orphan running forever — a durable lie rather than a compile error.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ContainedOptions = Omit<ContainedSpawner.Options, "platform"> & ProcessReaper.Options

/**
 * The spawner half of {@link ContainedOptions}, with the REAL platform last.
 *
 * Split from the reaper half rather than passed as one merged object, so a
 * property meant for one of them can never be read by the other.
 */
const containment = (options?: ContainedOptions): ContainedSpawner.Options => ({
  graceMs: options?.graceMs,
  platform: process.platform
})

/** The reaper half of {@link ContainedOptions}. */
const reaping = (options?: ContainedOptions): ProcessReaper.Options => ({
  ownerPid: options?.ownerPid,
  system: options?.system
})

/**
 * Provides the default Node implementations for the whole closed Host surface.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<NodeHost, JjError> = Layer.mergeAll(
  platform,
  Layer.provide(NodeChildProcessSpawner.layer, platform),
  NodeHttpClient.layerUndici,
  NodeJj.layer
)

/**
 * Provides the Node host with `Jj` bound to one absolute repository root.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerAt = (repositoryRoot: string): Layer.Layer<NodeHost, JjError> =>
  Layer.mergeAll(
    platform,
    Layer.provide(NodeChildProcessSpawner.layer, platform),
    NodeHttpClient.layerUndici,
    NodeJj.layerAt(repositoryRoot)
  )

/**
 * Provides the Node host with process containment turned on.
 *
 * The difference from {@link layer} is what happens to a spawned process when
 * its run stops. Under {@link layer} a child is signalled when its scope
 * closes and then waited for, forever if it ignores `SIGTERM`, and a host that
 * dies without closing its scopes abandons every child it started. This layer
 * gives each child an escalation deadline and records it in the
 * `ProcessLedger`, then sweeps the records a previous incarnation of the same
 * host left behind before it hands the host over
 * ({@link ProcessReaper.reap}).
 *
 * jj is contained here too: `layerContained` builds the `Jj` service over the
 * same spawner rather than letting it start its own children, so a `jj`
 * invocation a crashed host left running is a record the next incarnation
 * reaps like any other.
 *
 * The ledger is a requirement rather than a default because the durable half
 * of containment is only as good as the journal underneath it:
 * `ProcessLedger.layer` inherits a crashed incarnation's processes,
 * `ProcessLedger.layerMemory` contains this incarnation and nothing more, and
 * the choice belongs to the program that knows which it has.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerContained = (
  options?: ContainedOptions
): Layer.Layer<NodeHost, JjError, ProcessLedger.ProcessLedger> => {
  const spawner = Layer.provide(
    ContainedSpawner.layer(containment(options)),
    Layer.provide(NodeChildProcessSpawner.layer, platform)
  )
  return Layer.mergeAll(
    platform,
    NodeHttpClient.layerUndici,
    // jj goes through the CONTAINED spawner here, not around it. `NodeJj.layer`
    // spawns its own children, which is right for a host that has no spawner
    // to offer, but under containment it would mean a `jj` that leads no
    // recorded process group, appears in no ledger, and survives the
    // incarnation that started it.
    Layer.provideMerge(NodeJj.layerSpawner, spawner)
  ).pipe(Layer.provideMerge(ProcessReaper.layer(reaping(options))))
}

/**
 * Provides the contained Node host with `Jj` bound to one absolute repository
 * root.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerContainedAt = (
  repositoryRoot: string,
  options?: ContainedOptions
): Layer.Layer<NodeHost, JjError, ProcessLedger.ProcessLedger> => {
  const spawner = Layer.provide(
    ContainedSpawner.layer(containment(options)),
    Layer.provide(NodeChildProcessSpawner.layer, platform)
  )
  return Layer.mergeAll(
    platform,
    NodeHttpClient.layerUndici,
    Layer.provideMerge(NodeJj.layerSpawnerAt(repositoryRoot), spawner)
  ).pipe(Layer.provideMerge(ProcessReaper.layer(reaping(options))))
}
