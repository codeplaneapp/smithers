// Spike acceptance tests for the durable-knowledge substrate (upstream-memory RFC).
// Criteria covered here:
//   (a) P1 provenance on both write paths (facts + messages, and notes)
//   (c) a pending/rejected superseder hides nothing
//   (d) supersession chains read correctly
//   (e) FTS is lazy per namespace kind; fact writes are unaffected
//   (f) the migration is additive on a db with existing facts
// Criterion (b) — consolidation end-to-end under the engine — lives in
// packages/smithers/tests/memory-consolidation.e2e.test.jsx.
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createMemoryStore } from "../src/store/index.js";

function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { db, sqlite };
}

const USER_NS = { kind: "user", id: "spike" };
const GLOBAL_NS = { kind: "global", id: "org" };
const PROV = { runId: "run-1", nodeId: "node-a", iteration: 2 };

describe("P1 provenance (criterion a)", () => {
    let store;
    let sqlite;
    beforeEach(() => {
        const ctx = createTestDb();
        sqlite = ctx.sqlite;
        store = createMemoryStore(ctx.db);
    });

    test("setFact stamps provenance when given, null when not", async () => {
        await store.setFact(USER_NS, "with", 1, undefined, PROV);
        await store.setFact(USER_NS, "without", 2);
        const withProv = await store.getFact(USER_NS, "with");
        expect(withProv.runId).toBe("run-1");
        expect(withProv.nodeId).toBe("node-a");
        expect(withProv.iteration).toBe(2);
        const withoutProv = await store.getFact(USER_NS, "without");
        expect(withoutProv.runId).toBeNull();
        expect(withoutProv.nodeId).toBeNull();
        expect(withoutProv.iteration).toBeNull();
    });

    test("fact upsert records the LAST writer's provenance", async () => {
        await store.setFact(USER_NS, "k", 1, undefined, PROV);
        await store.setFact(USER_NS, "k", 2, undefined, { runId: "run-2" });
        const fact = await store.getFact(USER_NS, "k");
        expect(fact.runId).toBe("run-2");
        expect(fact.nodeId).toBeNull(); // stamp is whole-provenance, not merged
        expect(JSON.parse(fact.valueJson)).toBe(2);
    });

    test("saveMessage carries iteration alongside runId/nodeId", async () => {
        const thread = await store.createThread(USER_NS, "t");
        await store.saveMessage({
            id: "m1",
            threadId: thread.threadId,
            role: "assistant",
            contentJson: JSON.stringify({ text: "hi" }),
            runId: "run-1",
            nodeId: "node-a",
            iteration: 3,
        });
        const [msg] = await store.listMessages(thread.threadId);
        expect(msg.runId).toBe("run-1");
        expect(msg.nodeId).toBe("node-a");
        expect(msg.iteration).toBe(3);
    });

    test("saveNote stamps provenance immutably", async () => {
        const note = await store.saveNote({ namespace: USER_NS, body: "observed X", provenance: PROV });
        const read = await store.getNote(note.id);
        expect(read.runId).toBe("run-1");
        expect(read.nodeId).toBe("node-a");
        expect(read.iteration).toBe(2);
    });

    test("existing callers are untouched: 4-arg setFact still works", async () => {
        await store.setFact(USER_NS, "legacy", { v: 1 }, 60_000);
        const fact = await store.getFact(USER_NS, "legacy");
        expect(JSON.parse(fact.valueJson)).toEqual({ v: 1 });
        expect(fact.ttlMs).toBe(60_000);
    });
});

