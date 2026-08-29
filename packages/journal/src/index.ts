/**
 * Durable journal services — the immutable event history and nothing else.
 *
 * Run and attempt state live in `@smthrs/run-store`, sealed step results in
 * `@smthrs/step-cache`, and the durable deferred/clock tables in
 * `@smthrs/engine-store`; see `docs/specs/Concepts/Journal Split.md`.
 *
 * This entry point is browser-bundleable: every service here is written
 * against the driver-neutral `@smthrs/database` contract. The test doubles,
 * which bind a Node SQLite database, live under explicit subpaths:
 *
 * ```ts
 * import { Journal, SqlJournal } from "@smthrs/journal"
 * import * as TestJournal from "@smthrs/journal/test/TestJournal"
 * import * as Notifying from "@smthrs/journal/test/Notifying"
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category events
 * @since 0.1.0
 */
export * as JournalEvent from "./JournalEvent.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as Journal from "./Journal.ts"

/**
 * @category layers
 * @since 0.1.0
 */
export * as SqlJournal from "./SqlJournal.ts"

/**
 * @category metrics
 * @since 0.1.0
 */
export * as JournalMetrics from "./JournalMetrics.ts"

/**
 * @category redaction
 * @since 0.1.0
 */
export * as Redaction from "./Redaction.ts"

/**
 * @category projections
 * @since 0.1.0
 */
export * as Projection from "./Projection.ts"

/**
 * @category models
 * @since 0.1.0
 */
export * as OwnerId from "./OwnerId.ts"

/**
 * @category migrations
 * @since 0.1.0
 */
export * as Migrations from "./Migrations.ts"
