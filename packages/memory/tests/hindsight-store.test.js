import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createHindsightMemoryStore } from "../src/HindsightMemoryStore.js";
import { createMemoryStore } from "../src/store/createMemoryStore.js";
import { memoryStoreConcurrencyContract } from "./memoryStoreConcurrencyContract.js";

const WF_NS = { kind: "workflow", id: "test-wf" };

/** @param {unknown} value @param {number} [status] */
function json(value, status = 200) {
    return Response.json(value, { status });
}

function createFakeHindsight() {
    /** @type {Map<string, Map<string, any>>} */
    const banks = new Map();
    /** @type {Array<{ method: string; path: string; authorization: string | null; body?: any }>} */
    const requests = [];
    /** @type {Map<string, string>} */
    const mentalModels = new Map();
    /** @type {Map<string, any[]>} */
    const recallOverrides = new Map();

    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
            const body = ["POST", "PUT", "PATCH"].includes(request.method)
                ? await request.json()
                : undefined;
            requests.push({
                method: request.method,
                path: `${url.pathname}${url.search}`,
                authorization: request.headers.get("authorization"),
                ...(body === undefined ? {} : { body }),
            });

            if (request.method === "GET" && url.pathname === "/v1/default/banks") {
                return json({ banks: [...banks].map(([bank_id]) => ({ bank_id })) });
            }
            if (segments.slice(0, 3).join("/") !== "v1/default/banks" || segments.length < 4) {
                return json({ detail: "not found" }, 404);
            }
            const bank = segments[3];
            const documents = banks.get(bank) ?? new Map();
            banks.set(bank, documents);

            if (request.method === "POST" && segments[4] === "memories" && segments.length === 5) {
                for (const item of body.items ?? []) {
                    const id = item.document_id ?? crypto.randomUUID();
                    const previous = documents.get(id);
                    const now = new Date().toISOString();
                    const original_text = item.update_mode === "append" && previous
                        ? `${previous.original_text}\n${item.content}`
                        : item.content;
                    documents.set(id, {
                        id,
                        bank_id: bank,
                        original_text,
                        content_hash: "fake",
                        created_at: previous?.created_at ?? now,
                        updated_at: now,
                        memory_unit_count: 1,
                        tags: item.tags ?? [],
                        update_mode: item.update_mode ?? "replace",
                    });
                }
                return json({
                    success: true,
                    bank_id: bank,
                    items_count: body.items?.length ?? 0,
                    async: body.async ?? false,
                    ...(body.async ? { operation_id: crypto.randomUUID() } : {}),
                });
            }
            if (request.method === "POST" && segments[4] === "memories" && segments[5] === "recall") {
                const query = String(body.query ?? "").toLowerCase();
                const results = recallOverrides.get(bank) ?? [...documents.values()]
                    .filter((document) => document.original_text.toLowerCase().includes(query))
                    .map((document) => ({
                        id: `memory-${document.id}`,
                        text: document.original_text,
                        document_id: document.id,
                        tags: document.tags,
                    }));
                return json({ results });
            }
            if (segments[4] === "documents" && segments.length === 5 && request.method === "GET") {
                const limit = Number(url.searchParams.get("limit") ?? 100);
                const offset = Number(url.searchParams.get("offset") ?? 0);
                const items = [...documents.values()].slice(offset, offset + limit);
                return json({ items, total: documents.size, limit, offset });
            }
            if (segments[4] === "documents" && segments[5]) {
                const id = segments[5];
                if (request.method === "GET") {
                    const document = documents.get(id);
                    return document ? json(document) : json({ detail: "not found" }, 404);
                }
                if (request.method === "DELETE") {
                    documents.delete(id);
                    return new Response(null, { status: 204 });
                }
            }
            if (request.method === "GET" && segments[4] === "mental-models" && segments[5]) {
                const id = segments[5];
                const content = mentalModels.get(`${bank}/${id}`);
                return content === undefined
                    ? json({ detail: "not found" }, 404)
                    : json({ id, bank_id: bank, name: id, content, tags: [] });
            }
            return json({ detail: "not found" }, 404);
        },
    });

    return {
        baseUrl: `http://127.0.0.1:${server.port}`,
        banks,
        mentalModels,
        recallOverrides,
        requests,
        stop: () => server.stop(true),
    };
}

/** @type {ReturnType<typeof createFakeHindsight> | undefined} */
let fixture;
/** @type {Database | undefined} */
let contractSqlite;
afterEach(() => {
    fixture?.stop();
    fixture = undefined;
    contractSqlite?.close();
    contractSqlite = undefined;
});

function createContractStore() {
    contractSqlite = new Database(":memory:");
    const db = drizzle(contractSqlite);
    ensureSmithersTables(db);
    return createMemoryStore(db);
}

function createStore() {
    fixture = createFakeHindsight();
    return createHindsightMemoryStore({
        baseUrl: fixture.baseUrl,
        apiKey: "test-key",
        bankPrefix: "test-",
        contractStore: createContractStore(),
    });
}

