/**
 * Time-travel schema migrations, as a rung on the shared ladder.
 *
 * `SqlTimeTravelStore.make` has always created its tables on build with
 * `CREATE TABLE IF NOT EXISTS`, which is fine for a store standing on its own
 * but is a second door into the schema for a composition that already runs
 * `@smthrs/engine-store`'s migrator. This set is that composition's door: the
 * same DDL, run in the ordered ladder with the rest of the durable schema, and
 * recorded in `flows_migrations` like every other package's.
 *
 * ## Why the lineage index ships here and not in `@smthrs/journal`
 *
 * The index this set adds is over `flows_journal_events.meta_json`, and the
 * journal owns that table — so the obvious home is a second journal migration.
 * It cannot be. `@smthrs/database`'s `Migrations.rejectSkipped` refuses any
 * migration whose id sits below the high-water mark the database already
 * applied, because `Migrator` runs from a single mark and would silently skip
 * it. The journal's reserved id block is `0`–`999` and the plan's is `4000`, so
 * **every** future journal migration is structurally below the mark of any
 * migrated database and would be rejected. Putting the index in the highest
 * block instead is the one placement that both runs and stays ordered. The
 * table stays the journal's; only this index does not.
 *
 * @since 0.1.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as EngineStoreMigrations from "@smthrs/engine-store/Migrations"
import * as Layer from "effect/Layer"
import { migrate } from "./SqlTimeTravelStore.ts"

/**
 * Time travel's namespaced migration set.
 *
 * The block is `5000` — above `@smthrs/plan`'s `4000`, which is what keeps the
 * set runnable on a database the engine ladder already migrated.
 *
 * @category migrations
 * @since 0.1.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "time-travel",
  idOffset: DatabaseMigrations.idBlock * 5,
  migrations: {
    "0001_initial": migrate
  }
}

/**
 * The full durable schema an engine WITH time travel needs, in dependency
 * order: everything `@smthrs/engine-store` composes, then this.
 *
 * @category migrations
 * @since 0.1.0
 */
export const sets: ReadonlyArray<DatabaseMigrations.MigrationSet> = [
  ...EngineStoreMigrations.sets,
  set
]

/**
 * Creates the complete durable schema for an engine with time travel.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run(sets)

/**
 * Layer that installs the complete schema before exposing the database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
