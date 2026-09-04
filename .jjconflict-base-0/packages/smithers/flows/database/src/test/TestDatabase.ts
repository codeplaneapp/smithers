/**
 * In-memory SQLite database layer for tests.
 *
 * @since 0.1.0
 */
import { Layer } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableWriter from "../DurableWriter.ts"
import * as NodeDatabase from "../node/NodeDatabase.ts"

/**
 * Provides the production Node SQLite client and durable writer over a fresh
 * in-memory database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<DurableWriter.DurableWriter | SqlClient.SqlClient> = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: ":memory:" })
)
