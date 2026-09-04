/**
 * Aggregate browser platform services layer.
 *
 * This module defines the `BrowserServices` union and a single `layer` that
 * provides browser-backed child process spawning, filesystem, and path
 * services, mirroring `NodeServices` from `@effect/platform-node`.
 *
 * Unlike `NodeServices.layer`, this one is a **function**: a tab owns which
 * ZenFS backend is mounted and which just-bash instance is wired to it, and the
 * two must be the *same* filesystem or the spawner and the `FileSystem` service
 * will disagree about what exists. The signature says so.
 *
 * `Crypto`, `Stdio`, and `Terminal` are deliberately absent. `effect` core
 * ships no browser implementation of any of them, and `@effect/platform-browser`
 * — which does ship `BrowserCrypto` — is not a dependency of this repository;
 * re-exporting it here would add one. Compose it alongside this layer if you
 * need it.
 *
 * @since 0.1.0
 */
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type { Path } from "effect/Path"
import * as EffectPath from "effect/Path"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as BrowserChildProcessSpawner from "./BrowserChildProcessSpawner/index.ts"
import * as BrowserFileSystem from "./BrowserFileSystem/index.ts"

/**
 * The union of core services provided by the browser platform layer: child
 * process spawning, filesystem, and path services.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type BrowserServices = ChildProcessSpawner | FileSystem | Path

/**
 * Provides the browser implementations of child process spawning, filesystem,
 * and path services.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (options: {
  readonly bash: BrowserChildProcessSpawner.JustBashLike
  readonly fs: BrowserFileSystem.ZenFsPromisesLike
}): Layer.Layer<BrowserServices> =>
  Layer.provideMerge(
    BrowserChildProcessSpawner.layer(options.bash),
    Layer.mergeAll(
      BrowserFileSystem.layer(options.fs),
      EffectPath.layer
    )
  )
