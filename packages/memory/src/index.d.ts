import * as zod from 'zod';
import { z } from 'zod';
import * as zod_v4_core from 'zod/v4/core';
import { Effect, Context, Layer } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors';
import * as drizzle_orm_bun_sqlite from 'drizzle-orm/bun-sqlite';
import { BunSQLiteDatabase as BunSQLiteDatabase$1 } from 'drizzle-orm/bun-sqlite';
export { memoryFactReads, memoryFactWrites, memoryMessageSaves, memoryRecallDuration, memoryRecallQueries } from '@smithers-orchestrator/observability/metrics';
export { smithersMemoryFacts, smithersMemoryMessages, smithersMemoryNoteSupersessions, smithersMemoryNotes, smithersMemoryThreads } from '@smithers-orchestrator/db/internal-schema';

type MemoryNamespaceKind$1 = "workflow" | "agent" | "user" | "global";

type MemoryNamespace$3 = {
    kind: MemoryNamespaceKind$1;
    id: string;
};

type WorkingMemoryConfig$1<T extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = {
    schema?: T;
    namespace: MemoryNamespace$3;
    ttlMs?: number;
};

type TaskMemoryConfig$1 = {
    namespace?: string | MemoryNamespace$3;
    recall?: {
        namespace?: MemoryNamespace$3;
        query?: string;
        topK?: number;
    };
    remember?: {
        namespace?: MemoryNamespace$3;
        key?: string;
    };
    threadId?: string;
};

type SemanticRecallConfig$1 = {
    topK?: number;
    namespace?: MemoryNamespace$3;
    similarityThreshold?: number;
};

type MessageHistoryConfig$1 = {
    lastMessages?: number;
    threadId?: string;
};

type MemoryThread$1 = {
    threadId: string;
    namespace: string;
    title?: string | null;
    metadataJson?: string | null;
    createdAtMs: number;
    updatedAtMs: number;
};

type MemoryFact$1 = {
    namespace: string;
    key: string;
    valueJson: string;
    schemaSig?: string | null;
    createdAtMs: number;
    updatedAtMs: number;
    ttlMs?: number | null;
    /** Provenance: the run coordinate of the LAST write (facts are upserts). */
    runId?: string | null;
    nodeId?: string | null;
    iteration?: number | null;
};

type MemoryMessage$1 = {
    id: string;
    threadId: string;
    role: string;
    contentJson: string;
    runId?: string | null;
    nodeId?: string | null;
    /** Provenance: completes the run coordinate alongside runId/nodeId. */
    iteration?: number | null;
    createdAtMs: number;
};

/**
 * An append-only knowledge note — the sibling record type to MemoryFact.
 * Facts are mutable KV (upsert semantics); notes are immutable rows: body,
 * labels, and provenance never change after insert. `status` is the ONE
 * deliberate exception (see setNoteStatus) — a human/workflow gate writes an
 * answer about an existing note without churning its id.
 *
 * kind / tags / author are optional, policy-free labels the engine never
 * interprets. Notes carry NO ttl: knowledge dies by supersession or
 * rejection, not by clock.
 */
type MemoryNote$1 = {
    id: string;
    namespace: string;
    body: string;
    kind?: string | null;
    /** JSON-encoded string array; null when the note has no tags. */
    tagsJson?: string | null;
    author?: string | null;
    status: string;
    statusChangedAtMs?: number | null;
    createdAtMs: number;
    runId?: string | null;
    nodeId?: string | null;
    iteration?: number | null;
};

/**
 * The run coordinate a memory write was made from. All fields are optional —
 * a write made outside a run (a human, a script, a REPL) carries none.
 *
 * Provenance is passed EXPLICITLY by the caller, never inferred from ambient
 * context: ambient scope does not survive agent/tool boundaries, so an
 * implicit mechanism would silently stamp nulls exactly where provenance
 * matters most. Engine-adjacent callers (tool bridges, workflow build
 * functions) already hold these coordinates and pass them through.
 */
type MemoryProvenance$1 = {
    runId?: string | null;
    nodeId?: string | null;
    iteration?: number | null;
};

