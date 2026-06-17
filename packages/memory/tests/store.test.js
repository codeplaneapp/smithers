import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createMemoryStore } from "../src/store/index.js";
import { namespaceToString } from "../src/namespaceToString.js";
import { parseNamespace } from "../src/parseNamespace.js";
function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { db, sqlite };
}
const WF_NS = { kind: "workflow", id: "test-wf" };
const AGENT_NS = { kind: "agent", id: "test-agent" };
describe("MemoryStore - Working Memory", () => {
    let store;
    beforeEach(() => {
        const { db } = createTestDb();
        store = createMemoryStore(db);
    });
    test("setFact and getFact roundtrip", async () => {
        await store.setFact(WF_NS, "key1", { hello: "world" });
        const fact = await store.getFact(WF_NS, "key1");
        expect(fact).toBeDefined();
        expect(fact.key).toBe("key1");
        expect(fact.namespace).toBe("workflow:test-wf");
        expect(JSON.parse(fact.valueJson)).toEqual({ hello: "world" });
    });
    test("getFact returns undefined for missing key", async () => {
        const fact = await store.getFact(WF_NS, "nonexistent");
        expect(fact).toBeUndefined();
    });
    test("setFact upserts on same key", async () => {
        await store.setFact(WF_NS, "counter", 1);
        await store.setFact(WF_NS, "counter", 2);
        const fact = await store.getFact(WF_NS, "counter");
        expect(JSON.parse(fact.valueJson)).toBe(2);
    });
    test("different namespaces are isolated", async () => {
        await store.setFact(WF_NS, "shared-key", "workflow-value");
        await store.setFact(AGENT_NS, "shared-key", "agent-value");
        const wfFact = await store.getFact(WF_NS, "shared-key");
        const agFact = await store.getFact(AGENT_NS, "shared-key");
        expect(JSON.parse(wfFact.valueJson)).toBe("workflow-value");
        expect(JSON.parse(agFact.valueJson)).toBe("agent-value");
    });
    test("deleteFact removes the fact", async () => {
        await store.setFact(WF_NS, "to-delete", "value");
        await store.deleteFact(WF_NS, "to-delete");
        const fact = await store.getFact(WF_NS, "to-delete");
        expect(fact).toBeUndefined();
    });
    test("listFacts returns all facts in namespace", async () => {
        await store.setFact(WF_NS, "a", 1);
        await store.setFact(WF_NS, "b", 2);
        await store.setFact(AGENT_NS, "c", 3);
        const facts = await store.listFacts(WF_NS);
        expect(facts).toHaveLength(2);
        expect(facts.map((f) => f.key).sort()).toEqual(["a", "b"]);
    });
    test("setFact with TTL stores ttlMs", async () => {
        await store.setFact(WF_NS, "ephemeral", "temp", 5000);
        const fact = await store.getFact(WF_NS, "ephemeral");
        expect(fact.ttlMs).toBe(5000);
    });
    test("setFact with ttlMs=0 stores and expires the fact", async () => {
        await store.setFact(WF_NS, "immediate", "temp", 0);
        const stored = await store.getFact(WF_NS, "immediate");
        expect(stored.ttlMs).toBe(0);
        await new Promise((r) => setTimeout(r, 1));
        const deleted = await store.deleteExpiredFacts();
        expect(deleted).toBeGreaterThanOrEqual(1);
        await expect(store.getFact(WF_NS, "immediate")).resolves.toBeUndefined();
    });
    test("setFact rejects undefined values as a wrapped write failure", async () => {
        await expect(store.setFact(WF_NS, "undefined", undefined)).rejects.toThrow(/memory setFact|DB_WRITE_FAILED/);
    });
    test("deleteExpiredFacts removes expired facts", async () => {
        // Set a fact with very short TTL in the past
        await store.setFact(WF_NS, "expired", "old", 1);
        // Wait a bit to ensure it's expired
        await new Promise((r) => setTimeout(r, 10));
        const deleted = await store.deleteExpiredFacts();
        expect(deleted).toBeGreaterThanOrEqual(1);
        const fact = await store.getFact(WF_NS, "expired");
        expect(fact).toBeUndefined();
    });
    test("setFact stores complex JSON values", async () => {
        const value = {
            nested: { array: [1, 2, 3], obj: { deep: true } },
            null_field: null,
            number: 42.5,
        };
        await store.setFact(WF_NS, "complex", value);
        const fact = await store.getFact(WF_NS, "complex");
        expect(JSON.parse(fact.valueJson)).toEqual(value);
    });
    test("wraps read and write failures as Smithers errors", async () => {
        const readStore = createMemoryStore({
            select() {
                throw new Error("read boom");
            },
        });
        await expect(readStore.getFact(WF_NS, "x")).rejects.toThrow(/memory getFact|DB_QUERY_FAILED/);

        const writeStore = createMemoryStore({
            insert() {
                return {
                    values() {
                        throw new Error("write boom");
                    },
                };
            },
        });
        await expect(writeStore.setFact(WF_NS, "x", 1)).rejects.toThrow(/memory setFact|DB_WRITE_FAILED/);
    });
    test("wraps store operation failures with operation-specific Smithers errors", async () => {
        const cases = [
            ["getFact", (brokenStore) => brokenStore.getFact(WF_NS, "x"), /memory getFact|DB_QUERY_FAILED/],
            ["setFact", (brokenStore) => brokenStore.setFact(WF_NS, "x", 1), /memory setFact|DB_WRITE_FAILED/],
            ["deleteFact", (brokenStore) => brokenStore.deleteFact(WF_NS, "x"), /memory deleteFact|DB_WRITE_FAILED/],
            ["listFacts", (brokenStore) => brokenStore.listFacts(WF_NS), /memory listFacts|DB_QUERY_FAILED/],
            ["createThread", (brokenStore) => brokenStore.createThread(WF_NS), /memory createThread|DB_WRITE_FAILED/],
            ["getThread", (brokenStore) => brokenStore.getThread("thread-1"), /memory getThread|DB_QUERY_FAILED/],
            ["deleteThread", (brokenStore) => brokenStore.deleteThread("thread-1"), /memory deleteThreadMessages|DB_WRITE_FAILED/],
            [
                "saveMessage",
                (brokenStore) => brokenStore.saveMessage({
                    id: "msg-1",
                    threadId: "thread-1",
                    role: "user",
                    contentJson: '"hello"',
                }),
                /memory saveMessage|DB_WRITE_FAILED/,
            ],
            ["listMessages", (brokenStore) => brokenStore.listMessages("thread-1"), /memory listMessages|DB_QUERY_FAILED/],
            ["countMessages", (brokenStore) => brokenStore.countMessages("thread-1"), /memory countMessages|DB_QUERY_FAILED/],
            ["deleteExpiredFacts", (brokenStore) => brokenStore.deleteExpiredFacts(), /memory deleteExpiredFacts|DB_WRITE_FAILED/],
        ];

        for (const [name, operation, expected] of cases) {
            const { db, sqlite } = createTestDb();
            const brokenStore = createMemoryStore(db);
            sqlite.close();
            await expect(operation(brokenStore), name).rejects.toThrow(expected);
        }
    });
    test("deleteExpiredFacts uses rowsAffected when a driver does not expose changes", async () => {
        const storeWithRowsAffected = createMemoryStore({
            delete() {
                return {
                    where() {
                        return Promise.resolve({ rowsAffected: 7 });
                    },
                };
            },
        });

        await expect(storeWithRowsAffected.deleteExpiredFacts()).resolves.toBe(7);
    });
});
describe("MemoryStore - Threads", () => {
    let store;
    beforeEach(() => {
        const { db } = createTestDb();
        store = createMemoryStore(db);
    });
    test("createThread and getThread roundtrip", async () => {
        const thread = await store.createThread(WF_NS, "Test Thread");
        expect(thread.threadId).toBeDefined();
        expect(thread.title).toBe("Test Thread");
        expect(thread.namespace).toBe("workflow:test-wf");
        const retrieved = await store.getThread(thread.threadId);
        expect(retrieved).toBeDefined();
        expect(retrieved.threadId).toBe(thread.threadId);
        expect(retrieved.title).toBe("Test Thread");
    });
    test("getThread returns undefined for missing thread", async () => {
        const result = await store.getThread("nonexistent-id");
        expect(result).toBeUndefined();
    });
    test("deleteThread removes thread and its messages", async () => {
        const thread = await store.createThread(WF_NS, "Doomed Thread");
        await store.saveMessage({
            id: "msg-1",
            threadId: thread.threadId,
            role: "user",
            contentJson: '"hello"',
        });
        await store.deleteThread(thread.threadId);
        const retrieved = await store.getThread(thread.threadId);
        expect(retrieved).toBeUndefined();
        const messages = await store.listMessages(thread.threadId);
        expect(messages).toHaveLength(0);
    });
});
describe("MemoryStore - Messages", () => {
    let store;
    beforeEach(() => {
        const { db } = createTestDb();
        store = createMemoryStore(db);
    });
    test("saveMessage and listMessages roundtrip", async () => {
        const thread = await store.createThread(WF_NS);
        await store.saveMessage({
            id: "msg-1",
            threadId: thread.threadId,
            role: "user",
            contentJson: JSON.stringify({ text: "Hello" }),
            runId: "run-1",
            nodeId: "task-1",
        });
        await store.saveMessage({
            id: "msg-2",
            threadId: thread.threadId,
            role: "assistant",
            contentJson: JSON.stringify({ text: "Hi there" }),
        });
        const messages = await store.listMessages(thread.threadId);
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe("user");
        expect(messages[1].role).toBe("assistant");
        expect(messages[0].runId).toBe("run-1");
        expect(messages[0].nodeId).toBe("task-1");
    });
    test("listMessages with limit", async () => {
        const thread = await store.createThread(WF_NS);
        for (let i = 0; i < 10; i++) {
            await store.saveMessage({
                id: `msg-${i}`,
                threadId: thread.threadId,
                role: "user",
                contentJson: JSON.stringify({ index: i }),
                createdAtMs: Date.now() + i,
            });
        }
        const messages = await store.listMessages(thread.threadId, 3);
        expect(messages).toHaveLength(3);
    });
    test("listMessages with limit=0 returns no messages", async () => {
        const thread = await store.createThread(WF_NS);
        await store.saveMessage({
            id: "msg-1",
            threadId: thread.threadId,
            role: "user",
            contentJson: '"hello"',
        });

        const messages = await store.listMessages(thread.threadId, 0);
        expect(messages).toEqual([]);
    });
    test("countMessages", async () => {
        const thread = await store.createThread(WF_NS);
        expect(await store.countMessages(thread.threadId)).toBe(0);
        await store.saveMessage({
            id: "msg-1",
            threadId: thread.threadId,
            role: "user",
            contentJson: '"test"',
        });
        await store.saveMessage({
            id: "msg-2",
            threadId: thread.threadId,
            role: "assistant",
            contentJson: '"response"',
        });
        expect(await store.countMessages(thread.threadId)).toBe(2);
    });
});
describe("Memory namespace codec", () => {
    test("roundtrips percent-encoded ids for enumerated namespace kinds", () => {
        for (const kind of ["workflow", "agent", "user", "global"]) {
            const namespace = { kind, id: `prefix%:${kind}:suffix%25` };
            const encoded = namespaceToString(namespace);
            expect(encoded).toContain("%25");
            expect(encoded).toContain("%3A");
            expect(parseNamespace(encoded)).toEqual(namespace);
        }
    });
});
