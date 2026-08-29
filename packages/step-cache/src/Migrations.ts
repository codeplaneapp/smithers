/**
 * Step cache schema migrations.
 *
 * This package owns `flows_step_cache` and nothing else. It reserves migration
 * id block `2000` so its ids can never collide with the journal's or the run
 * store's — see `@smthrs/database`'s `Migrations` for how the blocks compose.
 *
 * Derived contracts: `docs/specs/Concepts/Step Keys.md` and
 * `docs/specs/Concepts/Journal Split.md`.
 *
 * @since 0.1.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as Layer from "effect/Layer"
import initial from "./migrations/0001_initial.ts"

/**
 * The step cache's namespaced migration set, for composition with the other
 * storage packages.
 *
 * @category migrations
 * @since 0.1.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "step-cache",
  idOffset: DatabaseMigrations.idBlock * 2,
  migrations: {
    "0001_initial": initial
  }
}

/**
 * Creates the step cache schema.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run([set])

/**
 * Layer that runs step-cache migrations before exposing the database to the
 * cache service.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
