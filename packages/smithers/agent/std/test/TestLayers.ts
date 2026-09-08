import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import type * as Path from "@smthrs/kernel/Path"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as TestHost from "@smthrs/testing/TestHost"
import { Effect, type PlatformError } from "effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { dirname } from "node:path"
import * as BrowserFileSystem from "../../../flows/platform-browser/src/BrowserFileSystem/index.ts"
import * as PortableSearch from "../src/PortableSearch.ts"
import * as Search from "../src/Search.ts"

/**
 * Provides deterministic host services behind the permission-aware kernel.
 */
export const layer = (options?: {
  readonly files?: Readonly<Record<string, string>>
  readonly commands?: Readonly<
    Record<string, {
      readonly stdout?: string
      readonly stderr?: string
      readonly exitCode?: number
    }>
  >
  readonly seed?: number
}): Layer.Layer<HostServices.HostService | Search.Search, PlatformError.PlatformError> => {
  const memory = TestHost.makeMemoryFs(options?.files)
  // The shared memory fixture predates rename. Supply the publication operations
  // here; Preserve.test exercises their atomicity against the real Node host.
  const fileSystem = BrowserFileSystem.layer({
    ...memory,
    writeFile: async (path, bytes, options) => {
      await memory.stat(dirname(path))
      if (options?.flag === "wx") {
        const exists = await memory.stat(path).then(() => true, () => false)
        if (exists) throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" })
      }
      await memory.writeFile(path, bytes, options)
    },
    rename: async (from, to) => {
      await memory.stat(dirname(to))
      await memory.writeFile(to, await memory.readFile(from))
      await memory.rm(from)
    }
  })
  const host = HostServices.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.merge(TestHost.layer(options), fileSystem),
        GrantStore.layerNoop,
        Workspace.layer("/")
      )
    )
  )
  const search = Layer.effect(
    Search.Search,
    Effect.map(Effect.context<FileSystem.FileSystem | Path.Path>(), PortableSearch.make)
  ).pipe(Layer.provide(host))
  return Layer.merge(host, search)
}
