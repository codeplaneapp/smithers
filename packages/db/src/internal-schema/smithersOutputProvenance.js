import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const smithersOutputProvenance = sqliteTable(
  "_smithers_output_provenance",
  {
    runId: text("run_id").notNull(),
    outputTable: text("output_table").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull(),
    seq: integer("seq").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.outputTable, t.nodeId, t.iteration] }),
    seqUnique: unique("_smithers_output_provenance_run_seq").on(t.runId, t.seq),
  }),
);
