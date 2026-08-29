/**
 * Durable engine schema migrations.
 *
 * Engine-store owns `flows_deferred_completions` and `flows_clock_deadlines`:
 * the persisted `DurableDeferred` / `DurableClock` state that
 * `internal/DeferredPersistence` operates, and that no other package reads.
 * It reserves migration id block `3000`.
 *
 * Because engine-store composes the journal, the run store, and the step
 * cache, {@link sets} is also the full durable schema an engine needs, and
 * {@link layer} installs it in dependency order.
 *
 * Derived contracts: `docs/specs/Concepts/Vendored Workflow Engine.md` and
 * `docs/specs/Concepts/Journal Split.md`.
 *
 * @since 0.1.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as PlanMigrations from "@smthrs/plan/Migrations"
import * as RunStoreMigrations from "@smthrs/run-store/Migrations"
import * as StepCacheMigrations from "@smthrs/step-cache/Migrations"
import * as Layer from "effect/Layer"
import initial from "./migrations/0001_initial.ts"
import selectionStore from "./migrations/0002_selection_store.ts"

/**
 * Engine-store's own namespaced migration set.
 *
 * @category migrations
 * @since 0.1.0
 * @slop
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "engine-store",
  idOffset: DatabaseMigrations.idBlock * 3,
  migrations: {
    "0001_initial": initial,
    "0002_selection_store": selectionStore
  }
}

/**
 * Every migration set a durable engine needs, in dependency order: journal
 * events, run and attempt state, the step cache, the engine's own deferred and
 * clock tables, then the persisted plan.
 *
 * The plan set comes LAST because its id block (`4000`) is the highest:
 * `Migrator` decides what to run from a single high-water mark, so a set whose
 * ids sit below an already-applied one would be assumed done and skipped. The
 * loader rejects that ordering outright rather than silently missing a table.
 *
 * @category migrations
 * @since 0.1.0
 * @slop
 */
export const sets: ReadonlyArray<DatabaseMigrations.MigrationSet> = [
  JournalMigrations.set,
  RunStoreMigrations.set,
  StepCacheMigrations.set,
  set,
  PlanMigrations.set
]

/**
 * Creates the complete durable engine schema.
 *
 * @category migrations
 * @since 0.1.0
 * @slop
 */
export const run = DatabaseMigrations.run(sets)

/**
 * Layer that installs the complete durable engine schema before exposing the
 * database to any durable service.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = Layer.effectDiscard(run)
