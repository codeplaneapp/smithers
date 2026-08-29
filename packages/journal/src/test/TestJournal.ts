/**
 * Deterministic bundle of the production journal service.
 *
 * This provides the journal and nothing else. A consumer that also needs run
 * state or the step cache composes `@smthrs/run-store/test/TestRunStore` and
 * `@smthrs/step-cache/test/TestCacheStore` over the same database, or takes
 * the whole engine bundle from `@smthrs/engine-store/test/TestStores`.
 *
 * Governing design: `docs/specs/Concepts/Journal Queue.md`.
 *
 * @since 0.1.0
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Layer from "effect/Layer"
import * as Migrations from "../Migrations.ts"
import * as SqlJournal from "../SqlJournal.ts"

/**
 * Options for the deterministic journal bundle.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestJournalOptions {
  readonly capacity?: number
  readonly overflow?: "reject" | "drop-newest" | "drop-oldest"
  readonly batchSize?: number
}

/**
 * Provides the production SQLite journal over an in-memory database.
 * Migrations run before the journal is exposed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options?: TestJournalOptions) =>
  SqlJournal.layer({
    capacity: options?.capacity ?? 1024,
    overflow: options?.overflow ?? "reject",
    batchSize: options?.batchSize
  }).pipe(Layer.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
