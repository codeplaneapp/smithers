/**
 * Bun `Jj` implementation.
 *
 * Bun implements the Node child-process API used by the argv-safe jj adapter,
 * so Bun and Node deliberately share the same error classification and
 * interruption finalizer.
 *
 * @since 0.1.0
 */
import type * as Layer from "effect/Layer"
import type { Jj } from "../Jj.ts"
import * as NodeJj from "../node/NodeJj.ts"

/**
 * Provides the `Jj` service backed by the jj CLI under Bun.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<Jj> = NodeJj.layer
