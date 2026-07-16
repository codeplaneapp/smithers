import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createMemoryStore } from "../src/store/createMemoryStore.js";
import { createLocalMemoryRuntime } from "../src/LocalMemoryRuntime.js";

describe("LocalMemoryRuntime", () => {
    test("retains append documents and recalls matching facts by keyword", async () => {
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        ensureSmithersTables(db);
        const store = createMemoryStore(db);
        const runtime = createLocalMemoryRuntime(store);

        await runtime.retainMemory({
            bank: "project-7",
            content: "The database is SQLite.",
            documentId: "run-1",
            updateMode: "append",
            metadata: { run: "run-1", node: "design" },
        });
        await runtime.retainMemory({
            bank: "project-7",
            content: "Hindsight is optional.",
            documentId: "run-1",
            updateMode: "append",
            metadata: { run: "run-1", node: "design" },
        });

        const results = await runtime.recallMemory({
            banks: ["project-7"],
            query: "Hindsight",
            maxTokens: 128,
        });
        expect(results).toEqual([{
            bank: "project-7",
            text: "The database is SQLite.\nHindsight is optional.",
        }]);
        expect(await runtime.getPrimers()).toEqual([]);
        sqlite.close();
    });

    test("applies compound tag scope before keyword scoring", async () => {
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        ensureSmithersTables(db);
        const runtime = createLocalMemoryRuntime(createMemoryStore(db));

        await runtime.retainMemory({
            bank: "project-7",
            content: "The shared deployment lane is blue.",
            documentId: "main-memory",
            updateMode: "replace",
            tags: ["scope:main", "branch:main"],
        });
        await runtime.retainMemory({
            bank: "project-7",
            content: "The feature deployment lane is green.",
            documentId: "feature-memory",
            updateMode: "replace",
            tags: ["scope:branch", "branch:feature"],
        });
        await runtime.retainMemory({
            bank: "project-7",
            content: "The secret deployment lane is red.",
            documentId: "secret-memory",
            updateMode: "replace",
            tags: ["scope:branch", "branch:secret"],
        });

        const results = await runtime.recallMemory({
            banks: ["project-7"],
            query: "deployment lane",
            maxTokens: 256,
            tagGroupsByBank: {
                "project-7": [{
                    or: [
                        { tags: ["scope:main"], match: "all_strict" },
                        { tags: ["branch:feature"], match: "all_strict" },
                    ],
                }],
            },
        });

        expect(results.map((result) => result.text).sort()).toEqual([
            "The feature deployment lane is green.",
            "The shared deployment lane is blue.",
        ]);
        expect(results.some((result) => result.text.includes("secret"))).toBe(false);
        sqlite.close();
    });
});