/** Input for saveNote — namespace as the structured object, tags as an array. */
type SaveNoteInput$1 = {
    namespace: MemoryNamespace$3;
    body: string;
    kind?: string;
    tags?: string[];
    author?: string;
    /** Free-form; defaults to "accepted". Conventionally pending|accepted|rejected. */
    status?: string;
    provenance?: MemoryProvenance$1;
    /**
     * Note ids this note supersedes. Junction rows are written atomically with
     * the note. Whether the superseded notes are HIDDEN depends on THIS note's
     * status: only an accepted superseder hides its targets.
     */
    supersedes?: string[];
    /** Provide to make retries idempotent; defaults to a random UUID. */
    id?: string;
};

/**
 * Read filter for listNotes/searchNotes. The DEFAULT READ CONTRACT (no filter)
 * returns notes that are (a) not superseded by an ACCEPTED note and
 * (b) status = "accepted". Filters widen or narrow:
 * - status: a specific status, a set, or "any"
 * - includeSuperseded: true returns notes even when an accepted note supersedes them
 * - kind: narrows to one kind label
 * - namespace: narrows to one namespace. searchNotes is otherwise scoped by
 *   namespace KIND — it matches every namespace of that kind (all `user:*`
 *   namespaces, say), so pass this on shared databases to keep recall
 *   namespace-local. listNotes is already namespace-scoped by its argument.
 */
type NoteReadFilter$1 = {
    status?: string | string[] | "any";
    includeSuperseded?: boolean;
    kind?: string;
    namespace?: MemoryNamespace$3;
};

type MemoryStore$2 = {
    getFact: (ns: MemoryNamespace$3, key: string) => Promise<MemoryFact$1 | undefined>;
    setFact: (ns: MemoryNamespace$3, key: string, value: unknown, ttlMs?: number, provenance?: MemoryProvenance$1) => Promise<void>;
    deleteFact: (ns: MemoryNamespace$3, key: string) => Promise<void>;
    listFacts: (ns: MemoryNamespace$3) => Promise<MemoryFact$1[]>;
    listAllFacts: () => Promise<MemoryFact$1[]>;
    createThread: (ns: MemoryNamespace$3, title?: string) => Promise<MemoryThread$1>;
    getThread: (threadId: string) => Promise<MemoryThread$1 | undefined>;
    listThreads: () => Promise<MemoryThread$1[]>;
    deleteThread: (threadId: string) => Promise<void>;
    saveMessage: (msg: Omit<MemoryMessage$1, "createdAtMs"> & {
        createdAtMs?: number;
    }) => Promise<void>;
    listMessages: (threadId: string, limit?: number) => Promise<MemoryMessage$1[]>;
    countMessages: (threadId: string) => Promise<number>;
    deleteMessages: (threadId: string, messageIds: string[]) => Promise<number>;
    deleteExpiredFacts: () => Promise<number>;
    saveNote: (input: SaveNoteInput$1) => Promise<MemoryNote$1>;
    getNote: (id: string) => Promise<MemoryNote$1 | undefined>;
    listNotes: (ns: MemoryNamespace$3, filter?: NoteReadFilter$1) => Promise<MemoryNote$1[]>;
    setNoteStatus: (id: string, status: string) => Promise<void>;
    enableNoteSearch: (kind: string) => Promise<void>;
    searchNotes: (kind: string, query: string, limit?: number, filter?: NoteReadFilter$1) => Promise<MemoryNote$1[]>;
    getFactEffect: (ns: MemoryNamespace$3, key: string) => Effect.Effect<MemoryFact$1 | undefined, SmithersError>;
    setFactEffect: (ns: MemoryNamespace$3, key: string, value: unknown, ttlMs?: number, provenance?: MemoryProvenance$1) => Effect.Effect<void, SmithersError>;
    deleteFactEffect: (ns: MemoryNamespace$3, key: string) => Effect.Effect<void, SmithersError>;
    listFactsEffect: (ns: MemoryNamespace$3) => Effect.Effect<MemoryFact$1[], SmithersError>;
    listAllFactsEffect: () => Effect.Effect<MemoryFact$1[], SmithersError>;
    createThreadEffect: (ns: MemoryNamespace$3, title?: string) => Effect.Effect<MemoryThread$1, SmithersError>;
    getThreadEffect: (threadId: string) => Effect.Effect<MemoryThread$1 | undefined, SmithersError>;
    listThreadsEffect: () => Effect.Effect<MemoryThread$1[], SmithersError>;
    deleteThreadEffect: (threadId: string) => Effect.Effect<void, SmithersError>;
    saveMessageEffect: (msg: Omit<MemoryMessage$1, "createdAtMs"> & {
        createdAtMs?: number;
    }) => Effect.Effect<void, SmithersError>;
    listMessagesEffect: (threadId: string, limit?: number) => Effect.Effect<MemoryMessage$1[], SmithersError>;
    countMessagesEffect: (threadId: string) => Effect.Effect<number, SmithersError>;
    deleteMessagesEffect: (threadId: string, messageIds: string[]) => Effect.Effect<number, SmithersError>;
    deleteExpiredFactsEffect: () => Effect.Effect<number, SmithersError>;
    saveNoteEffect: (input: SaveNoteInput$1) => Effect.Effect<MemoryNote$1, SmithersError>;
    getNoteEffect: (id: string) => Effect.Effect<MemoryNote$1 | undefined, SmithersError>;
    listNotesEffect: (ns: MemoryNamespace$3, filter?: NoteReadFilter$1) => Effect.Effect<MemoryNote$1[], SmithersError>;
    setNoteStatusEffect: (id: string, status: string) => Effect.Effect<void, SmithersError>;
    enableNoteSearchEffect: (kind: string) => Effect.Effect<void, SmithersError>;
    searchNotesEffect: (kind: string, query: string, limit?: number, filter?: NoteReadFilter$1) => Effect.Effect<MemoryNote$1[], SmithersError>;
};

