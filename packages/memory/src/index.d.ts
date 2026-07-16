import * as zod from 'zod';
import { z } from 'zod';
import * as zod_v4_core from 'zod/v4/core';
import { Effect, Context, Layer } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors';
import * as _vectorize_io_hindsight_client from '@vectorize-io/hindsight-client';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import * as drizzle_orm_bun_sqlite from 'drizzle-orm/bun-sqlite';
import { BunSQLiteDatabase as BunSQLiteDatabase$1 } from 'drizzle-orm/bun-sqlite';
export { memoryFactReads, memoryFactWrites, memoryMessageSaves, memoryRecallDuration, memoryRecallQueries } from '@smithers-orchestrator/observability/metrics';
import * as _smithers_orchestrator_errors_toSmithersError from '@smithers-orchestrator/errors/toSmithersError';
export { smithersMemoryFacts, smithersMemoryMessages, smithersMemoryNoteSupersessions, smithersMemoryNotes, smithersMemoryThreads } from '@smithers-orchestrator/db/internal-schema';

type MemoryNamespaceKind$1 = "workflow" | "agent" | "user" | "global";

type MemoryNamespace$4 = {
    kind: MemoryNamespaceKind$1;
    id: string;
};

type WorkingMemoryConfig$1<T extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = {
    schema?: T;
    namespace: MemoryNamespace$4;
    ttlMs?: number;
};

type TaskMemoryConfig$1 = {
    namespace?: string | MemoryNamespace$4;
    bank?: string;
    banks?: string[];
    tags?: string[];
    recall?: "auto" | string | false | {
        namespace?: MemoryNamespace$4;
        query?: string;
        topK?: number;
    };
    budget?: "low" | "mid" | "high";
    maxTokens?: number;
    primers?: string[];
    retain?: "on-complete" | "off";
    tools?: boolean;
    remember?: {
        namespace?: MemoryNamespace$4;
        key?: string;
    };
    threadId?: string;
};

type SemanticRecallConfig$1 = {
    topK?: number;
    namespace?: MemoryNamespace$4;
    similarityThreshold?: number;
};

type MessageHistoryConfig$1 = {
    lastMessages?: number;
    threadId?: string;
};

type MemoryThread$2 = {
    threadId: string;
    namespace: string;
    title?: string | null;
    metadataJson?: string | null;
    createdAtMs: number;
    updatedAtMs: number;
};

