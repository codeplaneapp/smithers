import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const smithersMemoryThreads = sqliteTable("_smithers_memory_threads", {
    threadId: text("thread_id").primaryKey(),
    namespace: text("namespace").notNull(),
    title: text("title"),
    metadataJson: text("metadata_json"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
});
