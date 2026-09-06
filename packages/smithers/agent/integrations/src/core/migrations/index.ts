/**
 * The cursor table's schema migrations.
 *
 * The set runs through `@smthrs/database`'s ladder rather than a `Migrator` of
 * its own. Every database this repository opens through `NodeDatabase.layer`
 * records what it has applied in one `flows_migrations` table, and the open
 * refuses a file that carries tables and no such
 * table, which is how a 0.x `smithers.db` is told apart from a 1.0 one. A
 * bespoke ledger left `cursors.db` looking exactly like a 0.x file to its own
 * second open.
 *
 * @since 1.0.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as Layer from "effect/Layer"
import { integrationCursors } from "../../internal/IntegrationCursorMigration.ts"

/**
 * The integration cursor set, in migration id block 8000.
 *
 * The blocks below it are journal `0`, run-store `1000`, step-cache `2000`,
 * engine-store `3000`, plan `4000`, time-travel `5000`, control `6000`,
 * and memory `7000`. A cursor store may share the control database.
 *
 * @category migrations
 * @since 1.0.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "integrations",
  idOffset: DatabaseMigrations.idBlock * 8,
  migrations: { "0001_integration_cursors": integrationCursors }
}

/**
 * Applies the integration cursor schema migrations.
 *
 * @category migrations
 * @since 1.0.0
 */
export const run = DatabaseMigrations.run([set])

/**
 * Runs {@link run} once as a layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = Layer.effectDiscard(run)
