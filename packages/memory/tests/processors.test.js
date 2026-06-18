import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createMemoryStore } from "../src/store/index.js";
import { TtlGarbageCollector, TokenLimiter, Summarizer, } from "../src/processors.js";
const WF_NS = { kind: "workflow", id: "test-proc" };
describe("TtlGarbageCollector", () => {
    let store;
    beforeEach(() => {
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        ensureSmithersTables(db);
        store = createMemoryStore(db);
    });
    test("deletes expired facts", async () => {
        // Set a fact with very short TTL
        await store.setFact(WF_NS, "ephemeral", "temp", 1);
        // Wait for it to expire
        await new Promise((r) => setTimeout(r, 10));
        // Set a fact without TTL (should survive)
        await store.setFact(WF_NS, "permanent", "stays");
        const gc = TtlGarbageCollector();
        expect(gc.name).toBe("TtlGarbageCollector");
        await gc.process(store);
        const ephemeral = await store.getFact(WF_NS, "ephemeral");
        const permanent = await store.getFact(WF_NS, "permanent");
        expect(ephemeral).toBeUndefined();
        expect(permanent).toBeDefined();
    });
    test("no-op when no expired facts exist", async () => {
        await store.setFact(WF_NS, "long-lived", "value", 999999);
        const gc = TtlGarbageCollector();
        // Should not throw
        await gc.process(store);
        const fact = await store.getFact(WF_NS, "long-lived");
        expect(fact).toBeDefined();
    });
});
describe("TokenLimiter", () => {
    test("creates processor with name", () => {
        const limiter = TokenLimiter(4096);
        expect(limiter.name).toBe("TokenLimiter");
    });
    test("process does not throw", async () => {
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        ensureSmithersTables(db);
        const store = createMemoryStore(db);
        const limiter = TokenLimiter(4096);
        // Should not throw
        await limiter.process(store);
    });
    test("trims oldest messages in each thread to stay under budget", async () => {
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        ensureSmithersTables(db);
        const store = createMemoryStore(db);
        const thread = await store.createThread(WF_NS);
        const otherThread = await store.createThread(WF_NS);

        await store.saveMessage({
            id: "msg-1",
            threadId: thread.threadId,
            role: "user",
            contentJson: JSON.stringify("x".repeat(80)),
            createdAtMs: 1,
        });
        await store.saveMessage({
            id: "msg-2",
            threadId: thread.threadId,
            role: "assistant",
            contentJson: JSON.stringify("short"),
            createdAtMs: 2,
        });
        await store.saveMessage({
            id: "msg-3",
            threadId: otherThread.threadId,
            role: "user",
            contentJson: JSON.stringify("short"),
            createdAtMs: 3,
        });

        const limiter = TokenLimiter(5);
        await limiter.process(store);

        expect((await store.listMessages(thread.threadId)).map((message) => message.id)).toEqual(["msg-2"]);
        expect((await store.listMessages(otherThread.threadId)).map((message) => message.id)).toEqual(["msg-3"]);
    });
});
describe("Summarizer", () => {
    test("creates processor with name", () => {
        const mockAgent = { run: async (_prompt) => ({ text: "summary" }) };
        const summarizer = Summarizer(mockAgent);
        expect(summarizer.name).toBe("Summarizer");
    });
    test("process does not throw", async () => {
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        ensureSmithersTables(db);
        const store = createMemoryStore(db);
        const mockAgent = { run: async (_prompt) => ({ text: "summary" }) };
        const summarizer = Summarizer(mockAgent);
        // Should not throw
        await summarizer.process(store);
    });
    test("summarizes old messages with the agent and preserves recent messages", async () => {
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        ensureSmithersTables(db);
        const store = createMemoryStore(db);
        const thread = await store.createThread(WF_NS);
        const prompts = [];
        const mockAgent = {
            run: async (prompt) => {
                prompts.push(prompt);
                return { text: "The user asked for a status update." };
            },
        };

        for (const [index, role, content] of [
            [1, "user", "Can you check the rollout?"],
            [2, "assistant", "I will check it."],
            [3, "user", "Any update?"],
            [4, "assistant", "The rollout is healthy."],
        ]) {
            await store.saveMessage({
                id: `msg-${index}`,
                threadId: thread.threadId,
                role,
                contentJson: JSON.stringify(content),
                createdAtMs: index,
            });
        }

        const summarizer = Summarizer(mockAgent);
        await summarizer.process(store);

        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("Can you check the rollout?");
        const messages = await store.listMessages(thread.threadId);
        expect(messages).toHaveLength(3);
        expect(messages[0].role).toBe("system");
        expect(JSON.parse(messages[0].contentJson)).toEqual({
            type: "summary",
            text: "The user asked for a status update.",
        });
        expect(messages.slice(1).map((message) => message.id)).toEqual(["msg-3", "msg-4"]);
    });
});
