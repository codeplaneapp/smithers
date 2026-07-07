import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createMemoryStore } from "../src/store/index.js";
import { MemoryService, createMemoryLayer } from "../src/service.js";
import { Summarizer } from "../src/processors.js";
import * as barrel from "../src/index.js";
import * as metrics from "../src/metrics.js";
import * as memoryServiceApi from "../src/MemoryServiceApi.js";
import * as memoryProcessor from "../src/MemoryProcessor.js";
import * as memoryStoreType from "../src/store/MemoryStore.js";

const WF_NS = { kind: "workflow", id: "coverage-gaps" };

function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return db;
}

describe("package barrels re-export the public surface", () => {
    test("src/index.js exposes the documented named exports", () => {
        for (const name of [
            "namespaceToString",
            "parseNamespace",
            "smithersMemoryFacts",
            "smithersMemoryThreads",
            "smithersMemoryMessages",
            "createMemoryStore",
            "TtlGarbageCollector",
            "TokenLimiter",
            "Summarizer",
            "MemoryService",
            "createMemoryLayer",
            "memoryFactReads",
            "memoryFactWrites",
            "memoryRecallQueries",
            "memoryMessageSaves",
            "memoryRecallDuration",
        ]) {
            expect(barrel[name], name).toBeDefined();
        }
    });

    test("src/metrics.js re-exports the memory metric instruments", () => {
        for (const name of [
            "memoryFactReads",
            "memoryFactWrites",
            "memoryMessageSaves",
            "memoryRecallDuration",
            "memoryRecallQueries",
        ]) {
            expect(metrics[name], name).toBeDefined();
        }
    });

    test("type-only modules load as empty namespaces", () => {
        // These carry only JSDoc typedefs + `export {}`; importing them proves
        // the modules load (and keeps the coverage honest for the barrel graph).
        expect(Object.keys(memoryServiceApi)).toEqual([]);
        expect(Object.keys(memoryProcessor)).toEqual([]);
        expect(Object.keys(memoryStoreType)).toEqual([]);
    });
});

describe("MemoryStore promise wrappers: listThreads and deleteMessages", () => {
    test("listThreads returns every thread and deleteMessages prunes by id", async () => {
        const store = createMemoryStore(createTestDb());
        const t1 = await store.createThread(WF_NS, "first");
        const t2 = await store.createThread(WF_NS, "second");

        const threads = await store.listThreads();
        expect(threads.map((t) => t.threadId).sort()).toEqual(
            [t1.threadId, t2.threadId].sort(),
        );
        expect(threads.map((t) => t.title).sort()).toEqual(["first", "second"]);

        for (const id of ["m-1", "m-2", "m-3"]) {
            await store.saveMessage({
                id,
                threadId: t1.threadId,
                role: "user",
                contentJson: JSON.stringify(id),
                createdAtMs: Number(id.slice(-1)),
            });
        }
        const removed = await store.deleteMessages(t1.threadId, ["m-1", "m-2"]);
        expect(removed).toBe(2);
        const remaining = await store.listMessages(t1.threadId);
        expect(remaining.map((m) => m.id)).toEqual(["m-3"]);
    });

    test("deleteMessages with an empty id list is a no-op returning 0", async () => {
        const store = createMemoryStore(createTestDb());
        const thread = await store.createThread(WF_NS);
        expect(await store.deleteMessages(thread.threadId, [])).toBe(0);
    });
});

describe("createMemoryLayer thread accessors", () => {
    test("getThread and deleteThread flow through the Effect layer", async () => {
        const layer = createMemoryLayer({ db: createTestDb() });
        const program = Effect.gen(function* () {
            const memory = yield* MemoryService;
            const thread = yield* memory.createThread(WF_NS, "Layer Thread");
            const fetched = yield* memory.getThread(thread.threadId);
            yield* memory.deleteThread(thread.threadId);
            const afterDelete = yield* memory.getThread(thread.threadId);
            return { thread, fetched, afterDelete };
        });
        const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
        expect(result.fetched?.threadId).toBe(result.thread.threadId);
        expect(result.fetched?.title).toBe("Layer Thread");
        expect(result.afterDelete).toBeUndefined();
    });
});

describe("Summarizer extractSummary handles every agent result shape", () => {
    async function summarizeWith(agentResult) {
        const store = createMemoryStore(createTestDb());
        const thread = await store.createThread(WF_NS);
        for (const [index, role, content] of [
            [1, "user", "first old message"],
            [2, "assistant", "second old message"],
            [3, "user", "third old message"],
            [4, "assistant", "recent one"],
            [5, "user", "recent two"],
        ]) {
            await store.saveMessage({
                id: `msg-${index}`,
                threadId: thread.threadId,
                role,
                contentJson: JSON.stringify(content),
                createdAtMs: index,
            });
        }
        await Summarizer({ run: async () => agentResult }).process(store);
        const messages = await store.listMessages(thread.threadId);
        const summary = messages.find((m) => m.role === "system");
        return JSON.parse(summary.contentJson).text;
    }

    test("a bare string result is used verbatim as the summary", async () => {
        expect(await summarizeWith("plain string summary")).toBe(
            "plain string summary",
        );
    });

    test("an { output } result uses the output field", async () => {
        expect(await summarizeWith({ output: "output-shaped summary" })).toBe(
            "output-shaped summary",
        );
    });

    test("an unrecognized result falls back to JSON.stringify", async () => {
        expect(await summarizeWith({ tokens: 3, done: true })).toBe(
            JSON.stringify({ tokens: 3, done: true }),
        );
    });

    test("a thread at or below the recent-message floor is left untouched", async () => {
        // Two messages == RECENT_MESSAGE_COUNT, so there is nothing old to fold:
        // the thread is skipped and the agent is never called.
        const store = createMemoryStore(createTestDb());
        const thread = await store.createThread(WF_NS);
        for (const [index, role] of [
            [1, "user"],
            [2, "assistant"],
        ]) {
            await store.saveMessage({
                id: `keep-${index}`,
                threadId: thread.threadId,
                role,
                contentJson: JSON.stringify(`msg ${index}`),
                createdAtMs: index,
            });
        }
        let called = false;
        await Summarizer({
            run: async () => {
                called = true;
                return "unused";
            },
        }).process(store);
        expect(called).toBe(false);
        const messages = await store.listMessages(thread.threadId);
        expect(messages.map((m) => m.id)).toEqual(["keep-1", "keep-2"]);
    });
});
