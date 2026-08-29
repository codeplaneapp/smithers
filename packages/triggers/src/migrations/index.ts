/** @since 0.1.0 */
import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import initial from "./0001_triggers.ts"
import reservationLease from "./0002_reservation_lease.ts"

const migrations = { "0001_triggers": initial, "0002_reservation_lease": reservationLease }

/**
 * Applies the triggers schema migrations.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = Migrator.make({})({ loader: Migrator.fromRecord(migrations), table: "flows_trigger_migrations" })

/**
 * Runs {@link run} once as a layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