describe("notes: append-only + default read contract", () => {
    let store;
    beforeEach(() => {
        store = createMemoryStore(createTestDb().db);
    });

    test("saveNote defaults status to accepted; default read returns it", async () => {
        const note = await store.saveNote({ namespace: USER_NS, body: "a decision" });
        expect(note.status).toBe("accepted");
        const notes = await store.listNotes(USER_NS);
        expect(notes).toHaveLength(1);
        expect(notes[0].body).toBe("a decision");
    });

    test("default read excludes pending and rejected notes; filters widen", async () => {
        await store.saveNote({ namespace: USER_NS, body: "accepted one" });
        await store.saveNote({ namespace: USER_NS, body: "pending one", status: "pending" });
        await store.saveNote({ namespace: USER_NS, body: "rejected one", status: "rejected" });
        const defaults = await store.listNotes(USER_NS);
        expect(defaults.map((n) => n.body)).toEqual(["accepted one"]);
        const pending = await store.listNotes(USER_NS, { status: "pending" });
        expect(pending.map((n) => n.body)).toEqual(["pending one"]);
        const everything = await store.listNotes(USER_NS, { status: "any" });
        expect(everything).toHaveLength(3);
    });

    test("saveNote is idempotent on id (no upsert — history cannot be destroyed)", async () => {
        await store.saveNote({ namespace: USER_NS, body: "original", id: "fixed-id" });
        const resaved = await store.saveNote({ namespace: USER_NS, body: "SHOULD NOT REPLACE", id: "fixed-id" });
        // The return value reflects the PERSISTED row, not the ignored input.
        expect(resaved.body).toBe("original");
        const note = await store.getNote("fixed-id");
        expect(note.body).toBe("original");
    });

    test("setNoteStatus flips status + stamps status_changed_at; missing note fails loud", async () => {
        const note = await store.saveNote({ namespace: USER_NS, body: "b", status: "pending" });
        expect(note.statusChangedAtMs).toBeNull();
        await store.setNoteStatus(note.id, "accepted");
        const read = await store.getNote(note.id);
        expect(read.status).toBe("accepted");
        expect(read.statusChangedAtMs).toBeGreaterThan(0);
        await expect(store.setNoteStatus("nope", "accepted")).rejects.toThrow();
    });

    test("kind/tags/author are stored policy-free", async () => {
        const note = await store.saveNote({
            namespace: USER_NS,
            body: "tagged",
            kind: "decision",
            tags: ["auth", "security"],
            author: "j",
        });
        const read = await store.getNote(note.id);
        expect(read.kind).toBe("decision");
        expect(JSON.parse(read.tagsJson)).toEqual(["auth", "security"]);
        expect(read.author).toBe("j");
        const byKind = await store.listNotes(USER_NS, { kind: "decision" });
        expect(byKind).toHaveLength(1);
    });

    test("namespaces are isolated", async () => {
        await store.saveNote({ namespace: USER_NS, body: "user note" });
        await store.saveNote({ namespace: GLOBAL_NS, body: "global note" });
        const userNotes = await store.listNotes(USER_NS);
        expect(userNotes.map((n) => n.body)).toEqual(["user note"]);
    });
});

