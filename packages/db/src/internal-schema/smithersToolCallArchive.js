import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const smithersToolCallArchive = sqliteTable(
  "_smithers_tool_call_archive",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    attempt: integer("attempt").notNull(),
    seq: integer("seq").notNull(),
    callToken: text("call_token"),
    toolName: text("tool_name").notNull(),
    inputJson: text("input_json"),
    outputJson: text("output_json"),
    startedAtMs: integer("started_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
    status: text("status").notNull(),
    errorJson: text("error_json"),
    kind: text("kind"),
    sideEffect: integer("side_effect", { mode: "boolean" }),
    idempotent: integer("idempotent", { mode: "boolean" }),
    acceptsIdempotencyKey: integer("accepts_idempotency_key", { mode: "boolean" }),
    hasRevert: integer("has_revert", { mode: "boolean" }),
    idempotencyKey: text("idempotency_key"),
    revertStatus: text("revert_status", {
      enum: ["reverting", "reverted", "revert-failed", "revert-stale"],
    }),
    revertedAtMs: integer("reverted_at_ms"),
    revertErrorJson: text("revert_error_json"),
    forcedPastJson: text("forced_past_json"),
    archivedByOp: text("archived_by_op").notNull(),
    archivedAtMs: integer("archived_at_ms").notNull(),
    archiveReason: text("archive_reason").notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.runId, t.nodeId, t.iteration, t.attempt, t.seq, t.archivedByOp],
    }),
    callTokenUnique: uniqueIndex("_smithers_tool_call_archive_call_token_uidx").on(t.callToken),
  }),
);
