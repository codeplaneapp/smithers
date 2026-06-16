import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createDocWatcher } from "../src/createDocWatcher.js";
import { startDocFileSync } from "../src/startDocFileSync.js";

function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), sqlite };
}

function fakeWatcher() {
    let onSettle = () => {};
    let closed = false;
    return {
        create({ onSettle: cb }) {
            onSettle = cb;
            return { close() { closed = true; }, watching: true };
        },
        settle(paths) {
            onSettle(paths);
        },
        isClosed() {
            return closed;
        },
    };
}

describe("docs file sync", () => {
    test("local markdown edits upsert docs rows and deletes write tombstones", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-sync-"));
        const { adapter, sqlite } = createTestDb();
        const watcher = fakeWatcher();
        try {
            await fs.mkdir(path.join(cwd, ".smithers", "tickets"), { recursive: true });
            await fs.writeFile(path.join(cwd, ".smithers", "tickets", "demo.md"), "# Demo\n", "utf8");
            const sync = await startDocFileSync({
                enabled: true,
                cwd,
                adapter,
                nowMs: () => 10,
                createWatcher: watcher.create.bind(watcher),
                syncOnStart: false,
            });
            watcher.settle(["tickets/demo.md"]);
            await sync.flush([]);
            const doc = await adapter.getDoc("tickets/demo.md");
            expect(doc).toMatchObject({
                path: "tickets/demo.md",
                kind: "ticket",
                content: "# Demo\n",
                deletedAtMs: null,
            });

            await fs.rm(path.join(cwd, ".smithers", "tickets", "demo.md"));
            watcher.settle(["tickets/demo.md"]);
            await sync.flush([]);
            const deleted = await adapter.getDoc("tickets/demo.md", { includeDeleted: true });
            expect(deleted?.deletedAtMs).toBe(10);
            expect(await adapter.listDocs()).toHaveLength(0);
            await sync.stop();
            expect(watcher.isClosed()).toBe(true);
        }
        finally {
            sqlite.close();
            await fs.rm(cwd, { recursive: true, force: true });
        }
    });

    test("large bursts shed the oldest pending paths and surface the drop", () => {
        const settled = [];
        const drops = [];
        let trigger = (_path) => {};
        const watcher = createDocWatcher({
            cwd: "/wt",
            onSettle: (paths) => settled.push(paths),
            maxPendingPaths: 4,
            onDrop: (info) => drops.push(info),
            watch(_cwd, onChange) {
                trigger = onChange;
                return { close() {} };
            },
            // Defer the debounce flush so a whole burst accumulates before settling.
            setTimeoutFn() {
                return 0;
            },
            clearTimeoutFn() {},
        });
        for (let i = 0; i < 10; i += 1) {
            trigger(`.smithers/tickets/t${i}.md`);
        }
        // Six of the ten distinct paths are shed (cap 4); the drop is reported,
        // not silently swallowed.
        expect(watcher.droppedCount()).toBe(6);
        expect(drops).toHaveLength(6);
        expect(drops[0]).toMatchObject({ path: "tickets/t0.md", droppedTotal: 1 });
        watcher.flush();
        // The newest four survive; the oldest were the ones shed.
        expect(settled).toEqual([["tickets/t6.md", "tickets/t7.md", "tickets/t8.md", "tickets/t9.md"]]);
        watcher.close();
    });

    test("a slow consumer serializes settles without losing or interleaving writes", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-slow-"));
        const { adapter: realAdapter, sqlite } = createTestDb();
        const watcher = fakeWatcher();
        let active = 0;
        let maxActive = 0;
        const slowAdapter = {
            upsertDocRow: async (row) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                try {
                    return await realAdapter.upsertDocRow(row);
                }
                finally {
                    active -= 1;
                }
            },
        };
        try {
            await fs.mkdir(path.join(cwd, ".smithers", "tickets"), { recursive: true });
            for (const name of ["a", "b", "c"]) {
                await fs.writeFile(path.join(cwd, ".smithers", "tickets", `${name}.md`), `# ${name}\n`, "utf8");
            }
            const sync = await startDocFileSync({
                enabled: true,
                cwd,
                adapter: slowAdapter,
                nowMs: () => 42,
                createWatcher: watcher.create.bind(watcher),
                syncOnStart: false,
            });
            // Fire three settles back-to-back while the consumer is slow.
            watcher.settle(["tickets/a.md"]);
            watcher.settle(["tickets/b.md"]);
            watcher.settle(["tickets/c.md"]);
            await sync.flush([]);
            // The chain is a bounded buffer of one in-flight sync: writes never overlap.
            expect(maxActive).toBe(1);
            // No settle is lost: every file is durably upserted.
            expect(await realAdapter.listDocs()).toHaveLength(3);
            await sync.stop();
        }
        finally {
            sqlite.close();
            await fs.rm(cwd, { recursive: true, force: true });
        }
    });

    test("watcher excludes worktree contents and VCS internals", () => {
        const settled = [];
        let trigger = (_path) => {};
        const watcher = createDocWatcher({
            cwd: "/wt",
            onSettle: (paths) => settled.push(paths),
            debounceMs: 0,
            watch(_cwd, onChange) {
                trigger = onChange;
                return { close() {} };
            },
            setTimeoutFn(fn) {
                fn();
                return 0;
            },
            clearTimeoutFn() {},
        });
        trigger("src/not-synced.md");
        trigger(".jj/repo/store.md");
        trigger(".smithers/tickets/demo.md");
        watcher.close();
        expect(settled).toEqual([["tickets/demo.md"]]);
    });
});