type MemoryServiceApi$1 = {
    readonly getFact: (ns: MemoryNamespace$3, key: string) => Effect.Effect<MemoryFact$1 | undefined, SmithersError>;
    readonly setFact: (ns: MemoryNamespace$3, key: string, value: unknown, ttlMs?: number, provenance?: MemoryProvenance$1) => Effect.Effect<void, SmithersError>;
    readonly deleteFact: (ns: MemoryNamespace$3, key: string) => Effect.Effect<void, SmithersError>;
    readonly listFacts: (ns: MemoryNamespace$3) => Effect.Effect<MemoryFact$1[], SmithersError>;
    readonly createThread: (ns: MemoryNamespace$3, title?: string) => Effect.Effect<MemoryThread$1, SmithersError>;
    readonly getThread: (threadId: string) => Effect.Effect<MemoryThread$1 | undefined, SmithersError>;
    readonly deleteThread: (threadId: string) => Effect.Effect<void, SmithersError>;
    readonly saveMessage: (msg: Omit<MemoryMessage$1, "createdAtMs"> & {
        createdAtMs?: number;
    }) => Effect.Effect<void, SmithersError>;
    readonly listMessages: (threadId: string, limit?: number) => Effect.Effect<MemoryMessage$1[], SmithersError>;
    readonly countMessages: (threadId: string) => Effect.Effect<number, SmithersError>;
    readonly deleteExpiredFacts: () => Effect.Effect<number, SmithersError>;
    readonly saveNote: (input: SaveNoteInput$1) => Effect.Effect<MemoryNote$1, SmithersError>;
    readonly getNote: (id: string) => Effect.Effect<MemoryNote$1 | undefined, SmithersError>;
    readonly listNotes: (ns: MemoryNamespace$3, filter?: NoteReadFilter$1) => Effect.Effect<MemoryNote$1[], SmithersError>;
    readonly setNoteStatus: (id: string, status: string) => Effect.Effect<void, SmithersError>;
    readonly enableNoteSearch: (kind: string) => Effect.Effect<void, SmithersError>;
    readonly searchNotes: (kind: string, query: string, limit?: number, filter?: NoteReadFilter$1) => Effect.Effect<MemoryNote$1[], SmithersError>;
    readonly store: MemoryStore$2;
};

type MemoryProcessorConfig$1 = {
    processors?: string[];
};

type MemoryProcessor$4 = {
    name: string;
    process: (store: MemoryStore$2) => Promise<void>;
    processEffect: (store: MemoryStore$2) => Effect.Effect<void, SmithersError>;
};

