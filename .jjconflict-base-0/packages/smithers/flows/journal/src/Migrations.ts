/**
 * Journal schema migrations.
 *
 * The journal owns two tables: `flows_journal_events` and its event-type
 * index in `0001_initial`, and `flows_journal_checkpoints` in
 * `0002_checkpoints`. Run and
 * attempt state migrate from `@smthrs/run-store`, the step cache from
 * `@smthrs/step-cache`, and the durable deferred/clock tables from
 * `@smthrs/engine-store`; an application composes those sets with this one
 * through `@smthrs/database`'s `Migrations.layer`.
 *
 * Derived contracts: `docs/pages/concepts/journal.md` and
 * `docs/pages/architecture/package-map.md`.
 *
 * @since 0.1.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as Layer from "effect/Layer"
import { initial } from "./migrations/0001_initial.ts"
import { checkpoints } from "./migrations/0002_checkpoints.ts"

/**
 * The journal's namespaced migration set, for composition with the other
 * storage packages.
 *
 * @category migrations
 * @since 0.1.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "journal",
  idOffset: 0,
  migrations: {
    "0001_initial": initial,
    "0002_checkpoints": checkpoints
  }
}

/**
 * Creates the journal's authoritative durable schema.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run([set])

/**
 * Layer that runs journal migrations before exposing the database to journal
 * services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
