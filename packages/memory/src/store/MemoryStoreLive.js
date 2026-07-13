import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect, Layer, Metric } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { dbQueryDuration } from "@smithers-orchestrator/observability/metrics";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { namespaceToString } from "../namespaceToString.js";
import { parseNamespace } from "../parseNamespace.js";
import { smithersMemoryFacts, smithersMemoryThreads, smithersMemoryMessages, smithersMemoryNotes, smithersMemoryNoteSupersessions, } from "../schema.js";
import { memoryFactReads } from "../memoryFactReads.js";
import { memoryFactWrites } from "../memoryFactWrites.js";
import { memoryMessageSaves } from "../memoryMessageSaves.js";
import { MemoryStoreDb } from "./MemoryStoreDb.js";
import { MemoryStoreService } from "./MemoryStoreService.js";
/** @typedef {import("./MemoryStore.ts").MemoryStore} MemoryStore */
/** @typedef {import("../MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */
/** @typedef {import("../MemoryFact.ts").MemoryFact} MemoryFact */
/** @typedef {import("../MemoryNote.ts").MemoryNote} MemoryNote */
/** @typedef {import("../SaveNoteInput.ts").SaveNoteInput} SaveNoteInput */
/** @typedef {import("../NoteReadFilter.ts").NoteReadFilter} NoteReadFilter */
/** @typedef {import("../MemoryProvenance.ts").MemoryProvenance} MemoryProvenance */
/** @typedef {import("../MemoryMessage.ts").MemoryMessage} MemoryMessage */
/** @typedef {import("../MemoryThread.ts").MemoryThread} MemoryThread */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */

/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Wrap a raw drizzle promise in the standard instrumentation every store
 * operation shares: typed SmithersError on failure (with the given code),
 * dbQueryDuration sample on success, log annotation, and a log span.
 * @param {"DB_QUERY_FAILED" | "DB_WRITE_FAILED"} code
 * @returns {<A>(label: string, operation: () => PromiseLike<A>) => Effect.Effect<A, SmithersError>}
 */
function instrumentedDbEffect(code) {
    return (label, operation) => Effect.gen(function* () {
        const start = performance.now();
        const result = yield* Effect.tryPromise({
            try: () => operation(),
            catch: (cause) => toSmithersError(cause, label, {
                code,
                details: { operation: label },
            }),
        });
        yield* Metric.update(dbQueryDuration, performance.now() - start);
        return result;
    }).pipe(Effect.annotateLogs({ dbOperation: label }), Effect.withLogSpan(`memory:${label}`));
}
const readEffect = instrumentedDbEffect("DB_QUERY_FAILED");
const writeEffect = instrumentedDbEffect("DB_WRITE_FAILED");
const DELETE_MESSAGES_CHUNK_SIZE = 900;
/**
 * Project a fact row onto the declared MemoryFact shape so extra drizzle
 * columns can never leak through the public type.
 * @param {typeof smithersMemoryFacts.$inferSelect} row
 * @returns {MemoryFact}
 */
function toFact(row) {
    return {
        namespace: row.namespace,
        key: row.key,
        valueJson: row.valueJson,
        schemaSig: row.schemaSig,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
        ttlMs: row.ttlMs,
        runId: row.runId,
        nodeId: row.nodeId,
        iteration: row.iteration,
    };
}
/**
 * Project a note row onto the declared MemoryNote shape.
 * @param {typeof smithersMemoryNotes.$inferSelect} row
 * @returns {MemoryNote}
 */
function toNote(row) {
    return {
        id: row.id,
        namespace: row.namespace,
        body: row.body,
        kind: row.kind,
        tagsJson: row.tagsJson,
        author: row.author,
        status: row.status,
        statusChangedAtMs: row.statusChangedAtMs,
        createdAtMs: row.createdAtMs,
        runId: row.runId,
        nodeId: row.nodeId,
        iteration: row.iteration,
    };
}
/**
 * The default read contract's supersession predicate: a note is hidden ONLY
 * when a junction row points at it from a note whose CURRENT status is
 * accepted. A pending or rejected superseder hides nothing — so
 * propose-supersession-then-reject leaves the original live.
 */
