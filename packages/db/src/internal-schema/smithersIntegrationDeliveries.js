import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `_smithers_integration_deliveries` — dedupe ledger for external integration
 * events (webhooks, polling sources). Before an event is fanned out to waiting
 * runs via `signalRun`, the delivery pipeline acquires a leased pending claim
 * on `(source_id, dedupe_key)` and marks it completed only after fan-out.
 *
 *  - `sourceId`      the integration event source (e.g. `github`, `telegram`,
 *                    or a generic webhook source id).
 *  - `dedupeKey`     provider-stable delivery id (GitHub delivery GUID,
 *                    Telegram update_id, payload hash for generic webhooks).
 *  - `eventName`     the smithers signal name (`integration:<service>:<event>`).
 *  - `receivedAtMs`  when the event was first accepted (Unix epoch ms).
 *  - `status`        pending while an owner may deliver; completed after fan-out.
 *  - `claimToken`    current delivery owner (NULL when pending but unclaimed).
 *  - `claimExpiresAtMs` lease deadline for crash recovery.
 *  - `completedAtMs` when fan-out completed (Unix epoch ms).
 */
export const smithersIntegrationDeliveries = sqliteTable("_smithers_integration_deliveries", {
    sourceId: text("source_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    eventName: text("event_name").notNull(),
    receivedAtMs: integer("received_at_ms").notNull(),
    status: text("status").notNull().default("completed"),
    claimToken: text("claim_token"),
    claimExpiresAtMs: integer("claim_expires_at_ms"),
    completedAtMs: integer("completed_at_ms"),
}, (t) => ({
    pk: primaryKey({ columns: [t.sourceId, t.dedupeKey] }),
}));