describe("supersession semantics (criteria c + d)", () => {
    let store;
    beforeEach(() => {
        store = createMemoryStore(createTestDb().db);
    });

    test("an ACCEPTED superseder hides its N targets (consolidation shape)", async () => {
        const o1 = await store.saveNote({ namespace: USER_NS, body: "obs 1" });
        const o2 = await store.saveNote({ namespace: USER_NS, body: "obs 2" });
        const o3 = await store.saveNote({ namespace: USER_NS, body: "obs 3" });
        await store.saveNote({
            namespace: USER_NS,
            body: "synthesis of 1-3",
            supersedes: [o1.id, o2.id, o3.id],
        });
        const notes = await store.listNotes(USER_NS);
        expect(notes.map((n) => n.body)).toEqual(["synthesis of 1-3"]);
        const widened = await store.listNotes(USER_NS, { includeSuperseded: true });
        expect(widened).toHaveLength(4);
    });

    test("criterion c: a PENDING superseder hides nothing", async () => {
        const original = await store.saveNote({ namespace: USER_NS, body: "original" });
        await store.saveNote({
            namespace: USER_NS,
            body: "proposed replacement",
            status: "pending",
            supersedes: [original.id],
        });
        const notes = await store.listNotes(USER_NS);
        expect(notes.map((n) => n.body)).toEqual(["original"]);
    });

    test("criterion c: propose-supersession-then-REJECT leaves the original live", async () => {
        const original = await store.saveNote({ namespace: USER_NS, body: "original" });
        const proposal = await store.saveNote({
            namespace: USER_NS,
            body: "proposed replacement",
            status: "pending",
            supersedes: [original.id],
        });
        await store.setNoteStatus(proposal.id, "rejected");
        const notes = await store.listNotes(USER_NS);
        expect(notes.map((n) => n.body)).toEqual(["original"]);
    });

    test("approving the proposal flips visibility to the superseder", async () => {
        const original = await store.saveNote({ namespace: USER_NS, body: "original" });
        const proposal = await store.saveNote({
            namespace: USER_NS,
            body: "replacement",
            status: "pending",
            supersedes: [original.id],
        });
        await store.setNoteStatus(proposal.id, "accepted");
        const notes = await store.listNotes(USER_NS);
        expect(notes.map((n) => n.body)).toEqual(["replacement"]);
    });

    test("criterion d: chains — A < B < C reads as [C]; rejecting C revives B, not A", async () => {
        const a = await store.saveNote({ namespace: USER_NS, body: "A" });
        const b = await store.saveNote({ namespace: USER_NS, body: "B", supersedes: [a.id] });
        const c = await store.saveNote({ namespace: USER_NS, body: "C", supersedes: [b.id] });
        expect((await store.listNotes(USER_NS)).map((n) => n.body)).toEqual(["C"]);
        // A note is hidden ONLY by an accepted superseder. Rejecting C un-hides
        // B (its superseder is no longer accepted) while A stays hidden by B.
        await store.setNoteStatus(c.id, "rejected");
        expect((await store.listNotes(USER_NS)).map((n) => n.body)).toEqual(["B"]);
    });
});

describe("lazy FTS (criterion e)", () => {
    let store;
    let sqlite;
    beforeEach(() => {
        const ctx = createTestDb();
        sqlite = ctx.sqlite;
        store = createMemoryStore(ctx.db);
    });

    function ftsArtifacts() {
        return sqlite
            .query(`SELECT name FROM sqlite_master WHERE name LIKE '_smithers_memory_notes_fts%' OR name = '_smithers_memory_fts_kinds'`)
            .all();
    }

    test("no FTS artifacts exist until enableNoteSearch — fact/note writes create none", async () => {
        await store.setFact(USER_NS, "k", 1);
        await store.saveNote({ namespace: USER_NS, body: "pre-enable note about zebras" });
        expect(ftsArtifacts()).toHaveLength(0);
    });

    test("searchNotes on a never-enabled kind fails loud, not silently empty", async () => {
        await expect(store.searchNotes("user", "anything")).rejects.toThrow(/not enabled/);
    });

    test("enableNoteSearch backfills existing notes and indexes new ones", async () => {
        await store.saveNote({ namespace: USER_NS, body: "the zebra crossed the savanna" });
        await store.enableNoteSearch("user");
        expect(ftsArtifacts().length).toBeGreaterThan(0);
        const backfilled = await store.searchNotes("user", "zebra");
        expect(backfilled).toHaveLength(1);
        await store.saveNote({ namespace: USER_NS, body: "another zebra sighting at dawn" });
        const both = await store.searchNotes("user", "zebra");
        expect(both).toHaveLength(2);
    });

    test("search honors the default read contract (superseded/pending excluded, filters widen)", async () => {
        await store.enableNoteSearch("user");
        const old = await store.saveNote({ namespace: USER_NS, body: "zebra fact v1" });
        await store.saveNote({ namespace: USER_NS, body: "zebra fact v2", supersedes: [old.id] });
        await store.saveNote({ namespace: USER_NS, body: "pending zebra claim", status: "pending" });
        const defaults = await store.searchNotes("user", "zebra");
        expect(defaults.map((n) => n.body)).toEqual(["zebra fact v2"]);
        const widened = await store.searchNotes("user", "zebra", undefined, { status: "any", includeSuperseded: true });
        expect(widened).toHaveLength(3);
    });

    test("searchNotes spans every namespace of the kind; filter.namespace narrows to one", async () => {
        await store.enableNoteSearch("user");
        await store.saveNote({ namespace: USER_NS, body: "zebra lesson from our team" });
        await store.saveNote({ namespace: { kind: "user", id: "other-team" }, body: "zebra lesson from another team" });
        const kindWide = await store.searchNotes("user", "zebra");
        expect(kindWide).toHaveLength(2);
        const scoped = await store.searchNotes("user", "zebra", undefined, { namespace: USER_NS });
        expect(scoped.map((n) => n.body)).toEqual(["zebra lesson from our team"]);
    });

    test("opt-in is per namespace KIND: notes of other kinds stay unindexed", async () => {
        await store.enableNoteSearch("user");
        await store.saveNote({ namespace: GLOBAL_NS, body: "global zebra doctrine" });
        const hits = await store.searchNotes("user", "zebra");
        expect(hits).toHaveLength(0);
        await expect(store.searchNotes("global", "zebra")).rejects.toThrow(/not enabled/);
    });

    test("enableNoteSearch is idempotent", async () => {
        await store.enableNoteSearch("user");
        await store.saveNote({ namespace: USER_NS, body: "zebra" });
        await store.enableNoteSearch("user");
        const hits = await store.searchNotes("user", "zebra");
        expect(hits).toHaveLength(1); // no duplicate index rows
    });
});