const NOT_SUPERSEDED_BY_ACCEPTED = sql `NOT EXISTS (
    SELECT 1 FROM _smithers_memory_note_supersessions __s
    JOIN _smithers_memory_notes __sup ON __sup.id = __s.note_id
    WHERE __s.supersedes_id = ${smithersMemoryNotes.id} AND __sup.status = 'accepted'
  )`;
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * @param {BunSQLiteDatabase<any>} db
 * @returns {MemoryStore}
 */
function makeMemoryStore(db) {
    // --- Working Memory Effects ---
    /**
   * @param {MemoryNamespace} ns
   * @param {string} key
   * @returns {Effect.Effect<MemoryFact | undefined, SmithersError>}
   */
    function getFactEffect(ns, key) {
        const nsStr = namespaceToString(ns);
        return Effect.gen(function* () {
            yield* Metric.increment(memoryFactReads);
            const rows = yield* readEffect("memory getFact", () => db
                .select()
                .from(smithersMemoryFacts)
                .where(and(eq(smithersMemoryFacts.namespace, nsStr), eq(smithersMemoryFacts.key, key)))
                .limit(1));
            const row = rows[0];
            if (!row)
                return undefined;
            return toFact(row);
        });
    }
    /**
   * @param {MemoryNamespace} ns
   * @param {string} key
   * @param {unknown} value
   * @param {number} [ttlMs]
   * @param {MemoryProvenance} [provenance] Run coordinate of this write; a fact
   *   records the LAST writer (upsert semantics). Explicit by design — never
   *   inferred from ambient context.
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function setFactEffect(ns, key, value, ttlMs, provenance) {
        const nsStr = namespaceToString(ns);
        const now = nowMs();
        const stamp = {
            runId: provenance?.runId ?? null,
            nodeId: provenance?.nodeId ?? null,
            iteration: provenance?.iteration ?? null,
        };
        return Effect.gen(function* () {
            yield* Metric.increment(memoryFactWrites);
            yield* writeEffect("memory setFact", () => db
                .insert(smithersMemoryFacts)
                .values({
                namespace: nsStr,
                key,
                valueJson: JSON.stringify(value),
                createdAtMs: now,
                updatedAtMs: now,
                ttlMs: ttlMs ?? null,
                ...stamp,
            })
                .onConflictDoUpdate({
                target: [smithersMemoryFacts.namespace, smithersMemoryFacts.key],
                set: {
                    valueJson: JSON.stringify(value),
                    updatedAtMs: now,
                    ttlMs: ttlMs ?? null,
                    ...stamp,
                },
            }));
        });
    }
    /**
   * @param {MemoryNamespace} ns
   * @param {string} key
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function deleteFactEffect(ns, key) {
        const nsStr = namespaceToString(ns);
        return writeEffect("memory deleteFact", () => db
            .delete(smithersMemoryFacts)
            .where(and(eq(smithersMemoryFacts.namespace, nsStr), eq(smithersMemoryFacts.key, key)))).pipe(Effect.asVoid);
    }
    /**
   * @param {MemoryNamespace} ns
   * @returns {Effect.Effect<MemoryFact[], SmithersError>}
   */
    function listFactsEffect(ns) {
        const nsStr = namespaceToString(ns);
        return readEffect("memory listFacts", () => db
            .select()
            .from(smithersMemoryFacts)
            .where(eq(smithersMemoryFacts.namespace, nsStr))
            .orderBy(smithersMemoryFacts.key)).pipe(Effect.map((rows) => rows.map(toFact)));
    }
    /**
   * List every fact across all namespaces, ordered by namespace then key.
   * @returns {Effect.Effect<MemoryFact[], SmithersError>}
   */
    function listAllFactsEffect() {
        return readEffect("memory listAllFacts", () => db
            .select()
            .from(smithersMemoryFacts)
            .orderBy(smithersMemoryFacts.namespace, smithersMemoryFacts.key)).pipe(Effect.map((rows) => rows.map(toFact)));
    }
    // --- Thread Effects ---
    /**
   * @param {MemoryNamespace} ns
   * @param {string} [title]
   * @returns {Effect.Effect<MemoryThread, SmithersError>}
   */
    function createThreadEffect(ns, title) {
        const nsStr = namespaceToString(ns);
        const now = nowMs();
        const threadId = crypto.randomUUID();
        const thread = {
            threadId,
            namespace: nsStr,
            title: title ?? null,
            metadataJson: null,
            createdAtMs: now,
            updatedAtMs: now,
        };
        return writeEffect("memory createThread", () => db.insert(smithersMemoryThreads).values(thread)).pipe(Effect.map(() => thread));
    }
    /**
   * @param {string} threadId
   * @returns {Effect.Effect<MemoryThread | undefined, SmithersError>}
   */
    function getThreadEffect(threadId) {
        return readEffect("memory getThread", () => db
            .select()
            .from(smithersMemoryThreads)
            .where(eq(smithersMemoryThreads.threadId, threadId))
            .limit(1)).pipe(Effect.map((rows) => rows[0]));
    }
    /**
   * @returns {Effect.Effect<MemoryThread[], SmithersError>}
   */
    function listThreadsEffect() {
        return readEffect("memory listThreads", () => db
            .select()
            .from(smithersMemoryThreads)
            .orderBy(smithersMemoryThreads.createdAtMs)).pipe(Effect.map((rows) => rows.map((row) => ({
            threadId: row.threadId,
            namespace: row.namespace,
            title: row.title,
            metadataJson: row.metadataJson,
            createdAtMs: row.createdAtMs,
            updatedAtMs: row.updatedAtMs,
        }))));
    }
    /**
   * @param {string} threadId
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function deleteThreadEffect(threadId) {
        // Delete the messages and the thread row atomically so a failure on the
        // second write can't leave the thread without its messages (or vice versa).
        return writeEffect("memory deleteThread", () => Promise.resolve(
            db.transaction((tx) => {
                tx.delete(smithersMemoryMessages)
                    .where(eq(smithersMemoryMessages.threadId, threadId))
                    .run();
                tx.delete(smithersMemoryThreads)
                    .where(eq(smithersMemoryThreads.threadId, threadId))
                    .run();
            }),
        ));
    }
    // --- Message Effects ---
    /**
   * @param {Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number }} msg
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function saveMessageEffect(msg) {
        return Effect.gen(function* () {
            yield* Metric.increment(memoryMessageSaves);
            const createdAtMs = msg.createdAtMs ?? nowMs();
            // Idempotent: re-saving a message with the same id (e.g. on
            // crash-resume, deterministic replay, or fork/restore where ids are
            // derived deterministically) must be a safe no-op upsert rather than
            // a UNIQUE-constraint crash. Mirrors setFact's onConflictDoUpdate.
            yield* writeEffect("memory saveMessage", () => db
                .insert(smithersMemoryMessages)
                .values({
                id: msg.id,
                threadId: msg.threadId,
                role: msg.role,
                contentJson: msg.contentJson,
                runId: msg.runId ?? null,
                nodeId: msg.nodeId ?? null,
                iteration: msg.iteration ?? null,
                createdAtMs,
            })
                .onConflictDoUpdate({
                target: smithersMemoryMessages.id,
                set: {
                    threadId: msg.threadId,
                    role: msg.role,
                    contentJson: msg.contentJson,
                    runId: msg.runId ?? null,
                    nodeId: msg.nodeId ?? null,
                    iteration: msg.iteration ?? null,
                },
            }));
        });
    }
    /**
   * @param {string} threadId
   * @param {number} [limit]
   * @returns {Effect.Effect<MemoryMessage[], SmithersError>}
   */
    function listMessagesEffect(threadId, limit) {
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
            return Effect.fail(new SmithersError("INVALID_INPUT", "memory listMessages limit must be a non-negative integer.", { limit }));
        }
        return readEffect("memory listMessages", () => {
            let query = db
                .select()
                .from(smithersMemoryMessages)
                .where(eq(smithersMemoryMessages.threadId, threadId))
                .orderBy(smithersMemoryMessages.createdAtMs, smithersMemoryMessages.id);
            if (limit !== undefined) {
                query = query.limit(limit);
            }
            return query;
        }).pipe(Effect.map((rows) => rows.map((row) => ({
            id: row.id,
            threadId: row.threadId,
            role: row.role,
            contentJson: row.contentJson,
            runId: row.runId,
            nodeId: row.nodeId,
            iteration: row.iteration,
            createdAtMs: row.createdAtMs,
        }))));
    }
    /**
   * @param {string} threadId
   * @returns {Effect.Effect<number, SmithersError>}
   */
    function countMessagesEffect(threadId) {
        return readEffect("memory countMessages", () => db
            .select({ count: sql `count(*)` })
            .from(smithersMemoryMessages)
            .where(eq(smithersMemoryMessages.threadId, threadId))).pipe(Effect.map((rows) => rows[0]?.count ?? 0));
    }
    /**
   * @param {string} threadId
   * @param {string[]} messageIds
   * @returns {Effect.Effect<number, SmithersError>}
   */
    function deleteMessagesEffect(threadId, messageIds) {
        if (messageIds.length === 0) {
            return Effect.succeed(0);
        }
        return writeEffect("memory deleteMessages", async () => {
            let deleted = 0;
            for (let offset = 0; offset < messageIds.length; offset += DELETE_MESSAGES_CHUNK_SIZE) {
                const chunk = messageIds.slice(offset, offset + DELETE_MESSAGES_CHUNK_SIZE);
                const result = await db
                    .delete(smithersMemoryMessages)
                    .where(and(eq(smithersMemoryMessages.threadId, threadId), inArray(smithersMemoryMessages.id, chunk)));
                deleted += result?.changes ?? result?.rowsAffected ?? 0;
            }
            return deleted;
        });
    }
    // --- Note Effects (P2/P3: append-only knowledge) ---
    /**
   * Note writes and search ride the synchronous sqlite driver (sync
   * transactions for note+edge atomicity, FTS5 for search), which the
   * Postgres/PGlite backends do not provide — there, fail loud up front
   * instead of surfacing an obscure driver TypeError mid-write. Migration
   * 0023 still creates the note tables on Postgres so the data model is
   * ready when this path is ported.
   * @param {"DB_QUERY_FAILED" | "DB_WRITE_FAILED"} code
   * @param {string} label
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function requireSqliteNotesEffect(code, label) {
        const anyDb = /** @type {any} */ (db);
        if (anyDb?.dialect === "postgres" || typeof anyDb?.all !== "function") {
            return Effect.fail(toSmithersError(new Error(`${label}: memory notes require the sqlite backend (bun:sqlite) — this database does not expose the synchronous sqlite driver`), label, { code, details: { operation: label } }));
        }
        return Effect.void;
    }
    /**
   * FTS artifacts (P4) exist only after enableNoteSearch — KV-only and
   * notes-without-search users never create them and pay nothing per write.
   */
    function noteFtsReady() {
        const rows = db.all(sql `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_memory_fts_kinds'`);
        return rows.length > 0;
    }
    /**
   * @param {string} kind
   */
    function noteFtsKindEnabled(kind) {
        if (!noteFtsReady()) {
            return false;
        }
        const rows = db.all(sql `SELECT 1 AS ok FROM _smithers_memory_fts_kinds WHERE kind = ${kind}`);
        return rows.length > 0;
    }
    /**
   * Shared read-contract conditions for listNotes/searchNotes. The DEFAULT
   * (no filter) is the stability contract: (a) not superseded by an ACCEPTED
   * note, (b) status = 'accepted'. Filters widen.
   * @param {NoteReadFilter} [filter]
   */
    function noteFilterConds(filter) {
        const conds = [];
        if (!filter?.includeSuperseded) {
            conds.push(NOT_SUPERSEDED_BY_ACCEPTED);
        }
        const status = filter?.status ?? "accepted";
        if (status !== "any") {
            conds.push(Array.isArray(status)
                ? inArray(smithersMemoryNotes.status, status)
                : eq(smithersMemoryNotes.status, status));
        }
        if (filter?.kind) {
            conds.push(eq(smithersMemoryNotes.kind, filter.kind));
        }
        if (filter?.namespace) {
            conds.push(eq(smithersMemoryNotes.namespace, namespaceToString(filter.namespace)));
        }
        return conds;
    }
    /**
   * Append a note (immutable row) and its supersession edges atomically.
   * Idempotent on id (crash-resume safe): a re-save with the same id is a
   * no-op INSERT OR IGNORE — never an upsert, so history cannot be destroyed.
   * Returns the PERSISTED row: on an id conflict the note you get back is
   * the one the database holds, not the input that lost the race.
   * @param {SaveNoteInput} input
   * @returns {Effect.Effect<MemoryNote, SmithersError>}
   */
    function saveNoteEffect(input) {
        const id = input.id ?? crypto.randomUUID();
        const nsStr = namespaceToString(input.namespace);
        const now = nowMs();
        const note = {
            id,
            namespace: nsStr,
            body: input.body,
            kind: input.kind ?? null,
            tagsJson: input.tags ? JSON.stringify(input.tags) : null,
            author: input.author ?? null,
            status: input.status ?? "accepted",
            statusChangedAtMs: null,
            createdAtMs: now,
            runId: input.provenance?.runId ?? null,
            nodeId: input.provenance?.nodeId ?? null,
            iteration: input.provenance?.iteration ?? null,
        };
        const nsKind = parseNamespace(nsStr).kind;
        return requireSqliteNotesEffect("DB_WRITE_FAILED", "memory saveNote").pipe(Effect.zipRight(writeEffect("memory saveNote", () => Promise.resolve(db.transaction((tx) => {
            tx.insert(smithersMemoryNotes).values(note).onConflictDoNothing().run();
            for (const supersedesId of input.supersedes ?? []) {
                tx.insert(smithersMemoryNoteSupersessions)
                    .values({ noteId: id, supersedesId, createdAtMs: now })
                    .onConflictDoNothing()
                    .run();
            }
            if (noteFtsKindEnabled(nsKind)) {
                tx.run(sql `INSERT INTO _smithers_memory_notes_fts (note_id, kind, body)
            SELECT ${id}, ${nsKind}, ${note.body}
            WHERE NOT EXISTS (SELECT 1 FROM _smithers_memory_notes_fts WHERE note_id = ${id})`);
            }
        })))),
        // Read back so an id-conflict no-op returns the row the database
        // actually holds rather than echoing the ignored input.
        Effect.zipRight(readEffect("memory saveNote readback", () => db
            .select()
            .from(smithersMemoryNotes)
            .where(eq(smithersMemoryNotes.id, id))
            .limit(1))), Effect.map((rows) => toNote(rows[0])));
    }
    /**
   * @param {string} id
   * @returns {Effect.Effect<MemoryNote | undefined, SmithersError>}
   */
    function getNoteEffect(id) {
        return readEffect("memory getNote", () => db
            .select()
            .from(smithersMemoryNotes)
            .where(eq(smithersMemoryNotes.id, id))
            .limit(1)).pipe(Effect.map((rows) => (rows[0] ? toNote(rows[0]) : undefined)));
    }
    /**
   * @param {MemoryNamespace} ns
   * @param {NoteReadFilter} [filter]
   * @returns {Effect.Effect<MemoryNote[], SmithersError>}
   */
    function listNotesEffect(ns, filter) {
        const nsStr = namespaceToString(ns);
        return readEffect("memory listNotes", () => db
            .select()
            .from(smithersMemoryNotes)
            .where(and(eq(smithersMemoryNotes.namespace, nsStr), ...noteFilterConds(filter)))
            .orderBy(smithersMemoryNotes.createdAtMs)).pipe(Effect.map((rows) => rows.map(toNote)));
    }
    /**
   * Flip a note's status — the ONE mutable exception to append-only. Body,
   * labels, provenance, and supersession edges never change; the gate writes
   * an answer about an existing note. Fails loud when the note is missing.
   * @param {string} id
   * @param {string} status
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function setNoteStatusEffect(id, status) {
        const now = nowMs();
        return writeEffect("memory setNoteStatus", () => db
            .update(smithersMemoryNotes)
            .set({ status, statusChangedAtMs: now })
            .where(eq(smithersMemoryNotes.id, id))).pipe(Effect.flatMap((result) => {
            const changes = Number(/** @type {any} */ (result)?.changes ?? /** @type {any} */ (result)?.rowsAffected ?? 0);
            if (changes === 0) {
                return Effect.fail(toSmithersError(new Error(`memory setNoteStatus: no note with id ${id}`), "memory setNoteStatus", { code: "DB_WRITE_FAILED", details: { noteId: id } }));
            }
            return Effect.void;
        }));
    }
    /**
   * Opt a namespace kind into note text search (P4). Creates the FTS5
   * artifacts lazily on first call and backfills existing notes of that kind.
   * Until this is called, no FTS table exists and note writes skip FTS
   * entirely (zero write amplification for KV-only users).
   * @param {string} kind
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function enableNoteSearchEffect(kind) {
        return requireSqliteNotesEffect("DB_WRITE_FAILED", "memory enableNoteSearch").pipe(Effect.zipRight(writeEffect("memory enableNoteSearch", () => Promise.resolve(db.transaction((tx) => {
            tx.run(sql `CREATE TABLE IF NOT EXISTS _smithers_memory_fts_kinds (kind TEXT PRIMARY KEY)`);
            tx.run(sql `CREATE VIRTUAL TABLE IF NOT EXISTS _smithers_memory_notes_fts USING fts5(note_id UNINDEXED, kind UNINDEXED, body)`);
            tx.run(sql `INSERT INTO _smithers_memory_fts_kinds (kind) VALUES (${kind}) ON CONFLICT DO NOTHING`);
            tx.run(sql `INSERT INTO _smithers_memory_notes_fts (note_id, kind, body)
          SELECT n.id, ${kind}, n.body FROM _smithers_memory_notes n
          WHERE n.namespace LIKE ${`${kind}:%`}
            AND NOT EXISTS (SELECT 1 FROM _smithers_memory_notes_fts f WHERE f.note_id = n.id)`);
        }))))).pipe(Effect.asVoid);
    }
    /**
   * FTS search over note bodies for an enabled namespace kind, rank order.
   * Results honor the same read contract as listNotes (filters widen). Fails
   * loud — not silently empty — when the kind was never enabled.
   *
   * Scope: the FTS index is per namespace KIND, so matches span every
   * namespace of that kind; pass filter.namespace to keep results
   * namespace-local. Bound: the read contract is applied to the top
   * `limit * 5` FTS matches, so a corpus where most matches are superseded
   * or pending can return fewer than `limit` even when more live matches
   * exist further down the rank order.
   * @param {string} kind
   * @param {string} query
   * @param {number} [limit]
   * @param {NoteReadFilter} [filter]
   * @returns {Effect.Effect<MemoryNote[], SmithersError>}
   */
    function searchNotesEffect(kind, query, limit, filter) {
        const max = limit ?? 20;
        return Effect.gen(function* () {
            yield* requireSqliteNotesEffect("DB_QUERY_FAILED", "memory searchNotes");
            if (!noteFtsKindEnabled(kind)) {
                return yield* Effect.fail(toSmithersError(new Error(`memory searchNotes: note search is not enabled for namespace kind "${kind}" — call enableNoteSearch("${kind}") first`), "memory searchNotes", { code: "DB_QUERY_FAILED", details: { kind } }));
            }
            const matches = yield* readEffect("memory searchNotes", () => Promise.resolve(db.all(sql `SELECT note_id AS noteId FROM _smithers_memory_notes_fts
             WHERE _smithers_memory_notes_fts MATCH ${query} AND kind = ${kind}
             ORDER BY rank LIMIT ${max * 5}`)));
            const ids = matches.map((row) => String(/** @type {any} */ (row).noteId));
            if (ids.length === 0) {
                return [];
            }
            const rows = yield* readEffect("memory searchNotes fetch", () => db
                .select()
                .from(smithersMemoryNotes)
                .where(and(inArray(smithersMemoryNotes.id, ids), ...noteFilterConds(filter))));
            const byId = new Map(rows.map((row) => [row.id, toNote(row)]));
            const ordered = [];
            for (const id of ids) {
                const note = byId.get(id);
                if (note) {
                    ordered.push(note);
                }
                if (ordered.length >= max) {
                    break;
                }
            }
            return ordered;
        });
    }
    // --- Maintenance ---
    /**
   * @returns {Effect.Effect<number, SmithersError>}
   */
    function deleteExpiredFactsEffect() {
        const now = nowMs();
        return writeEffect("memory deleteExpiredFacts", () => db
            .delete(smithersMemoryFacts)
            .where(and(sql `${smithersMemoryFacts.ttlMs} IS NOT NULL`, sql `${smithersMemoryFacts.updatedAtMs} + ${smithersMemoryFacts.ttlMs} < ${now}`))).pipe(Effect.map((result) => result?.changes ?? result?.rowsAffected ?? 0));
    }
    // --- Build the store ---
    return {
        // Promise variants (delegate to Effect)
        getFact: (ns, key) => Effect.runPromise(getFactEffect(ns, key)),
        setFact: (ns, key, value, ttlMs, provenance) => Effect.runPromise(setFactEffect(ns, key, value, ttlMs, provenance)),
        deleteFact: (ns, key) => Effect.runPromise(deleteFactEffect(ns, key)),
        listFacts: (ns) => Effect.runPromise(listFactsEffect(ns)),
        listAllFacts: () => Effect.runPromise(listAllFactsEffect()),
        createThread: (ns, title) => Effect.runPromise(createThreadEffect(ns, title)),
        getThread: (threadId) => Effect.runPromise(getThreadEffect(threadId)),
        listThreads: () => Effect.runPromise(listThreadsEffect()),
        deleteThread: (threadId) => Effect.runPromise(deleteThreadEffect(threadId)),
        saveMessage: (msg) => Effect.runPromise(saveMessageEffect(msg)),
        listMessages: (threadId, limit) => Effect.runPromise(listMessagesEffect(threadId, limit)),
        countMessages: (threadId) => Effect.runPromise(countMessagesEffect(threadId)),
        deleteMessages: (threadId, messageIds) => Effect.runPromise(deleteMessagesEffect(threadId, messageIds)),
        deleteExpiredFacts: () => Effect.runPromise(deleteExpiredFactsEffect()),
        saveNote: (input) => Effect.runPromise(saveNoteEffect(input)),
        getNote: (id) => Effect.runPromise(getNoteEffect(id)),
        listNotes: (ns, filter) => Effect.runPromise(listNotesEffect(ns, filter)),
        setNoteStatus: (id, status) => Effect.runPromise(setNoteStatusEffect(id, status)),
        enableNoteSearch: (kind) => Effect.runPromise(enableNoteSearchEffect(kind)),
        searchNotes: (kind, query, limit, filter) => Effect.runPromise(searchNotesEffect(kind, query, limit, filter)),
        // Effect variants
        getFactEffect,
        setFactEffect,
        deleteFactEffect,
        listFactsEffect,
        listAllFactsEffect,
        createThreadEffect,
        getThreadEffect,
        listThreadsEffect,
        deleteThreadEffect,
        saveMessageEffect,
        listMessagesEffect,
        countMessagesEffect,
        deleteMessagesEffect,
        deleteExpiredFactsEffect,
        saveNoteEffect,
        getNoteEffect,
        listNotesEffect,
        setNoteStatusEffect,
        enableNoteSearchEffect,
        searchNotesEffect,
    };
}
/** @type {Layer.Layer<MemoryStoreService, never, BunSQLiteDatabase<any>>} */
export const MemoryStoreLive = Layer.effect(MemoryStoreService, Effect.map(MemoryStoreDb, (db) => makeMemoryStore(db)));
