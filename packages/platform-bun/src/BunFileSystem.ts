/**
 * Bun layer for Effect's `FileSystem` service.
 *
 * This is `@smthrs/platform-node`'s `AtomicFileSystem.layer`, the same
 * implementation the Node bundle puts in its filesystem slot. It carries the
 * kernel's atomic host extension, so `@smthrs/kernel`'s `FileSystem.layer`
 * performs every guarded path operation descriptor-relative and no-follow
 * instead of failing closed.
 *
 * The extension runs its syscalls through a CPython 3 helper, so the host needs
 * an interpreter supporting `O_NOFOLLOW`, `O_DIRECTORY`, and `dir_fd` at
 * `/usr/bin/python3`. A host that keeps python3 somewhere else builds the layer
 * with {@link layerWith} instead. Windows is unsupported.
 *
 * @since 1.0.0-rc.0
 */
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import type { FileSystem } from "effect/FileSystem"
import type * as Layer from "effect/Layer"

/**
 * Provides Bun's filesystem implementation, carrying the kernel's atomic host
 * extension.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layer: Layer.Layer<FileSystem> = AtomicFileSystem.layer

/**
 * Provides the same filesystem against an explicitly configured interpreter and
 * set of byte limits.
 *
 * This is the escape hatch for a host whose python3 is not at
 * `/usr/bin/python3`, such as an alpine or nix image.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerWith: (options: AtomicFileSystem.Options) => Layer.Layer<FileSystem> = AtomicFileSystem.layerWith

/**
 * The interpreter and byte limits {@link layerWith} accepts.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Options = AtomicFileSystem.Options
