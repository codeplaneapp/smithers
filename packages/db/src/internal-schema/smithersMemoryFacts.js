import { integer, sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

export const smithersMemoryFacts = sqliteTable("_smithers_memory_facts", {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    schemaSig: text("schema_sig"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    ttlMs: integer("ttl_ms"),
}, (t) => ({
    pk: primaryKey({ columns: [t.namespace, t.key] }),
}));
