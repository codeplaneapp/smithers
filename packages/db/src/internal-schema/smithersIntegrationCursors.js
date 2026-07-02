import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `_smithers_integration_cursors` — durable per-source cursors for polling
 * integration sources (e.g. the Telegram long-poll `offset`). A polling source
 * loads its cursor on start and persists it after each successful poll so a
 * process restart resumes where it left off instead of re-delivering.
 *
 *  - `sourceId`      the integration event source id (PK).
 *  - `cursor`        opaque cursor string (NULL until the first poll lands).
 *  - `updatedAtMs`   last persist (Unix epoch ms).
 */
export const smithersIntegrationCursors = sqliteTable("_smithers_integration_cursors", {
    sourceId: text("source_id").primaryKey(),
    cursor: text("cursor"),
    updatedAtMs: integer("updated_at_ms").notNull(),
});
