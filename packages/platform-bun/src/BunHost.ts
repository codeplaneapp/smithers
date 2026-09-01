/**
 * Aggregate Bun Host bundle.
 *
 * Runtime-specific dependencies stay inside this package; callers get the same
 * closed five-service Host surface every other bundle provides.
 *
 * There is no Bun shell module: running a command is Effect's
 * `ChildProcessSpawner`, and `@effect/platform-bun`'s implementation is
 * `@effect/platform-node-shared`'s re-exported — the same code on both
 * runtimes, so no runtime detection is needed here.
 *
 * There is no Bun HTTP module either: outgoing requests are Effect's
 * `HttpClient`, and `@effect/platform-bun/BunHttpClient` is Effect's own
 * fetch-backed implementation. Bun reaches for it directly rather than
 * borrowing a browser package to get at `fetch`. The one thing configured here
 * is `redirect: "manual"`, so the runtime never walks to a second origin
 * behind the capability kernel's back; following a redirect is
 * `@smthrs/kernel`'s guarded `HttpClient.layer`, which rechecks every hop.
 *
 * The filesystem slot is `@smthrs/platform-node`'s `AtomicFileSystem`, byte for
 * byte the layer `NodeHost` uses, so a guarded path operation is
 * descriptor-relative and no-follow on both runtimes.
 *
 * @since 1.0.0-rc.0
 */
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient"
import type { Jj } from "@smthrs/jj"
import * as BunJj from "@smthrs/jj/bun/BunJj"
import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import type { HostServiceIds } from "@smthrs/kernel/HostServices"
import type * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as BunFileSystem from "./BunFileSystem.ts"

/**
 * Bun platform modules for selectively providing individual services.
 *
 * `AtomicFileSystem` is here for the same reason `NodeHost` re-exports it: it
 * owns the only configuration escape hatch the filesystem slot has, and a Bun
 * program whose python3 is not at `/usr/bin/python3` needs to reach
 * `AtomicFileSystem.layerWith` without hand-composing the other four tags.
 *
 * `BunJj` is deliberately absent: it belongs to `@smthrs/jj` and is imported
 * from there, never re-exported here.
 *
 * @category re-exports
 * @since 1.0.0-rc.0
 * @slop
 */
export { AtomicFileSystem, BunChildProcessSpawner, BunFileSystem, BunHttpClient }

/**
 * The complete closed Host service union provided by Bun.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type BunHost = FileSystem | Path.Path | ChildProcessSpawner | Jj | HttpClient

/**
 * Stable implementation identities keyed by the closed Host service slots.
 *
 * Each value names the module actually behind that slot. They are identity
 * tokens rather than import specifiers: the filesystem entry is
 * `@smthrs/platform-node/AtomicFileSystem` because that is the implementation,
 * even though a consumer reaches it through `@smthrs/platform-bun`.
 *
 * Nothing digests them yet. `@smthrs/plan`'s step key carries a `layers`
 * component these values are meant to feed, but no planner derives it from a
 * host bundle today, so changing one invalidates no cached step.
 *
 * The keys are written as literals rather than `HostServiceIds` positions so
 * that reordering the closed list cannot silently pair a slot with another
 * slot's implementation.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export const implementationIds: Readonly<Record<(typeof HostServiceIds)[number], string>> = {
  "effect/FileSystem": "@smthrs/platform-node/AtomicFileSystem",
  "effect/Path": "effect/Path",
  "effect/process/ChildProcessSpawner": "@effect/platform-bun/BunChildProcessSpawner",
  "@smthrs/jj/Jj": "@smthrs/jj/bun/BunJj",
  "effect/HttpClient": "@effect/platform-bun/BunHttpClient"
}

/** The two services `BunChildProcessSpawner` resolves paths and files with. */
const platform = Layer.mergeAll(BunFileSystem.layer, Path.layer)

/** Effect's fetch client, told never to follow a redirect on its own. */
const layerHttpClient: Layer.Layer<HttpClient> = Layer.provide(
  BunHttpClient.layer,
  Layer.succeed(BunHttpClient.RequestInit)({ redirect: "manual" })
)

/**
 * Provides all five Bun Host services, including the runtime-independent Path
 * service.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layer: Layer.Layer<BunHost> = Layer.mergeAll(
  platform,
  Layer.provide(BunChildProcessSpawner.layer, platform),
  BunJj.layer,
  layerHttpClient
)

/**
 * Provides all five Bun Host services bound to one absolute repository root.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerAt = (root: string): Layer.Layer<BunHost> =>
  Layer.mergeAll(
    platform,
    Layer.provide(BunChildProcessSpawner.layer, platform),
    BunJj.layerAt(root),
    layerHttpClient
  )

/**
 * Provides the Bun host with process containment turned on.
 *
 * Bun runs Effect's Node child-process implementation, so containment is the
 * same story it is under Node: `@smthrs/kernel`'s `ContainedSpawner` gives
 * every child an escalation deadline and a ledger entry, and
 * `ProcessReaper` sweeps the entries a crashed incarnation of this host left
 * behind. The reaper module lives in `@smthrs/platform-node` because the calls
 * it makes — `process.kill` and `taskkill` — are Node's, and Bun implements
 * them unchanged.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerContained = (
  options?: ContainedSpawner.Options & ProcessReaper.Options
): Layer.Layer<BunHost, never, ProcessLedger.ProcessLedger> =>
  Layer.mergeAll(
    platform,
    layerHttpClient,
    // jj goes through the CONTAINED spawner here, not around it, exactly as in
    // `NodeHost.layerContained`: a jj child that starts its own process leads
    // no recorded group, is in no ledger, and outlives the host that ran it.
    Layer.provideMerge(
      BunJj.layerSpawner,
      Layer.provide(
        ContainedSpawner.layer({ platform: process.platform, ...options }),
        Layer.provide(BunChildProcessSpawner.layer, platform)
      )
    )
  ).pipe(Layer.provideMerge(ProcessReaper.layer(options)))

/**
 * Provides the contained Bun host bound to one absolute repository root.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerContainedAt = (
  root: string,
  options?: ContainedSpawner.Options & ProcessReaper.Options
): Layer.Layer<BunHost, never, ProcessLedger.ProcessLedger> =>
  Layer.mergeAll(
    platform,
    layerHttpClient,
    Layer.provideMerge(
      BunJj.layerSpawnerAt(root),
      Layer.provide(
        ContainedSpawner.layer({ platform: process.platform, ...options }),
        Layer.provide(BunChildProcessSpawner.layer, platform)
      )
    )
  ).pipe(Layer.provideMerge(ProcessReaper.layer(options)))
