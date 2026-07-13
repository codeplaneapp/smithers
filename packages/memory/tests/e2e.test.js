import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createMemoryStore } from "../src/store/index.js";
import { TtlGarbageCollector } from "../src/processors.js";
const WF_NS = { kind: "workflow", id: "e2e-test" };
describe("Memory E2E", () => {
    let store;
    beforeEach(() => {
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        ensureSmithersTables(db);
        store = createMemoryStore(db);
    });
    test("full workflow: set facts, store messages, check persistence", async () => {
        // 1. Store working memory facts
        await store.setFact(WF_NS, "model", "gpt-4");
        await store.setFact(WF_NS, "temperature", 0.7);
        await store.setFact(WF_NS, "max-tokens", 4096);
        // 2. Create a thread and store messages
        const thread = await store.createThread(WF_NS, "E2E Session");
        await store.saveMessage({
            id: "msg-1",
            threadId: thread.threadId,
            role: "user",
            contentJson: JSON.stringify({ text: "Analyze this codebase" }),
            runId: "run-001",
            nodeId: "analyze-task",
        });
        await store.saveMessage({
            id: "msg-2",
            threadId: thread.threadId,
            role: "assistant",
            contentJson: JSON.stringify({
                text: "Found 5 modules with 12 dependencies",
                modules: ["auth", "db", "api", "ui", "utils"],
            }),
            runId: "run-001",
            nodeId: "analyze-task",
        });
        // 3. Verify working memory persists
        const facts = await store.listFacts(WF_NS);
        expect(facts).toHaveLength(3);
        const modelFact = await store.getFact(WF_NS, "model");
        expect(JSON.parse(modelFact.valueJson)).toBe("gpt-4");
        // 4. Verify message history persists
        const messages = await store.listMessages(thread.threadId);
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe("user");
        expect(messages[1].role).toBe("assistant");
        const count = await store.countMessages(thread.threadId);
        expect(count).toBe(2);
    });
    test("multiple runs accumulate facts", async () => {
        // Simulate run 1
        await store.setFact(WF_NS, "run-count", 1);
        await store.setFact(WF_NS, "last-result", "success");
        // Simulate run 2 (increments counter, updates result)
        const prev = await store.getFact(WF_NS, "run-count");
        const count = JSON.parse(prev.valueJson);
        await store.setFact(WF_NS, "run-count", count + 1);
        await store.setFact(WF_NS, "last-result", "failure");
        // Verify accumulated state
        const runCount = await store.getFact(WF_NS, "run-count");
        expect(JSON.parse(runCount.valueJson)).toBe(2);
        const lastResult = await store.getFact(WF_NS, "last-result");
        expect(JSON.parse(lastResult.valueJson)).toBe("failure");
    });
    test("TTL garbage collection in workflow context", async () => {
        // Store a mix of ephemeral and permanent facts
        await store.setFact(WF_NS, "cache-entry", "cached-data", 1); // 1ms TTL
        await store.setFact(WF_NS, "config", "permanent-config"); // no TTL
        // Wait for ephemeral to expire
        await new Promise((r) => setTimeout(r, 10));
        // Run GC
        const gc = TtlGarbageCollector();
        await gc.process(store);
        // Only permanent fact should survive
        const cache = await store.getFact(WF_NS, "cache-entry");
        const config = await store.getFact(WF_NS, "config");
        expect(cache).toBeUndefined();
        expect(config).toBeDefined();
    });
    test("namespace isolation end-to-end", async () => {
        const ns1 = { kind: "workflow", id: "flow-a" };
        const ns2 = { kind: "workflow", id: "flow-b" };
        // Store facts in different namespaces
        await store.setFact(ns1, "key", "value-a");
        await store.setFact(ns2, "key", "value-b");
        // Verify isolation
        const factA = await store.getFact(ns1, "key");
        const factB = await store.getFact(ns2, "key");
        expect(JSON.parse(factA.valueJson)).toBe("value-a");
        expect(JSON.parse(factB.valueJson)).toBe("value-b");
    });
    test("thread and message operations with multiple threads", async () => {
        const thread1 = await store.createThread(WF_NS, "Thread 1");
        const thread2 = await store.createThread(WF_NS, "Thread 2");
        await store.saveMessage({
            id: "t1-msg-1",
            threadId: thread1.threadId,
            role: "user",
            contentJson: '"Thread 1 message"',
        });
        await store.saveMessage({
            id: "t2-msg-1",
            threadId: thread2.threadId,
            role: "user",
            contentJson: '"Thread 2 message"',
        });
        await store.saveMessage({
            id: "t2-msg-2",
            threadId: thread2.threadId,
            role: "assistant",
            contentJson: '"Thread 2 reply"',
        });
        const t1Messages = await store.listMessages(thread1.threadId);
        const t2Messages = await store.listMessages(thread2.threadId);
        expect(t1Messages).toHaveLength(1);
        expect(t2Messages).toHaveLength(2);
        // Delete thread 1 should not affect thread 2
        await store.deleteThread(thread1.threadId);
        const t2MessagesAfter = await store.listMessages(thread2.threadId);
        expect(t2MessagesAfter).toHaveLength(2);
        const t1MessagesAfter = await store.listMessages(thread1.threadId);
        expect(t1MessagesAfter).toHaveLength(0);
    });
    test("file-backed store preserves facts, namespaces, threads, and messages across reopen", async () => {
        const dir = mkdtempSync(join(tmpdir(), "smithers-memory-e2e-"));
        const dbPath = join(dir, "smithers.db");
        const workflowNs = { kind: "workflow", id: "flow:alpha%25" };
        const userNs = { kind: "user", id: "will:local%user" };
        let threadId;

        try {
            {
                const sqlite = new Database(dbPath);
                const db = drizzle(sqlite);
                ensureSmithersTables(db);
                const firstStore = createMemoryStore(db);

                await firstStore.setFact(workflowNs, "decision", {
                    accepted: true,
                    reason: "persist across process boundaries",
                });
                await firstStore.setFact(userNs, "preference", "compact-json");
                const thread = await firstStore.createThread(workflowNs, "Persisted Thread");
                threadId = thread.threadId;
                await firstStore.saveMessage({
                    id: "persist-msg-1",
                    threadId,
                    role: "user",
                    contentJson: JSON.stringify({ text: "remember this" }),
                    runId: "run-persist",
                    nodeId: "node-persist",
                    createdAtMs: 1,
                });
                await firstStore.saveMessage({
                    id: "persist-msg-2",
                    threadId,
                    role: "assistant",
                    contentJson: JSON.stringify({ text: "stored" }),
                    createdAtMs: 2,
                });
                sqlite.close();
            }

            const sqlite = new Database(dbPath);
            const db = drizzle(sqlite);
            ensureSmithersTables(db);
            const reopenedStore = createMemoryStore(db);

            const workflowFact = await reopenedStore.getFact(workflowNs, "decision");
            const userFact = await reopenedStore.getFact(userNs, "preference");
            expect(JSON.parse(workflowFact.valueJson)).toEqual({
                accepted: true,
                reason: "persist across process boundaries",
            });
            expect(JSON.parse(userFact.valueJson)).toBe("compact-json");

            const allFacts = await reopenedStore.listAllFacts();
            expect(allFacts.map((fact) => fact.namespace)).toEqual([
                "user:will%3Alocal%25user",
                "workflow:flow%3Aalpha%2525",
            ]);
            expect(allFacts.map((fact) => fact.key)).toEqual(["preference", "decision"]);

            const threads = await reopenedStore.listThreads();
            expect(threads).toHaveLength(1);
            expect(threads[0]).toMatchObject({
                threadId,
                namespace: "workflow:flow%3Aalpha%2525",
                title: "Persisted Thread",
            });

            const messages = await reopenedStore.listMessages(threadId);
            expect(messages.map((message) => message.id)).toEqual([
                "persist-msg-1",
                "persist-msg-2",
            ]);
            expect(messages[0]).toMatchObject({
                role: "user",
                runId: "run-persist",
                nodeId: "node-persist",
            });
            expect(await reopenedStore.countMessages(threadId)).toBe(2);
            sqlite.close();
        }
        finally {
            // Windows releases sqlite file handles asynchronously after
            // close(), so a bare rm races EBUSY even with retries. The
            // persistence assertions above have already run; a residual temp-dir
            // cleanup race must not fail the test, so retry generously and treat
            // a leftover lock as best-effort (the OS reclaims the temp dir).
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
            }
            catch (error) {
                if (process.platform !== "win32" || (error?.code !== "EBUSY" && error?.code !== "EPERM" && error?.code !== "ENOTEMPTY")) throw error;
            }
        }
    }, 60_000);
    test("deleteMessages prunes large real SQLite id sets without crossing thread boundaries", async () => {
        const target = await store.createThread(WF_NS, "Large Delete Target");
        const other = await store.createThread(WF_NS, "Other Thread");
        const targetIds = Array.from({ length: 950 }, (_, i) => `bulk-${String(i).padStart(4, "0")}`);

        for (const [index, id] of targetIds.entries()) {
            await store.saveMessage({
                id,
                threadId: target.threadId,
                role: "user",
                contentJson: JSON.stringify({ index }),
                createdAtMs: index,
            });
        }
        await store.saveMessage({
            id: "bulk-keep",
            threadId: target.threadId,
            role: "assistant",
            contentJson: JSON.stringify({ keep: true }),
            createdAtMs: 2_000,
        });
        await store.saveMessage({
            id: "foreign-msg",
            threadId: other.threadId,
            role: "user",
            contentJson: JSON.stringify({ thread: "other" }),
            createdAtMs: 1,
        });

        const deleted = await store.deleteMessages(target.threadId, [
            ...targetIds,
            "foreign-msg",
            "missing-msg",
        ]);

        expect(deleted).toBe(950);
        expect(await store.countMessages(target.threadId)).toBe(1);
        expect((await store.listMessages(target.threadId)).map((message) => message.id)).toEqual([
            "bulk-keep",
        ]);
        expect((await store.listMessages(other.threadId)).map((message) => message.id)).toEqual([
            "foreign-msg",
        ]);
    });
});
