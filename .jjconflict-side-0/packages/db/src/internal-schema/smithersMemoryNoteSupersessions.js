import { integer, sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

// Supersession junction: note_id = the SUPERSEDING note; supersedes_id = each
// superseded note (one accepted synthesis → N rows). A junction (not a column on
// the superseded row) keeps every note row immutable — supersession is new
// information, so it is a new row. The primary key is shaped so a future
// generalization to a note-edge store (a `rel` column) stays additive.
export const smithersMemoryNoteSupersessions = sqliteTable("_smithers_memory_note_supersessions", {
    noteId: text("note_id").notNull(),
    supersedesId: text("supersedes_id").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
}, (t) => ({
    pk: primaryKey({ columns: [t.noteId, t.supersedesId] }),
}));
