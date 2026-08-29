/**
 * Bun layer for Effect's `FileSystem` service.
 *
 * Bun uses the same Node-compatible filesystem implementation and atomic
 * helper as the Node host while consumers depend only on the standard
 * `FileSystem` contract.
 *
 * @since 0.1.0
 */
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import type { FileSystem } from "effect/FileSystem"
import type * as Layer from "effect/Layer"

/**
 * Provides Bun's filesystem implementation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<FileSystem> = AtomicFileSystem.layer
