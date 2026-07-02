import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `_smithers_integration_deliveries` — dedupe ledger for external integration
 * events (webhooks, polling sources). Before an event is fanned out to waiting
 * runs via `signalRun`, the delivery pipeline attempts an insert-if-new on
 * `(source_id, dedupe_key)`; a redelivery (same webhook retried, same update
 * polled twice) hits the primary key and is dropped.
 *
 *  - `sourceId`      the integration event source (e.g. `github`, `telegram`,
 *                    or a generic webhook source id).
 *  - `dedupeKey`     provider-stable delivery id (GitHub delivery GUID,
 *                    Telegram update_id, payload hash for generic webhooks).
 *  - `eventName`     the smithers signal name (`integration:<service>:<event>`).
 *  - `receivedAtMs`  when the event was first accepted (Unix epoch ms).
 */
export const smithersIntegrationDeliveries = sqliteTable("_smithers_integration_deliveries", {
    sourceId: text("source_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    eventName: text("event_name").notNull(),
    receivedAtMs: integer("received_at_ms").notNull(),
}, (t) => ({
    pk: primaryKey({ columns: [t.sourceId, t.dedupeKey] }),
}));
