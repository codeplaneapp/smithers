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
});
