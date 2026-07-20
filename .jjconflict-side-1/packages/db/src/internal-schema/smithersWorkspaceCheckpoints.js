import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const smithersWorkspaceCheckpoints = sqliteTable("_smithers_workspace_checkpoints", {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    attempt: integer("attempt").notNull(),
    seq: integer("seq").notNull(),
    jjCwd: text("jj_cwd").notNull(),
    jjCommitId: text("jj_commit_id").notNull(),
    source: text("source").notNull(),
    tier: integer("tier").notNull(),
    label: text("label"),
    toolUseId: text("tool_use_id"),
    createdAtMs: integer("created_at_ms").notNull(),
}, (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration, t.attempt, t.seq] }),
}));