memoryStoreConcurrencyContract("HindsightMemoryStore", async () => {
    const remote = createFakeHindsight();
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const contractStore = createMemoryStore(db);
    const options = {
        baseUrl: remote.baseUrl,
        bankPrefix: "contract-",
        contractStore,
    };
    return {
        store: createHindsightMemoryStore(options),
        secondStore: createHindsightMemoryStore(options),
        cleanup: () => {
            remote.stop();
            sqlite.close();
        },
    };
});

describe("HindsightMemoryStore", () => {
    test("maps exact facts to stable replace documents and preserves provenance", async () => {
        const store = createStore();
        await store.setFact(WF_NS, "decision", { use: "postgres" }, 5000, {
            runId: "run-1",
            nodeId: "design",
            iteration: 2,
        });
        const first = await store.getFact(WF_NS, "decision");
        expect(JSON.parse(first.valueJson)).toEqual({ use: "postgres" });
        expect(first.runId).toBe("run-1");
        expect(first.ttlMs).toBe(5000);

        await store.setFact(WF_NS, "decision", { use: "hindsight" });
        const updated = await Effect.runPromise(store.getFactEffect(WF_NS, "decision"));
        expect(JSON.parse(updated.valueJson)).toEqual({ use: "hindsight" });
        expect(updated.createdAtMs).toBe(first.createdAtMs);
        expect(await store.listFacts(WF_NS)).toHaveLength(1);

        const retains = fixture.requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/memories"));
        expect(retains).toHaveLength(2);
        expect(retains[0].authorization).toBe("Bearer test-key");
        expect(retains[0].body.items[0]).toMatchObject({
            update_mode: "replace",
            tags: ["smithers:record:fact", "source:smithers"],
            metadata: {
                smithers_record_type: "fact",
                runId: "run-1",
                nodeId: "design",
                iteration: "2",
            },
        });
        expect(retains[1].body.items[0].document_id).toBe(retains[0].body.items[0].document_id);
        expect(retains[0].path).toBe("/v1/default/banks/test-workflow-test-wf/memories");

        await store.deleteFact(WF_NS, "missing");
        expect(fixture.requests.filter((entry) => entry.method === "DELETE")).toHaveLength(0);
        await store.deleteFact(WF_NS, "decision");
        expect(await store.getFact(WF_NS, "decision")).toBeUndefined();
    });

    test("implements threads, messages, and note supersession over typed documents", async () => {
        const store = createStore();
        const thread = await store.createThread(WF_NS, "Design");
        await store.saveMessage({
            id: "message-1",
            threadId: thread.threadId,
            role: "assistant",
            contentJson: JSON.stringify({ text: "Use Hindsight" }),
            runId: "run-2",
            nodeId: "review",
        });
        expect(await store.countMessages(thread.threadId)).toBe(1);
        expect((await store.listMessages(thread.threadId))[0].createdAtMs).toBeNumber();
        const messageRetain = fixture.requests.find((entry) =>
            entry.method === "POST" && entry.body?.items?.[0]?.metadata?.session === thread.threadId);
        expect(messageRetain.body.items[0].metadata).toMatchObject({
            session: thread.threadId,
            run: "run-2",
            node: "review",
        });

        const old = await store.saveNote({ namespace: WF_NS, body: "Use SQLite", id: "old" });
        await store.saveNote({
            namespace: WF_NS,
            body: "Use Hindsight",
            id: "new",
            supersedes: [old.id],
        });
        expect((await store.listNotes(WF_NS)).map((note) => note.id)).toEqual(["new"]);
        expect((await store.listNotes(WF_NS, { includeSuperseded: true })).map((note) => note.id).sort()).toEqual(["new", "old"]);
        expect((await store.searchNotes("workflow", "Hindsight")).map((note) => note.id)).toEqual(["new"]);
        const noteRecall = fixture.requests.find((entry) => entry.path.endsWith("/memories/recall"));
        expect(noteRecall.body.tag_groups).toEqual([{
            tags: ["smithers:record:note"],
            match: "all_strict",
        }]);
        expect(noteRecall.body).not.toHaveProperty("tags");

        expect(await store.deleteMessages(thread.threadId, ["message-1", "missing"])).toBe(1);
        expect(await store.listMessages(thread.threadId)).toEqual([]);
        await store.deleteThread(thread.threadId);
        expect(await store.getThread(thread.threadId)).toBeUndefined();
    });

    test("uses tag_groups-only recall filters and append retention metadata", async () => {
        const store = createStore();
        fixture.recallOverrides.set("test-project-7", [{
            id: "memory-1",
            text: "The project uses Postgres.",
            document_id: "source-1",
        }]);
        const results = await store.recallMemory({
            banks: ["project-7"],
            query: "database choice",
            tags: ["branch:main", "scope:main"],
            budget: "high",
            maxTokens: 900,
        });
        expect(results[0]).toMatchObject({ bank: "test-project-7", text: "The project uses Postgres." });
        const recall = fixture.requests.find((entry) => entry.path.endsWith("/memories/recall"));
        expect(recall.body).toMatchObject({
            query: "database choice",
            budget: "high",
            max_tokens: 900,
            tag_groups: [{ tags: ["branch:main", "scope:main"], match: "all_strict" }],
        });
        expect(recall.body).not.toHaveProperty("tags");
        expect(recall.body).not.toHaveProperty("tags_match");

        await store.retainMemory({
            bank: "project-7",
            content: "Task completed successfully.",
            tags: ["branch:main", "source:run"],
            metadata: { session: "session-9", run: "run-9", node: "implement" },
            documentId: "smithers-run-run-9",
            updateMode: "append",
        });
        const retain = fixture.requests.filter((entry) => entry.path.endsWith("/memories")).at(-1);
        expect(retain.body).toMatchObject({
            async: true,
            items: [{
                content: "Task completed successfully.",
                document_id: "smithers-run-run-9",
                update_mode: "append",
                tags: ["branch:main", "source:run"],
                metadata: { session: "session-9", run: "run-9", node: "implement" },
            }],
        });
    });

    test("uses independent compound filters for user and project banks", async () => {
        const store = createStore();
        fixture.recallOverrides.set("test-user-3", [{ id: "user-memory", text: "Use concise answers." }]);
        fixture.recallOverrides.set("test-project-7", [{ id: "project-memory", text: "Use the feature lane." }]);
        const projectGroups = [
            {
                or: [
                    { tags: ["scope:main"], match: "all_strict" },
                    { tags: ["branch:feature"], match: "all_strict" },
                ],
            },
            { tags: ["stream:checkout"], match: "all_strict" },
        ];

        const results = await store.recallMemory({
            banks: ["user-3", "project-7"],
            query: "implementation guidance",
            budget: "mid",
            maxTokens: 800,
            tagGroupsByBank: { "project-7": projectGroups },
        });

        expect(results.map((result) => result.bank).sort()).toEqual(["test-project-7", "test-user-3"]);
        const recalls = fixture.requests.filter((entry) => entry.path.endsWith("/memories/recall"));
        expect(recalls).toHaveLength(2);
        const userRecall = recalls.find((entry) => entry.path.includes("/test-user-3/"));
        const projectRecall = recalls.find((entry) => entry.path.includes("/test-project-7/"));
        expect(userRecall.body).not.toHaveProperty("tags");
        expect(userRecall.body).not.toHaveProperty("tag_groups");
        expect(projectRecall.body.tag_groups).toEqual(projectGroups);
        expect(projectRecall.body).not.toHaveProperty("tags");
        expect(projectRecall.body).not.toHaveProperty("tags_match");
        expect(projectRecall.body.max_tokens).toBe(400);
    });

    test("normalizes recall rows under one aggregate cap when tokens are fewer than banks", async () => {
        const store = createStore();
        for (const bank of ["test-project-a", "test-project-b", "test-project-c"]) {
            fixture.recallOverrides.set(bank, [{
                id: `memory-${bank}`,
                text: "A long recalled fact that must be bounded across every configured bank.",
                document_id: `document-${bank}`,
                tags: ["scope:main"],
                metadata: { oversized: "x".repeat(2_000) },
            }]);
        }

        const tiny = await store.recallMemory({
            banks: ["project-a", "project-b", "project-c"],
            query: "fact",
            maxTokens: 2,
        });
        expect(JSON.stringify(tiny).length).toBeLessThanOrEqual(8);
        const tinyRequests = fixture.requests.filter((entry) => entry.path.endsWith("/memories/recall"));
        expect(tinyRequests).toHaveLength(3);
        expect(tinyRequests.every((entry) => entry.body.max_tokens === 1)).toBe(true);

        const bounded = await store.recallMemory({
            banks: ["project-a", "project-b", "project-c"],
            query: "fact",
            maxTokens: 30,
        });
        expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(120);
        expect(bounded.length).toBeGreaterThan(0);
        expect(Object.keys(bounded[0]).sort()).toEqual(["bank", "text"]);
    });

    test("keeps valid mixed-bank primers when other bank/id pairs are missing", async () => {
        const store = createStore();
        fixture.mentalModels.set("test-user-3/user-primer", "# User primer\nPrefer concise answers.");
        fixture.mentalModels.set("test-project-7/project-primer", "# Architecture\nPostgres is canonical.");
        await expect(store.getPrimers({
            banks: ["user-3", "project-7"],
            primerIds: ["user-primer", "project-primer"],
        })).resolves.toEqual([
            {
                bank: "test-user-3",
                id: "user-primer",
                content: "# User primer\nPrefer concise answers.",
            },
            {
                bank: "test-project-7",
                id: "project-primer",
                content: "# Architecture\nPostgres is canonical.",
            },
        ]);
    });
});
