import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import type * as Path from "@smthrs/kernel/Path"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as TestHost from "@smthrs/testing/TestHost"
import { Effect, type PlatformError } from "effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
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
  const host = HostServices.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        TestHost.layer(options),
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
