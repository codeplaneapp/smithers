import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Append-only knowledge notes — the sibling record type to _smithers_memory_facts.
// Facts are mutable KV (upsert); notes are immutable rows. `status` is the ONE
// deliberate exception to append-only (the human gate writes an answer about an
// existing note); everything else on a row never changes after insert.
export const smithersMemoryNotes = sqliteTable("_smithers_memory_notes", {
  id: text("id").primaryKey(),
  namespace: text("namespace").notNull(),
  body: text("body").notNull(),
  // Optional, nullable, policy-free labels the engine never interprets.
  kind: text("kind"),
  tagsJson: text("tags_json"),
  author: text("author"),
  status: text("status").notNull().default("accepted"),
  statusChangedAtMs: integer("status_changed_at_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  // Provenance (P1): nullable run coordinates, stamped by the writer.
  runId: text("run_id"),
  nodeId: text("node_id"),
  iteration: integer("iteration"),
});
