import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const smithersMemoryMessages = sqliteTable("_smithers_memory_messages", {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(),
    role: text("role").notNull(),
    contentJson: text("content_json").notNull(),
    runId: text("run_id"),
    nodeId: text("node_id"),
    createdAtMs: integer("created_at_ms").notNull(),
});
