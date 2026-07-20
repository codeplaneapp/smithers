import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `_smithers_docs` — durable markdown work-docs (tickets, plans, specs,
 * proposals) the gateway lists/creates/updates/soft-deletes via the
 * `listTickets`/`createTicket`/`updateTicket`/`deleteTicket` RPCs and that the
 * file-watcher seam (`watchDocsDirectory`) upserts from a `.md` directory.
 *
 *  - `path`          PK; the doc identity (a file path or stable id).
 *  - `kind`          one of `ticket | plan | spec | proposal` (default `ticket`).
 *  - `content`       the full markdown body.
 *  - `contentHash`   `sha256(content)` — the watcher's last-write-wins compare key.
 *  - `status`        rides the sync row so a ticket's status survives reload
 *                    (LOCKED Path A); free-form text (e.g. `todo`/`in-progress`/`done`).
 *  - `updatedAtMs`   last write (Unix epoch ms).
 *  - `deletedAtMs`   soft-delete tombstone; NULL means live. `listTickets`
 *                    filters tombstones and the watcher never materializes them.
 */
export const smithersDocs = sqliteTable("_smithers_docs", {
    path: text("path").primaryKey(),
    kind: text("kind").notNull().default("ticket"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status"),
    updatedAtMs: integer("updated_at_ms").notNull(),
    deletedAtMs: integer("deleted_at_ms"),
});