type MemoryFact$2 = {
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

type MemoryMessage$2 = {
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
type MemoryNote$2 = {
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
type MemoryProvenance$2 = {
    runId?: string | null;
    nodeId?: string | null;
    iteration?: number | null;
};

/** Input for saveNote — namespace as the structured object, tags as an array. */
type SaveNoteInput$2 = {
    namespace: MemoryNamespace$4;
    body: string;
    kind?: string;
    tags?: string[];
    author?: string;
    /** Free-form; defaults to "accepted". Conventionally pending|accepted|rejected. */
    status?: string;
    provenance?: MemoryProvenance$2;
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
type NoteReadFilter$2 = {
    status?: string | string[] | "any";
    includeSuperseded?: boolean;
    kind?: string;
    namespace?: MemoryNamespace$4;
};

type MemoryStore$4 = {
    getFact: (ns: MemoryNamespace$4, key: string) => Promise<MemoryFact$2 | undefined>;
    setFact: (ns: MemoryNamespace$4, key: string, value: unknown, ttlMs?: number, provenance?: MemoryProvenance$2) => Promise<void>;
    deleteFact: (ns: MemoryNamespace$4, key: string) => Promise<void>;
    listFacts: (ns: MemoryNamespace$4) => Promise<MemoryFact$2[]>;
    listAllFacts: () => Promise<MemoryFact$2[]>;
    createThread: (ns: MemoryNamespace$4, title?: string) => Promise<MemoryThread$2>;
    getThread: (threadId: string) => Promise<MemoryThread$2 | undefined>;
    listThreads: () => Promise<MemoryThread$2[]>;
    deleteThread: (threadId: string) => Promise<void>;
    saveMessage: (msg: Omit<MemoryMessage$2, "createdAtMs"> & {
        createdAtMs?: number;
    }) => Promise<void>;
    listMessages: (threadId: string, limit?: number) => Promise<MemoryMessage$2[]>;
    countMessages: (threadId: string) => Promise<number>;
    deleteMessages: (threadId: string, messageIds: string[]) => Promise<number>;
    deleteExpiredFacts: () => Promise<number>;
    saveNote: (input: SaveNoteInput$2) => Promise<MemoryNote$2>;
    getNote: (id: string) => Promise<MemoryNote$2 | undefined>;
    listNotes: (ns: MemoryNamespace$4, filter?: NoteReadFilter$2) => Promise<MemoryNote$2[]>;
    setNoteStatus: (id: string, status: string) => Promise<void>;
    enableNoteSearch: (kind: string) => Promise<void>;
    searchNotes: (kind: string, query: string, limit?: number, filter?: NoteReadFilter$2) => Promise<MemoryNote$2[]>;
    getFactEffect: (ns: MemoryNamespace$4, key: string) => Effect.Effect<MemoryFact$2 | undefined, SmithersError>;
    setFactEffect: (ns: MemoryNamespace$4, key: string, value: unknown, ttlMs?: number, provenance?: MemoryProvenance$2) => Effect.Effect<void, SmithersError>;
    deleteFactEffect: (ns: MemoryNamespace$4, key: string) => Effect.Effect<void, SmithersError>;
    listFactsEffect: (ns: MemoryNamespace$4) => Effect.Effect<MemoryFact$2[], SmithersError>;
    listAllFactsEffect: () => Effect.Effect<MemoryFact$2[], SmithersError>;
    createThreadEffect: (ns: MemoryNamespace$4, title?: string) => Effect.Effect<MemoryThread$2, SmithersError>;
    getThreadEffect: (threadId: string) => Effect.Effect<MemoryThread$2 | undefined, SmithersError>;
    listThreadsEffect: () => Effect.Effect<MemoryThread$2[], SmithersError>;
    deleteThreadEffect: (threadId: string) => Effect.Effect<void, SmithersError>;
    saveMessageEffect: (msg: Omit<MemoryMessage$2, "createdAtMs"> & {
        createdAtMs?: number;
    }) => Effect.Effect<void, SmithersError>;
    listMessagesEffect: (threadId: string, limit?: number) => Effect.Effect<MemoryMessage$2[], SmithersError>;
    countMessagesEffect: (threadId: string) => Effect.Effect<number, SmithersError>;
    deleteMessagesEffect: (threadId: string, messageIds: string[]) => Effect.Effect<number, SmithersError>;
    deleteExpiredFactsEffect: () => Effect.Effect<number, SmithersError>;
    saveNoteEffect: (input: SaveNoteInput$2) => Effect.Effect<MemoryNote$2, SmithersError>;
    getNoteEffect: (id: string) => Effect.Effect<MemoryNote$2 | undefined, SmithersError>;
    listNotesEffect: (ns: MemoryNamespace$4, filter?: NoteReadFilter$2) => Effect.Effect<MemoryNote$2[], SmithersError>;
    setNoteStatusEffect: (id: string, status: string) => Effect.Effect<void, SmithersError>;
    enableNoteSearchEffect: (kind: string) => Effect.Effect<void, SmithersError>;
    searchNotesEffect: (kind: string, query: string, limit?: number, filter?: NoteReadFilter$2) => Effect.Effect<MemoryNote$2[], SmithersError>;
};

type MemoryServiceApi$1 = {
    readonly getFact: (ns: MemoryNamespace$4, key: string) => Effect.Effect<MemoryFact$2 | undefined, SmithersError>;
    readonly setFact: (ns: MemoryNamespace$4, key: string, value: unknown, ttlMs?: number, provenance?: MemoryProvenance$2) => Effect.Effect<void, SmithersError>;
    readonly deleteFact: (ns: MemoryNamespace$4, key: string) => Effect.Effect<void, SmithersError>;
    readonly listFacts: (ns: MemoryNamespace$4) => Effect.Effect<MemoryFact$2[], SmithersError>;
    readonly createThread: (ns: MemoryNamespace$4, title?: string) => Effect.Effect<MemoryThread$2, SmithersError>;
    readonly getThread: (threadId: string) => Effect.Effect<MemoryThread$2 | undefined, SmithersError>;
    readonly deleteThread: (threadId: string) => Effect.Effect<void, SmithersError>;
    readonly saveMessage: (msg: Omit<MemoryMessage$2, "createdAtMs"> & {
        createdAtMs?: number;
    }) => Effect.Effect<void, SmithersError>;
    readonly listMessages: (threadId: string, limit?: number) => Effect.Effect<MemoryMessage$2[], SmithersError>;
    readonly countMessages: (threadId: string) => Effect.Effect<number, SmithersError>;
    readonly deleteExpiredFacts: () => Effect.Effect<number, SmithersError>;
    readonly saveNote: (input: SaveNoteInput$2) => Effect.Effect<MemoryNote$2, SmithersError>;
    readonly getNote: (id: string) => Effect.Effect<MemoryNote$2 | undefined, SmithersError>;
    readonly listNotes: (ns: MemoryNamespace$4, filter?: NoteReadFilter$2) => Effect.Effect<MemoryNote$2[], SmithersError>;
    readonly setNoteStatus: (id: string, status: string) => Effect.Effect<void, SmithersError>;
    readonly enableNoteSearch: (kind: string) => Effect.Effect<void, SmithersError>;
    readonly searchNotes: (kind: string, query: string, limit?: number, filter?: NoteReadFilter$2) => Effect.Effect<MemoryNote$2[], SmithersError>;
    readonly store: MemoryStore$4;
};

type MemoryProcessorConfig$1 = {
    processors?: string[];
};

type MemoryProcessor$4 = {
    name: string;
    process: (store: MemoryStore$4) => Promise<void>;
    processEffect: (store: MemoryStore$4) => Effect.Effect<void, SmithersError>;
};

type HindsightMemoryStoreOptions$2 = {
    /** Hindsight API base URL, for example `http://127.0.0.1:8888`. */
    baseUrl: string;
    /** Optional Hindsight bearer token. */
    apiKey?: string;
    /** Prefix applied to Smithers-created and component-selected banks. */
    bankPrefix?: string;
    /** Optional client override for tests and advanced transports. */
    client?: HindsightClient;
};

type MemoryLayerConfig$2 = {
    db: BunSQLiteDatabase$1<Record<string, unknown>>;
};

/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */
/**
 * @param {MemoryNamespace} ns
 * @returns {string}
 */
declare function namespaceToString(ns: MemoryNamespace$3): string;
type MemoryNamespace$3 = MemoryNamespace$4;

/**
 * @param {string} str
 * @returns {MemoryNamespace}
 */
declare function parseNamespace(str: string): MemoryNamespace$2;
type MemoryNamespace$2 = MemoryNamespace$4;

/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("./MemoryStore.ts").MemoryStore} MemoryStore */
/**
 * @param {BunSQLiteDatabase<any>} db
 * @returns {MemoryStore}
 */
declare function createMemoryStore(db: BunSQLiteDatabase<any>): MemoryStore$3;
type BunSQLiteDatabase = drizzle_orm_bun_sqlite.BunSQLiteDatabase;
type MemoryStore$3 = MemoryStore$4;

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

/** @param {HindsightMemoryStoreOptions} options */
declare function createHindsightMemoryStore(options: HindsightMemoryStoreOptions$1): HindsightMemoryStore;
/**
 * MemoryStore backed by Hindsight documents and semantic recall.
 *
 * Mapping:
 * - exact facts are retained with stable document ids and `updateMode=replace`;
 * - threads, messages, and notes are typed documents with stable record tags;
 * - namespace identity selects a bank, while stable note/config tags stay tags;
 * - semantic note search and task recall call Hindsight recall;
 * - run/session identity is metadata, never a tag.
 *
 * @implements {MemoryStore}
 */
declare class HindsightMemoryStore implements MemoryStore$2 {
    /** @param {HindsightMemoryStoreOptions} options */
    constructor(options: HindsightMemoryStoreOptions$1);
    baseUrl: string;
    apiKey: string | undefined;
    bankPrefix: string;
    client: HindsightClient;
    sdkClient: _vectorize_io_hindsight_client.Client;
    /** @type {Set<string>} */
    knownBanks: Set<string>;
    /** @param {string} bank */
    resolveBank(bank: string): string;
    /** @param {MemoryNamespace} ns */
    bankForNamespace(ns: MemoryNamespace$1): string;
    /**
     * @returns {Promise<string[]>}
     */
    listBankIds(): Promise<string[]>;
    /**
     * @param {string} bank
     * @returns {Promise<DocumentResponse[]>}
     */
    listDocuments(bank: string): Promise<DocumentResponse[]>;
    /**
     * @param {string} bank
     * @param {string} type
     * @returns {Promise<Array<{ document: DocumentResponse; envelope: SmithersRecordEnvelope }>>}
     */
    listRecords(bank: string, type: string): Promise<Array<{
        document: DocumentResponse;
        envelope: SmithersRecordEnvelope;
    }>>;
    /**
     * @param {string} bank
     * @param {"fact" | "thread" | "message" | "note"} type
     * @param {string} id
     * @param {MemoryFact | MemoryThread | MemoryMessage | MemoryNote} value
     * @param {{ tags?: string[]; metadata?: Record<string, string>; supersedes?: string[]; context?: string }} [options]
     */
    putRecord(bank: string, type: "fact" | "thread" | "message" | "note", id: string, value: MemoryFact$1 | MemoryThread$1 | MemoryMessage$1 | MemoryNote$1, options?: {
        tags?: string[];
        metadata?: Record<string, string>;
        supersedes?: string[];
        context?: string;
    }): Promise<void>;
    /**
     * @param {string} id
     * @param {"thread" | "note"} type
     */
    findRecord(id: string, type: "thread" | "note"): Promise<{
        bank: string;
        document: _vectorize_io_hindsight_client.DocumentResponse;
        envelope: SmithersRecordEnvelope;
    } | undefined>;
    /** @param {MemoryNamespace} ns @param {string} key */
    getFact(ns: MemoryNamespace$1, key: string): Promise<MemoryFact$2 | undefined>;
    /**
     * @param {MemoryNamespace} ns
     * @param {string} key
     * @param {unknown} value
     * @param {number} [ttlMs]
     * @param {MemoryProvenance} [provenance]
     */
    setFact(ns: MemoryNamespace$1, key: string, value: unknown, ttlMs?: number, provenance?: MemoryProvenance$1): Promise<void>;
    /** @param {MemoryNamespace} ns @param {string} key */
    deleteFact(ns: MemoryNamespace$1, key: string): Promise<void>;
    /** @param {MemoryNamespace} ns */
    listFacts(ns: MemoryNamespace$1): Promise<MemoryFact$2[]>;
    listAllFacts(): Promise<MemoryFact$2[]>;
    /** @param {MemoryNamespace} ns @param {string} [title] */
    createThread(ns: MemoryNamespace$1, title?: string): Promise<MemoryThread$2>;
    /** @param {string} threadId */
    getThread(threadId: string): Promise<MemoryThread$2 | undefined>;
    listThreads(): Promise<MemoryThread$2[]>;
    /** @param {string} threadId */
    deleteThread(threadId: string): Promise<void>;
    /** @param {Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number }} msg */
    saveMessage(msg: Omit<MemoryMessage$1, "createdAtMs"> & {
        createdAtMs?: number;
    }): Promise<void>;
    /** @param {string} threadId @param {number} [limit] */
    listMessages(threadId: string, limit?: number): Promise<MemoryMessage$2[]>;
    /** @param {string} threadId */
    countMessages(threadId: string): Promise<number>;
    /** @param {string} threadId @param {string[]} messageIds */
    deleteMessages(threadId: string, messageIds: string[]): Promise<number>;
    deleteExpiredFacts(): Promise<number>;
    /** @param {SaveNoteInput} input */
    saveNote(input: SaveNoteInput$1): Promise<MemoryNote$2>;
    /** @param {string} id */
    getNote(id: string): Promise<MemoryNote$2 | undefined>;
    /** @param {MemoryNamespace} ns @param {NoteReadFilter} [filter] */
    listNotes(ns: MemoryNamespace$1, filter?: NoteReadFilter$1): Promise<MemoryNote$2[]>;
    /** @param {string} id @param {string} status */
    setNoteStatus(id: string, status: string): Promise<void>;
    /** @param {string} _kind */
    enableNoteSearch(_kind: string): Promise<void>;
    /**
     * @param {string} kind
     * @param {string} query
     * @param {number} [limit]
     * @param {NoteReadFilter} [filter]
     */
    searchNotes(kind: string, query: string, limit?: number, filter?: NoteReadFilter$1): Promise<MemoryNote$2[]>;
    /**
     * Recall task memories. Stable config tags are encoded exclusively as a
     * tag_groups filter so the SDK never receives the mutually-exclusive
     * tags and tag_groups fields together.
     * @param {HindsightRecallInput} input
     * @returns {Promise<Array<RecallResult & { bank: string }>>}
     */
    recallMemory(input: HindsightRecallInput): Promise<Array<RecallResult & {
        bank: string;
    }>>;
    /**
     * Fetch mental-model content verbatim for task primer injection.
     * @param {{ banks: string[]; primerIds: string[]; signal?: AbortSignal }} input
     */
    getPrimers(input: {
        banks: string[];
        primerIds: string[];
        signal?: AbortSignal;
    }): Promise<{
        bank: string;
        id: string;
        content: string;
    }[]>;
    /**
     * Retain an engine/tool memory using append semantics and stable document
     * identity. Callers put volatile run/session ids in metadata.
     * @param {HindsightRetainInput} input
     */
    retainMemory(input: HindsightRetainInput): Promise<void>;
    getFactEffect(ns: any, key: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    setFactEffect(ns: any, key: any, value: any, ttlMs: any, provenance: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    deleteFactEffect(ns: any, key: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    listFactsEffect(ns: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    listAllFactsEffect(): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    createThreadEffect(ns: any, title: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    getThreadEffect(threadId: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    listThreadsEffect(): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    deleteThreadEffect(threadId: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    saveMessageEffect(msg: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    listMessagesEffect(threadId: any, limit: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    countMessagesEffect(threadId: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    deleteMessagesEffect(threadId: any, messageIds: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    deleteExpiredFactsEffect(): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    saveNoteEffect(input: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    getNoteEffect(id: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    listNotesEffect(ns: any, filter: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    setNoteStatusEffect(id: any, status: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    enableNoteSearchEffect(kind: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    searchNotesEffect(kind: any, query: any, limit: any, filter: any): Effect.Effect<any, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
}
type SmithersRecordEnvelope = {
    version: number;
    type: "fact" | "thread" | "message" | "note";
    value: MemoryFact$1 | MemoryThread$1 | MemoryMessage$1 | MemoryNote$1;
    supersedes?: string[] | undefined;
};
/**
 * Hindsight-facing recall input used by the engine memory bridge.
 */
type HindsightRecallInput = {
    banks: string[];
    query: string;
    tags?: string[] | undefined;
    tagGroupsByBank?: Record<string, HindsightTagGroup[]> | undefined;
    budget?: "low" | "mid" | "high" | undefined;
    maxTokens?: number | undefined;
    signal?: AbortSignal | undefined;
};
type HindsightTagGroup = {
    tags: string[];
    match?: "any" | "all" | "any_strict" | "all_strict" | "exact";
} | {
    and: HindsightTagGroup[];
} | {
    or: HindsightTagGroup[];
} | {
    not: HindsightTagGroup;
};
/**
 * Hindsight-facing retain input used by the engine and memory tools.
 */
type HindsightRetainInput = {
    bank: string;
    content: string;
    tags?: string[] | undefined;
    metadata?: Record<string, string> | undefined;
    documentId: string;
    updateMode?: "replace" | "append" | undefined;
    async?: boolean | undefined;
    context?: string | undefined;
    signal?: AbortSignal | undefined;
};
type HindsightMemoryStoreOptions$1 = HindsightMemoryStoreOptions$2;
type MemoryStore$2 = MemoryStore$4;
type MemoryNamespace$1 = MemoryNamespace$4;
type MemoryFact$1 = MemoryFact$2;
type MemoryThread$1 = MemoryThread$2;
type MemoryMessage$1 = MemoryMessage$2;
type MemoryNote$1 = MemoryNote$2;
type SaveNoteInput$1 = SaveNoteInput$2;
type NoteReadFilter$1 = NoteReadFilter$2;
type MemoryProvenance$1 = MemoryProvenance$2;
type RecallResult = _vectorize_io_hindsight_client.RecallResult;
type DocumentResponse = _vectorize_io_hindsight_client.DocumentResponse;

/** @param {MemoryStore} store */
declare function createLocalMemoryRuntime(store: MemoryStore$1): LocalMemoryRuntime;
/**
 * Runtime recall/retain adapter for the pre-existing local facts store.
 * Exact MemoryStore behavior is untouched; this only gives `<Memory>` a
 * keyword fallback when HINDSIGHT_URL is absent.
 */
declare class LocalMemoryRuntime {
    /** @param {MemoryStore} store */
    constructor(store: MemoryStore$1);
    store: MemoryStore$4;
    /** @param {{ banks: string[]; query: string; tags?: string[]; tagGroupsByBank?: Record<string, LocalTagGroup[]>; maxTokens?: number }} input */
    recallMemory(input: {
        banks: string[];
        query: string;
        tags?: string[];
        tagGroupsByBank?: Record<string, LocalTagGroup[]>;
        maxTokens?: number;
    }): Promise<{
        bank: string;
        text: any;
    }[]>;
    getPrimers(): Promise<never[]>;
    /**
     * @param {{ bank: string; content: string; tags?: string[]; metadata?: Record<string, string>; documentId: string; updateMode?: "replace" | "append" }} input
     */
    retainMemory(input: {
        bank: string;
        content: string;
        tags?: string[];
        metadata?: Record<string, string>;
        documentId: string;
        updateMode?: "replace" | "append";
    }): Promise<void>;
}
type MemoryStore$1 = MemoryStore$4;
type LocalTagGroup = {
    tags: string[];
    match?: "any" | "all" | "any_strict" | "all_strict" | "exact";
} | {
    and: LocalTagGroup[];
} | {
    or: LocalTagGroup[];
} | {
    not: LocalTagGroup;
};

type MemoryFact = MemoryFact$2;
type MemoryLayerConfig = MemoryLayerConfig$2;
type HindsightMemoryStoreOptions = HindsightMemoryStoreOptions$2;
type MemoryMessage = MemoryMessage$2;
type MemoryNamespace = MemoryNamespace$4;
type MemoryNamespaceKind = MemoryNamespaceKind$1;
type MemoryNote = MemoryNote$2;
type SaveNoteInput = SaveNoteInput$2;
type NoteReadFilter = NoteReadFilter$2;
type MemoryProvenance = MemoryProvenance$2;
type MemoryProcessor = MemoryProcessor$4;
type MemoryProcessorConfig = MemoryProcessorConfig$1;
type MemoryServiceApi = MemoryServiceApi$1;
type MemoryStore = MemoryStore$4;
type MemoryThread = MemoryThread$2;
type MessageHistoryConfig = MessageHistoryConfig$1;
type SemanticRecallConfig = SemanticRecallConfig$1;
type TaskMemoryConfig = TaskMemoryConfig$1;
type WorkingMemoryConfig<T extends zod.z.ZodObject<any> = zod.ZodObject<any, zod_v4_core.$strip>> = WorkingMemoryConfig$1<T>;

export { HindsightMemoryStore, type HindsightMemoryStoreOptions, LocalMemoryRuntime, type MemoryFact, type MemoryLayerConfig, type MemoryMessage, type MemoryNamespace, type MemoryNamespaceKind, type MemoryNote, type MemoryProcessor, type MemoryProcessorConfig, type MemoryProvenance, MemoryService, type MemoryServiceApi, type MemoryStore, type MemoryThread, type MessageHistoryConfig, type NoteReadFilter, type SaveNoteInput, type SemanticRecallConfig, Summarizer, type TaskMemoryConfig, TokenLimiter, TtlGarbageCollector, type WorkingMemoryConfig, createHindsightMemoryStore, createLocalMemoryRuntime, createMemoryLayer, createMemoryStore, namespaceToString, parseNamespace };
