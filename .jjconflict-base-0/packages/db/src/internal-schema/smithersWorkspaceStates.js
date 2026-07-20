import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const smithersWorkspaceStates = sqliteTable("_smithers_workspace_states", {
    runId: text("run_id").notNull(),
    jjCwd: text("jj_cwd").notNull(),
    jjCommitId: text("jj_commit_id").notNull(),
    jjOperationId: text("jj_operation_id").notNull(),
    jjChangeId: text("jj_change_id"),
    createdAtMs: integer("created_at_ms").notNull(),
}, (t) => ({
    pk: primaryKey({ columns: [t.runId, t.jjCwd, t.jjCommitId] }),
}));
