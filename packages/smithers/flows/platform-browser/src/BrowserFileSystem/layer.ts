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
 * **Composing this layer is an assertion about `fs`.** The service it provides
 * carries `@smthrs/kernel`'s whole-filesystem isolation attestation, which the
 * kernel accepts on trust: it says that this promises object cannot name any
 * path outside its own volume, so the guarded surface may resolve paths
 * directly instead of through descriptor-relative operations. A mounted ZenFS
 * volume (IndexedDB, OPFS, memory) satisfies it. A host-backed
 * `node:fs/promises` does not — it addresses the whole machine — so passing
 * one is a test-time convenience for a process that is itself the sandbox,
 * never a production composition.
 *
 * {@link make} builds the same service **without** the attestation, for a
 * caller that wants effect's `FileSystem` and no kernel claim attached.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (fs: ZenFsPromisesLike): Layer.Layer<FileSystem.FileSystem> =>
  Layer.succeed(FileSystem.FileSystem)(withIsolatedFileSystem(make(fs)))
