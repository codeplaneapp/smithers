/**
 * Deterministic bundle of the production journal service.
 *
 * This provides the journal and nothing else. A consumer that also needs run
 * state or the step cache composes `@smthrs/run-store/test/TestRunStore` and
 * `@smthrs/step-cache/test/TestCacheStore` over the same database, or takes
 * the whole engine bundle from `@smthrs/engine-store/test/TestStores`.
 *
 * Governing design: `docs/pages/concepts/journal.md`.
 *
 * @since 0.1.0
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Layer from "effect/Layer"
import * as Migrations from "../Migrations.ts"
import type * as Redaction from "../Redaction.ts"
import * as SqlJournal from "../SqlJournal.ts"

/**
 * Options for the deterministic journal bundle.
 *
 * Every field forwards to {@link SqlJournal.layer} unchanged, so a suite can
 * exercise index-bound eviction, a custom or noop redactor, and the compaction
 * policy through the bundle instead of hand-assembling the layer stack the
 * bundle exists to hide.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestJournalOptions {
  /** Admission-queue bound and `changes` buffer size. Defaults to 1024. */
  readonly capacity?: number
  /** Policy applied when the admission queue is full. Defaults to `reject`. */
  readonly overflow?: "reject" | "drop-newest" | "drop-oldest"
  /** Entries the queued writer commits per transaction. */
  readonly batchSize?: number
  /** Upper bound on the in-process producer-idempotency index. */
  readonly sourceEventCache?: number
  /** Scrub applied to every `payload` and `meta` before persistence. */
  readonly redact?: Redaction.Redactor
  /** Automatic checkpoint-and-compact policy. Off unless supplied. */
  readonly compaction?: SqlJournal.CompactionPolicy
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
    batchSize: options?.batchSize,
    sourceEventCache: options?.sourceEventCache,
    redact: options?.redact,
    compaction: options?.compaction
  }).pipe(Layer.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
