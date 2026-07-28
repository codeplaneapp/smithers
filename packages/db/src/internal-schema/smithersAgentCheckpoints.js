import { foreignKey, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { smithersAttempts } from "./smithersAttempts.js";
import { smithersAgentCheckpointContents } from "./smithersAgentCheckpointContents.js";

export const smithersAgentCheckpoints = sqliteTable(
  "_smithers_agent_checkpoints",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull(),
    attempt: integer("attempt").notNull(),
    sequence: integer("sequence").notNull(),
    contentHash: text("content_hash").notNull(),
    codec: text("codec").notNull(),
    version: integer("version").notNull(),
    agentId: text("agent_id"),
    purpose: text("purpose").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration, t.attempt, t.sequence] }),
    attemptFk: foreignKey({
      columns: [t.runId, t.nodeId, t.iteration, t.attempt],
      foreignColumns: [
        smithersAttempts.runId,
        smithersAttempts.nodeId,
        smithersAttempts.iteration,
        smithersAttempts.attempt,
      ],
    }).onDelete("cascade"),
    contentFk: foreignKey({
      columns: [t.contentHash],
      foreignColumns: [smithersAgentCheckpointContents.contentHash],
    }),
    contentHashIndex: index("_smithers_agent_checkpoints_content_hash_idx").on(t.contentHash),
  }),
);
