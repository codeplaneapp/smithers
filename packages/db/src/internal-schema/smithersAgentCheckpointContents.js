import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const smithersAgentCheckpointContents = sqliteTable("_smithers_agent_checkpoint_contents", {
  contentHash: text("content_hash").primaryKey(),
  checkpointJson: text("checkpoint_json").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});
