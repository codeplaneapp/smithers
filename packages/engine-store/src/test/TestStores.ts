/**
 * Deterministic bundle of every durable store a flow engine composes.
 *
 * The stores split into `@smthrs/journal`, `@smthrs/run-store`, and
 * `@smthrs/step-cache`, each with its own in-memory test layer. An engine
 * needs all of them over ONE database, which is what this layer builds:
 * the composed migration sets from `../Migrations.ts` run first, then the four
 * services bind to the same in-memory SQLite connection.
 *
 * Governing designs: `docs/specs/Concepts/Journal Queue.md`,
 * `docs/specs/Concepts/Run Ownership.md`, and
 * `docs/specs/Concepts/Journal Split.md`.
 *
 * @since 0.1.0
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as PlanStore from "@smthrs/plan/PlanStore"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Layer from "effect/Layer"
import * as Migrations from "../Migrations.ts"
import * as OwnerIdentity from "../OwnerIdentity.ts"

/**
 * Options for the deterministic store bundle.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestStoresOptions {
  readonly capacity?: number
  readonly overflow?: "reject" | "drop-newest" | "drop-oldest"
  readonly batchSize?: number
}

/**
 * An in-memory SQLite database with the complete durable engine schema
 * installed, exposed as `SqlClient` and `DurableWriter`.
 *
 * @category layers
 * @since 0.1.0
 */
export const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

/**
 * Provides the production SQLite journal, run, attempt, and cache services
 * over one in-memory database. Migrations run before any durable service is
 * exposed.
 *
 * `OwnerIdentity.layer` rides along: it is not a store, but it is the other
 * service `EngineStore.make` requires and has no in-memory variant to choose
 * between. The default is used rather than a pinned one so a test observes
 * the same fresh-per-incarnation owner the production composition mints.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options?: TestStoresOptions) =>
  Layer.mergeAll(
    SqlJournal.layer({
      capacity: options?.capacity ?? 1024,
      overflow: options?.overflow ?? "reject",
      batchSize: options?.batchSize
    }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    PlanStore.layer
  ).pipe(Layer.provide(database), Layer.merge(OwnerIdentity.layer))
