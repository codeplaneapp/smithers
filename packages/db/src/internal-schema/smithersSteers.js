import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
/**
 * Durable steering inbox: fire-and-forget user messages queued against a
 * running node, consumed into that node's next agent `generate()` call (first
 * start, retry attempt, or loop iteration) and injected as a user turn before
 * the structured-output schema wrap. A queued steer that is never consumed is
 * expired deterministically when its run reaches a terminal state. The message
 * text is captured into the consuming attempt's persisted `agentConversation`,
 * so this table is only the *pre-consumption* inbox — replay reproduces the
 * injected turn from the attempt metadata, not from this (mutable) table.
 */
export const smithersSteers = sqliteTable("_smithers_steers", {
  steerId: text("steer_id").primaryKey(),
  runId: text("run_id").notNull(),
  nodeId: text("node_id").notNull(),
  message: text("message").notNull(),
  // queued | consumed | expired
  status: text("status").notNull().default("queued"),
  author: text("author"),
  createdAtMs: integer("created_at_ms").notNull(),
  consumedAtMs: integer("consumed_at_ms"),
  consumedByAttempt: integer("consumed_by_attempt"),
  consumedByIteration: integer("consumed_by_iteration"),
  expiredAtMs: integer("expired_at_ms"),
});
