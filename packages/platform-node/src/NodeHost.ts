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
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import type { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as AtomicFileSystem from "./AtomicFileSystem.ts"

/**
 * The Node platform modules Effect ships, re-exported so a program that wants
 * only part of the host has one place to reach for them. `NodeJj` belongs to
 * `@smthrs/jj`; import it from there.
 *
 * @category re-exports
 * @since 0.1.0
 */
export { AtomicFileSystem, NodeChildProcessSpawner, NodeFileSystem, NodeHttpClient }

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
 * Provides the default Node implementations for the whole closed Host surface.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<NodeHost> = Layer.mergeAll(
  platform,
  Layer.provide(NodeChildProcessSpawner.layer, platform),
  NodeHttpClient.layerUndici,
  NodeJj.layer
)
