import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { watchDocsDirectory } from "../src/docWatcher.js";
import { sha256Hex } from "../src/sha256Hex.js";

function createDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { sqlite, adapter: new SmithersDb(db) };
}

describe("_smithers_docs adapter", () => {
    test("upsertDoc → listDocs returns live rows; softDeleteDoc tombstones (never listed)", async () => {
        const { adapter } = createDb();
        const content = "# A\n\n## Summary\nfirst";
        await adapter.upsertDoc({
            path: "a",
            kind: "ticket",
            content,
            contentHash: sha256Hex(content),
            status: "todo",
            updatedAtMs: 1000,
            deletedAtMs: null,
        });
        await adapter.upsertDoc({
            path: "b",
            kind: "ticket",
            content: "# B",
            contentHash: sha256Hex("# B"),
            status: "done",
            updatedAtMs: 2000,
            deletedAtMs: null,
        });

        let rows = await adapter.listDocs();
        // Newest-updated first.
        expect(rows.map((r) => r.path)).toEqual(["b", "a"]);
        expect(rows[1].status).toBe("todo");
        expect(rows[0].contentHash).toBe(sha256Hex("# B"));

        // Soft-delete `b` → it disappears from listDocs but getDoc still sees it.
        await adapter.softDeleteDoc("b", 3000);
        rows = await adapter.listDocs();
        expect(rows.map((r) => r.path)).toEqual(["a"]);
        const tomb = await adapter.getDoc("b");
        expect(tomb?.deletedAtMs).toBe(3000);

        // kind filter
        await adapter.upsertDoc({
            path: "plan-1",
            kind: "plan",
            content: "# plan",
            contentHash: sha256Hex("# plan"),
            status: null,
            updatedAtMs: 4000,
            deletedAtMs: null,
        });
        expect((await adapter.listDocs("ticket")).map((r) => r.path)).toEqual(["a"]);
        expect((await adapter.listDocs("plan")).map((r) => r.path)).toEqual(["plan-1"]);
    });
});

