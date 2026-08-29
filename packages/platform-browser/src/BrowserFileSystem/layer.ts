/**
 * The `FileSystem` layer over a ZenFS-shaped backend.
 *
 * @since 0.1.0
 */
import { withIsolatedFileSystem } from "@smthrs/kernel/FileSystem"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { make } from "./make.ts"
import type { ZenFsPromisesLike } from "./ZenFsPromisesLike.ts"

/**
 * Provides the `FileSystem` service backed by a ZenFS-shaped promises API.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (fs: ZenFsPromisesLike): Layer.Layer<FileSystem.FileSystem> =>
  Layer.succeed(FileSystem.FileSystem)(withIsolatedFileSystem(make(fs)))
