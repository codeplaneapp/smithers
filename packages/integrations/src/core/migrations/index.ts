/**
 * The cursor table's schema migrations.
 *
 * @since 1.0.0
 */
import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import initial from "./0001_integration_cursors.ts"

const migrations = { "0001_integration_cursors": initial }

/**
 * Applies the integration cursor schema migrations.
 *
 * @category migrations
 * @since 1.0.0
 */
export const run = Migrator.make({})({
  loader: Migrator.fromRecord(migrations),
  table: "smithers_integration_migrations"
})

/**
 * Runs {@link run} once as a layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = Layer.effectDiscard(run)
