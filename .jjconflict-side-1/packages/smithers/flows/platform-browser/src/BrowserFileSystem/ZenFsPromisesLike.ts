/**
 * The structural slice of a ZenFS promises API.
 *
 * @since 0.1.0
 */
import type { ZenFsFileHandleLike } from "./ZenFsFileHandleLike.ts"
import type { ZenFsStatsLike } from "./ZenFsStatsLike.ts"

/**
 * The slice of a ZenFS promises API this module depends on.
 *
 * Satisfied by the **`@zenfs/core`** npm package's `fs.promises` export (and by
 * Node's own `node:fs/promises`, which is what the test suite hands it). We
 * take the object rather than importing the package so the browser bundle
 * decides which backend is mounted (IndexedDB, OPFS, in-memory) before handing
 * it to us.
 *
 * @category models
 * @since 0.1.0
 */
export interface ZenFsPromisesLike {
  readonly open: (path: string, flags: "r") => Promise<ZenFsFileHandleLike>
  readonly readFile: (path: string) => Promise<Uint8Array>
  readonly writeFile: (
    path: string,
    data: Uint8Array,
    options?: { readonly flag?: string; readonly mode?: number }
  ) => Promise<void>
  readonly mkdir: (
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number }
  ) => Promise<unknown>
  readonly readdir: (path: string) => Promise<Array<string>>
  readonly stat: (path: string) => Promise<ZenFsStatsLike>
  /**
   * Stats a path without following a final symlink. Optional because a volume
   * with no links cannot tell the two apart: when it is absent, a recursive
   * `readDirectory` classifies entries with {@link ZenFsPromisesLike.stat}
   * instead. `@zenfs/core` and `node:fs/promises` both provide it.
   */
  readonly lstat?: ((path: string) => Promise<ZenFsStatsLike>) | undefined
  /**
   * Canonicalizes a path, following every symlink on the way. Optional
   * because a purely in-memory volume has no links to follow: when it is
   * absent, `realPath` normalizes lexically instead. `@zenfs/core` and
   * `node:fs/promises` both provide it.
   */
  readonly realpath?: ((path: string) => Promise<string>) | undefined
  readonly rm: (
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean }
  ) => Promise<void>
}
