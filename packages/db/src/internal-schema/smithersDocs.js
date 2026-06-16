import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const smithersDocs = sqliteTable("_smithers_docs", {
    path: text("path").primaryKey(),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    deletedAtMs: integer("deleted_at_ms"),
});
