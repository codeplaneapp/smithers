import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const smithersSchemaMigrations = sqliteTable("_smithers_schema_migrations", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    appliedAtMs: integer("applied_at_ms").notNull(),
    checksum: text("checksum"),
    destructive: integer("destructive", { mode: "boolean" })
        .notNull()
        .default(false),
    detailsJson: text("details_json"),
});