describe("non-sqlite backends fail loud", () => {
    // Notes ride the synchronous sqlite driver (sync transactions + FTS5).
    // A Postgres/PGlite connection descriptor (dialect: "postgres", no sync
    // drizzle surface) must produce a clear error, not an obscure TypeError
    // from a missing .run()/.all().
    test("synchronous operations reject with an explicit sqlite-required error", async () => {
        const store = createMemoryStore(/** @type {any} */ ({ dialect: "postgres" }));
        await expect(store.saveNote({ namespace: USER_NS, body: "x" })).rejects.toThrow(/sqlite/);
        await expect(store.enableNoteSearch("user")).rejects.toThrow(/sqlite/);
        await expect(store.searchNotes("user", "x")).rejects.toThrow(/sqlite/);
        await expect(store.deleteThread("thread-1")).rejects.toThrow(/sqlite/);
    });
});

describe("additive migration (criterion f)", () => {
    test("a db with pre-P1 facts migrates in place: data intact, new columns + tables appear", async () => {
        const sqlite = new Database(":memory:");
        // Simulate an EXISTING deployment: the old-shape memory tables with data,
        // created before provenance columns and notes existed.
        sqlite.run(`CREATE TABLE _smithers_memory_facts (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      schema_sig TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      ttl_ms INTEGER,
      PRIMARY KEY (namespace, key)
    )`);
        sqlite.run(`INSERT INTO _smithers_memory_facts
      (namespace, key, value_json, created_at_ms, updated_at_ms)
      VALUES ('user:legacy', 'old-key', '"old-value"', 1000, 1000)`);
        const db = drizzle(sqlite);
        // Boot the new code — CREATE IF NOT EXISTS leaves the old table, the
        // column migrations ALTER the provenance columns in, 0023 adds notes.
        ensureSmithersTables(db);
        const store = createMemoryStore(db);
        // Old data survives and reads through the new projection.
        const legacy = await store.getFact({ kind: "user", id: "legacy" }, "old-key");
        expect(JSON.parse(legacy.valueJson)).toBe("old-value");
        expect(legacy.runId).toBeNull();
        // New columns are writable on the migrated table.
        await store.setFact({ kind: "user", id: "legacy" }, "new-key", 1, undefined, { runId: "r" });
        expect((await store.getFact({ kind: "user", id: "legacy" }, "new-key")).runId).toBe("r");
        // The notes tables arrived alongside.
        const note = await store.saveNote({ namespace: USER_NS, body: "post-migration note" });
        expect((await store.getNote(note.id)).body).toBe("post-migration note");
    });
});