type MemoryLayerConfig$2 = {
    db: BunSQLiteDatabase$1<Record<string, unknown>>;
};

/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */
/**
 * @param {MemoryNamespace} ns
 * @returns {string}
 */
declare function namespaceToString(ns: MemoryNamespace$2): string;
type MemoryNamespace$2 = MemoryNamespace$3;

/**
 * @param {string} str
 * @returns {MemoryNamespace}
 */
declare function parseNamespace(str: string): MemoryNamespace$1;
type MemoryNamespace$1 = MemoryNamespace$3;

/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("./MemoryStore.ts").MemoryStore} MemoryStore */
/**
 * @param {BunSQLiteDatabase<any>} db
 * @returns {MemoryStore}
 */
declare function createMemoryStore(db: BunSQLiteDatabase<any>): MemoryStore$1;
type BunSQLiteDatabase = drizzle_orm_bun_sqlite.BunSQLiteDatabase;
type MemoryStore$1 = MemoryStore$2;

/** @typedef {import("./MemoryProcessor.ts").MemoryProcessor} MemoryProcessor */
/** @typedef {import("./store/MemoryStore.ts").MemoryStore} MemoryStore */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */
/**
 * @returns {MemoryProcessor}
 */
declare function TtlGarbageCollector(): MemoryProcessor$3;
type MemoryProcessor$3 = MemoryProcessor$4;

/**
 * @param {number} maxTokens
 * @returns {MemoryProcessor}
 */
declare function TokenLimiter(maxTokens: number): MemoryProcessor$2;
type MemoryProcessor$2 = MemoryProcessor$4;

/**
 * @param {{ run: (prompt: string) => Promise<any> }} agent
 * @returns {MemoryProcessor}
 */
declare function Summarizer(agent: {
    run: (prompt: string) => Promise<any>;
}): MemoryProcessor$1;
type MemoryProcessor$1 = MemoryProcessor$4;

declare class MemoryService extends Context.TagClassShape<"MemoryService", MemoryServiceApi$1> {
}

/** @typedef {import("./MemoryLayerConfig.ts").MemoryLayerConfig} MemoryLayerConfig */
/**
 * @param {MemoryLayerConfig} config
 * @returns {Layer.Layer<MemoryService, never, never>}
 */
declare function createMemoryLayer(config: MemoryLayerConfig$1): Layer.Layer<MemoryService, never, never>;
type MemoryLayerConfig$1 = MemoryLayerConfig$2;

type MemoryFact = MemoryFact$1;
type MemoryLayerConfig = MemoryLayerConfig$2;
type MemoryMessage = MemoryMessage$1;
type MemoryNamespace = MemoryNamespace$3;
type MemoryNamespaceKind = MemoryNamespaceKind$1;
type MemoryNote = MemoryNote$1;
type SaveNoteInput = SaveNoteInput$1;
type NoteReadFilter = NoteReadFilter$1;
type MemoryProvenance = MemoryProvenance$1;
type MemoryProcessor = MemoryProcessor$4;
type MemoryProcessorConfig = MemoryProcessorConfig$1;
type MemoryServiceApi = MemoryServiceApi$1;
type MemoryStore = MemoryStore$2;
type MemoryThread = MemoryThread$1;
type MessageHistoryConfig = MessageHistoryConfig$1;
type SemanticRecallConfig = SemanticRecallConfig$1;
type TaskMemoryConfig = TaskMemoryConfig$1;
type WorkingMemoryConfig<T extends zod.z.ZodObject<any> = zod.ZodObject<any, zod_v4_core.$strip>> = WorkingMemoryConfig$1<T>;

export { type MemoryFact, type MemoryLayerConfig, type MemoryMessage, type MemoryNamespace, type MemoryNamespaceKind, type MemoryNote, type MemoryProcessor, type MemoryProcessorConfig, type MemoryProvenance, MemoryService, type MemoryServiceApi, type MemoryStore, type MemoryThread, type MessageHistoryConfig, type NoteReadFilter, type SaveNoteInput, type SemanticRecallConfig, Summarizer, type TaskMemoryConfig, TokenLimiter, TtlGarbageCollector, type WorkingMemoryConfig, createMemoryLayer, createMemoryStore, namespaceToString, parseNamespace };