describe("watchDocsDirectory (file → _smithers_docs reconcile)", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "smithers-docs-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("sync() upserts *.md files; last-write-wins on hash mismatch; identical content is a no-op", async () => {
        const { adapter } = createDb();
        let clock = 100;
        writeFileSync(join(dir, "feat-x.md"), "# Feat X\n\nfirst body");
        writeFileSync(join(dir, "notes.txt"), "ignored — not markdown");

        const watcher = watchDocsDirectory(adapter, {
            dir,
            kind: "ticket",
            defaultStatus: "todo",
            nowMs: () => clock,
        });
        try {
            await watcher.sync();

            let rows = await adapter.listDocs();
            // The .txt is ignored; the .md maps to path = basename without extension.
            expect(rows.map((r) => r.path)).toEqual(["feat-x"]);
            expect(rows[0].status).toBe("todo");
            expect(rows[0].content).toBe("# Feat X\n\nfirst body");
            const firstHash = rows[0].contentHash;
            expect(firstHash).toBe(sha256Hex("# Feat X\n\nfirst body"));
            expect(rows[0].updatedAtMs).toBe(100);

            // Re-sync identical content at a LATER clock → no-op (updated_at_ms unchanged).
            clock = 200;
            await watcher.syncFile("feat-x.md");
            rows = await adapter.listDocs();
            expect(rows[0].updatedAtMs).toBe(100);
            expect(rows[0].contentHash).toBe(firstHash);

            // Change the file → hash mismatch → last-write-wins (content + stamp update).
            clock = 300;
            writeFileSync(join(dir, "feat-x.md"), "# Feat X\n\nSECOND body");
            await watcher.syncFile("feat-x.md");
            rows = await adapter.listDocs();
            expect(rows[0].content).toBe("# Feat X\n\nSECOND body");
            expect(rows[0].contentHash).toBe(sha256Hex("# Feat X\n\nSECOND body"));
            expect(rows[0].updatedAtMs).toBe(300);
        }
        finally {
            watcher.close();
        }
    });

    test("respects a tombstone: an unchanged lingering file does NOT resurrect a soft-deleted doc", async () => {
        const { adapter } = createDb();
        const body = "# Ticket Z\n\nbody that will be soft-deleted";
        writeFileSync(join(dir, "z.md"), body);
        const watcher = watchDocsDirectory(adapter, {
            dir,
            kind: "ticket",
            defaultStatus: "todo",
            nowMs: () => 100,
        });
        try {
            // Initial sync surfaces the doc.
            await watcher.sync();
            expect((await adapter.listDocs()).map((r) => r.path)).toEqual(["z"]);

            // Soft-delete it (as deleteTicket would). The `.md` file still exists.
            await adapter.softDeleteDoc("z", 200);
            expect((await adapter.listDocs()).map((r) => r.path)).toEqual([]);
            const tomb = await adapter.getDoc("z");
            expect(tomb?.deletedAtMs).toBe(200);

            // Re-sync (mirrors a watcher event / gateway restart) with the file
            // STILL on disk and UNCHANGED → the tombstone must survive: no revive.
            await watcher.sync();
            expect((await adapter.listDocs()).map((r) => r.path)).toEqual([]);
            const stillTomb = await adapter.getDoc("z");
            expect(stillTomb?.deletedAtMs).toBe(200);
            // Direct single-file reconcile must also leave it tombstoned.
            await watcher.syncFile("z.md");
            expect((await adapter.getDoc("z"))?.deletedAtMs).toBe(200);
            expect((await adapter.listDocs()).map((r) => r.path)).toEqual([]);
        }
        finally {
            watcher.close();
        }
    });

    test("revives a tombstone only on a genuine post-deletion edit (file content changes)", async () => {
        const { adapter } = createDb();
        let clock = 100;
        writeFileSync(join(dir, "z.md"), "# Ticket Z\n\noriginal");
        const watcher = watchDocsDirectory(adapter, {
            dir,
            kind: "ticket",
            defaultStatus: "todo",
            nowMs: () => clock,
        });
        try {
            await watcher.sync();
            await adapter.softDeleteDoc("z", 200);
            expect((await adapter.listDocs()).map((r) => r.path)).toEqual([]);

            // The file is genuinely re-created with NEW content after the delete →
            // hash mismatch → legitimate revive (file wins, last-write-wins).
            clock = 300;
            writeFileSync(join(dir, "z.md"), "# Ticket Z\n\nRECREATED after delete");
            await watcher.syncFile("z.md");
            const rows = await adapter.listDocs();
            expect(rows.map((r) => r.path)).toEqual(["z"]);
            expect(rows[0].content).toBe("# Ticket Z\n\nRECREATED after delete");
            expect(rows[0].deletedAtMs).toBe(null);
            expect(rows[0].updatedAtMs).toBe(300);
        }
        finally {
            watcher.close();
        }
    });

    test("preserves an existing row's status across a file edit", async () => {
        const { adapter } = createDb();
        writeFileSync(join(dir, "t.md"), "v1");
        const watcher = watchDocsDirectory(adapter, { dir, nowMs: () => 1 });
        try {
            await watcher.sync();
            // Promote status out-of-band (as updateTicket would).
            await adapter.upsertDoc({
                path: "t",
                kind: "ticket",
                content: "v1",
                contentHash: sha256Hex("v1"),
                status: "in-progress",
                updatedAtMs: 2,
                deletedAtMs: null,
            });
            // Edit the file → content changes but the curated status is kept.
            writeFileSync(join(dir, "t.md"), "v2");
            await watcher.syncFile("t.md");
            const rows = await adapter.listDocs();
            expect(rows[0].content).toBe("v2");
            expect(rows[0].status).toBe("in-progress");
        }
        finally {
            watcher.close();
        }
    });
});
