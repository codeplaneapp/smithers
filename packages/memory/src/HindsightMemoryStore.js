// @smithers-type-exports-begin
/** @typedef {import("./HindsightMemoryStoreOptions.ts").HindsightMemoryStoreOptions} HindsightMemoryStoreOptions */
// @smithers-type-exports-end

import { Effect } from "effect";
import {
    HindsightClient,
    HindsightError,
    createClient,
    createConfig,
    sdk,
} from "@vectorize-io/hindsight-client";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { logWarning } from "@smithers-orchestrator/observability/logging";
import { namespaceToString } from "./namespaceToString.js";
import { parseNamespace } from "./parseNamespace.js";
import { capMemoryRecallResults } from "./capMemoryRecallResults.js";

/** @typedef {import("./store/MemoryStore.ts").MemoryStore} MemoryStore */
/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */
/** @typedef {import("./MemoryFact.ts").MemoryFact} MemoryFact */
/** @typedef {import("./MemoryThread.ts").MemoryThread} MemoryThread */
/** @typedef {import("./MemoryMessage.ts").MemoryMessage} MemoryMessage */
/** @typedef {import("./MemoryNote.ts").MemoryNote} MemoryNote */
/** @typedef {import("./SaveNoteInput.ts").SaveNoteInput} SaveNoteInput */
/** @typedef {import("./NoteReadFilter.ts").NoteReadFilter} NoteReadFilter */
/** @typedef {import("./MemoryProvenance.ts").MemoryProvenance} MemoryProvenance */
/** @typedef {import("@vectorize-io/hindsight-client").RecallResult} RecallResult */
/** @typedef {import("@vectorize-io/hindsight-client").DocumentResponse} DocumentResponse */

const RECORD_VERSION = 1;
const PAGE_SIZE = 100;
const RECORD_TAG_PREFIX = "smithers:record:";

/**
 * @typedef {object} SmithersRecordEnvelope
 * @property {number} version
 * @property {"fact" | "thread" | "message" | "note"} type
 * @property {MemoryFact | MemoryThread | MemoryMessage | MemoryNote} value
 * @property {string[]} [supersedes]
 */

/**
 * Hindsight-facing recall input used by the engine memory bridge.
 * @typedef {object} HindsightRecallInput
 * @property {string[]} banks
 * @property {string} query
 * @property {string[]} [tags]
 * @property {Record<string, HindsightTagGroup[]>} [tagGroupsByBank]
 * @property {"low" | "mid" | "high"} [budget]
 * @property {number} [maxTokens]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {{ tags: string[]; match?: "any" | "all" | "any_strict" | "all_strict" | "exact" }
 * | { and: HindsightTagGroup[] }
 * | { or: HindsightTagGroup[] }
 * | { not: HindsightTagGroup }} HindsightTagGroup
 */

/**
 * Hindsight-facing retain input used by the engine and memory tools.
 * @typedef {object} HindsightRetainInput
 * @property {string} bank
 * @property {string} content
 * @property {string[]} [tags]
 * @property {Record<string, string>} [metadata]
 * @property {string} documentId
 * @property {"replace" | "append"} [updateMode]
 * @property {boolean} [async]
 * @property {string} [context]
 * @property {AbortSignal} [signal]
 */

/** @param {string} value */
function base64url(value) {
    return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * A stable Hindsight document id. Exact facts use namespace + key, so a
 * repeated setFact is a document replace rather than a duplicate document.
 * @param {string} type
 * @param {string} identity
 */
function documentId(type, identity) {
    return `smithers-${type}-${base64url(identity)}`;
}

/**
 * @param {unknown} value
 * @returns {SmithersRecordEnvelope | undefined}
 */
function parseEnvelope(value) {
    if (typeof value !== "string" || value.length === 0) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || parsed.version !== RECORD_VERSION) {
            return undefined;
        }
        if (!(["fact", "thread", "message", "note"].includes(parsed.type)) || !parsed.value || typeof parsed.value !== "object") {
            return undefined;
        }
        return /** @type {SmithersRecordEnvelope} */ (parsed);
    }
    catch {
        return undefined;
    }
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function stringMetadata(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => entry == null ? [] : [[key, String(entry)]]));
}

/**
 * @param {string} operation
 * @param {"DB_QUERY_FAILED" | "DB_WRITE_FAILED"} code
 * @param {() => Promise<any>} run
 */
function remoteEffect(operation, code, run) {
    return Effect.tryPromise({
        try: run,
        catch: (cause) => toSmithersError(cause, operation, {
            code,
            details: { operation, backend: "hindsight" },
        }),
    });
}

/**
 * MemoryStore backed by Hindsight documents and semantic recall.
 *
 * Mapping:
 * - exact facts are retained with stable document ids and `updateMode=replace`;
 * - threads, messages, and notes are typed documents with stable record tags;
 * - exact identity, concurrency, and supersession live in a transactional
 *   contract store because Hindsight document ids are scoped to one bank;
 * - namespace identity selects a bank, while stable note/config tags stay tags;
 * - semantic note search and task recall call Hindsight recall;
 * - run/session identity is metadata, never a tag.
 *
 * @implements {MemoryStore}
 */
export class HindsightMemoryStore {
    /** @type {Map<string, { operation: string; run: () => Promise<void> }>} */
    #pendingProjections = new Map();
    /** @type {Map<string, Promise<void>>} */
    #projectionTails = new Map();
    /** @type {Promise<void> | null} */
    #projectionRetry = null;

    /** @param {HindsightMemoryStoreOptions} options */
    constructor(options) {
        if (!options || typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0) {
            throw new TypeError("HindsightMemoryStore requires a non-empty baseUrl.");
        }
        if (!options.contractStore) {
            throw new TypeError("HindsightMemoryStore requires a transactional contractStore.");
        }
        this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
        this.apiKey = options.apiKey;
        this.bankPrefix = options.bankPrefix ?? "";
        this.contractStore = options.contractStore;
        this.client = options.client ?? new HindsightClient({
            baseUrl: this.baseUrl,
            ...(this.apiKey ? { apiKey: this.apiKey } : {}),
            userAgent: "smithers-orchestrator/0.28",
        });
        const headers = {
            "User-Agent": "smithers-orchestrator/0.28",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        };
        this.sdkClient = createClient(createConfig({ baseUrl: this.baseUrl, headers }));
        /** @type {Set<string>} */
        this.knownBanks = new Set();
    }

    /** @param {string} bank */
    resolveBank(bank) {
        const resolved = this.bankPrefix && !bank.startsWith(this.bankPrefix)
            ? `${this.bankPrefix}${bank}`
            : bank;
        this.knownBanks.add(resolved);
        return resolved;
    }

    /**
     * Retry failed best-effort projections once. The queue is deliberately
     * process-local: the transactional contract store remains authoritative.
     */
    async #retryPendingProjections() {
        if (this.#projectionRetry) {
            await this.#projectionRetry;
            return;
        }
        const retry = async () => {
            for (const [key, pending] of [...this.#pendingProjections]) {
                if (this.#pendingProjections.get(key) !== pending) {
                    continue;
                }
                try {
                    await pending.run();
                    if (this.#pendingProjections.get(key) === pending) {
                        this.#pendingProjections.delete(key);
                    }
                }
                catch (error) {
                    this.#logProjectionFailure(pending.operation, key, error, true);
                }
            }
        };
        const running = retry();
        this.#projectionRetry = running;
        try {
            await running;
        }
        finally {
            if (this.#projectionRetry === running) {
                this.#projectionRetry = null;
            }
        }
    }

    /**
     * @param {string} key
     * @param {string} operation
     * @param {() => Promise<void>} run
     */
    async #projectBestEffort(key, operation, run) {
        const previous = this.#projectionTails.get(key) ?? Promise.resolve();
        const current = previous
            .catch(() => undefined)
            .then(async () => {
                try {
                    await run();
                    this.#pendingProjections.delete(key);
                }
                catch (error) {
                    this.#pendingProjections.set(key, { operation, run });
                    this.#logProjectionFailure(operation, key, error, false);
                }
            });
        this.#projectionTails.set(key, current);
        try {
            await current;
        }
        finally {
            if (this.#projectionTails.get(key) === current) {
                this.#projectionTails.delete(key);
            }
        }
    }

    /** @param {string} operation @param {string} key @param {unknown} error @param {boolean} retry */
    #logProjectionFailure(operation, key, error, retry) {
        logWarning("Hindsight projection failed; contract-store mutation remains committed", {
            operation,
            projectionKey: key,
            retry,
            pendingProjections: this.#pendingProjections.size,
            error: error instanceof Error ? error.message : String(error),
        }, "memory:hindsight");
    }

    /** @param {MemoryNamespace} ns */
    bankForNamespace(ns) {
        return this.resolveBank(`${ns.kind}-${encodeURIComponent(ns.id)}`);
    }

    /**
     * @returns {Promise<string[]>}
     */
    async listBankIds() {
        const response = await sdk.listBanks({ client: this.sdkClient });
        if (!response.data) {
            const status = response.response?.status;
            throw new HindsightError(`listBanks failed: ${JSON.stringify(response.error)}`, status, response.error);
        }
        for (const bank of response.data.banks ?? []) {
            if (typeof bank.bank_id === "string") {
                this.knownBanks.add(bank.bank_id);
            }
        }
        return [...this.knownBanks]
            .filter((bank) => !this.bankPrefix || bank.startsWith(this.bankPrefix))
            .sort();
    }

    /**
     * @param {string} bank
     * @returns {Promise<DocumentResponse[]>}
     */
    async listDocuments(bank) {
        /** @type {DocumentResponse[]} */
        const documents = [];
        let offset = 0;
        while (true) {
            const page = await this.client.listDocuments(bank, { limit: PAGE_SIZE, offset });
            for (const raw of page.items ?? []) {
                const item = /** @type {DocumentResponse} */ (raw);
                if (typeof item.id !== "string") {
                    continue;
                }
                if (typeof item.original_text === "string") {
                    documents.push(item);
                    continue;
                }
                const full = await this.client.getDocument(bank, item.id);
                if (full) {
                    documents.push(full);
                }
            }
            offset += page.items?.length ?? 0;
            if (offset >= page.total || (page.items?.length ?? 0) === 0) {
                break;
            }
        }
        return documents;
    }

    /**
     * @param {string} bank
     * @param {string} type
     * @returns {Promise<Array<{ document: DocumentResponse; envelope: SmithersRecordEnvelope }>>}
     */
    async listRecords(bank, type) {
        const documents = await this.listDocuments(bank);
        return documents.flatMap((document) => {
            const envelope = parseEnvelope(document.original_text);
            return envelope?.type === type ? [{ document, envelope }] : [];
        });
    }

    /**
     * @param {string} bank
     * @param {"fact" | "thread" | "message" | "note"} type
     * @param {string} id
     * @param {MemoryFact | MemoryThread | MemoryMessage | MemoryNote} value
     * @param {{ tags?: string[]; metadata?: Record<string, string>; supersedes?: string[]; context?: string }} [options]
     */
    async putRecord(bank, type, id, value, options = {}) {
        this.knownBanks.add(bank);
        /** @type {SmithersRecordEnvelope} */
        const envelope = { version: RECORD_VERSION, type, value };
        if (options.supersedes?.length) {
            envelope.supersedes = [...options.supersedes];
        }
        await this.client.retain(bank, JSON.stringify(envelope), {
            context: options.context ?? `Smithers ${type} record`,
            documentId: id,
            updateMode: "replace",
            async: false,
            tags: [...new Set([`${RECORD_TAG_PREFIX}${type}`, "source:smithers", ...(options.tags ?? [])])],
            metadata: {
                smithers_record_type: type,
                ...stringMetadata(options.metadata),
            },
        });
    }

    /** @param {MemoryNamespace} ns @param {string} key */
    async getFact(ns, key) {
        return this.contractStore.getFact(ns, key);
    }

    /**
     * @param {MemoryNamespace} ns
     * @param {string} key
     * @param {unknown} value
     * @param {number} [ttlMs]
     * @param {MemoryProvenance} [provenance]
     */
    async setFact(ns, key, value, ttlMs, provenance) {
        await this.#retryPendingProjections();
        const valueJson = JSON.stringify(value);
        if (valueJson === undefined) {
            throw new TypeError("memory setFact cannot store undefined.");
        }
        await this.contractStore.setFact(ns, key, value, ttlMs, provenance);
        const fact = await this.contractStore.getFact(ns, key);
        if (!fact) {
            throw new Error(`memory setFact: transactional readback missing ${namespaceToString(ns)}/${key}`);
        }
        const bank = this.bankForNamespace(ns);
        const id = documentId("fact", `${fact.namespace}\0${key}`);
        await this.#projectBestEffort(`${bank}:${id}`, "memory setFact projection", () => this.putRecord(bank, "fact", id, fact, {
            metadata: provenance,
            context: `Exact Smithers fact ${fact.namespace}/${key}`,
        }));
    }

    /** @param {MemoryNamespace} ns @param {string} key */
    async deleteFact(ns, key) {
        await this.#retryPendingProjections();
        const bank = this.bankForNamespace(ns);
        const id = documentId("fact", `${namespaceToString(ns)}\0${key}`);
        const existing = await this.contractStore.getFact(ns, key);
        await this.contractStore.deleteFact(ns, key);
        if (existing) {
            await this.#projectBestEffort(`${bank}:${id}`, "memory deleteFact projection", async () => {
                if (await this.client.getDocument(bank, id)) {
                    await this.client.deleteDocument(bank, id);
                }
            });
        }
    }

    /** @param {MemoryNamespace} ns */
    async listFacts(ns) {
        return this.contractStore.listFacts(ns);
    }

    async listAllFacts() {
        return this.contractStore.listAllFacts();
    }

    /** @param {MemoryNamespace} ns @param {string} [title] */
    async createThread(ns, title) {
        await this.#retryPendingProjections();
        const thread = await this.contractStore.createThread(ns, title);
        const bank = this.bankForNamespace(ns);
        const id = documentId("thread", thread.threadId);
        await this.#projectBestEffort(`${bank}:${id}`, "memory createThread projection", () => this.putRecord(bank, "thread", id, thread));
        return thread;
    }

    /** @param {string} threadId */
    async getThread(threadId) {
        return this.contractStore.getThread(threadId);
    }

    async listThreads() {
        return this.contractStore.listThreads();
    }

    /** @param {string} threadId */
    async deleteThread(threadId) {
        await this.#retryPendingProjections();
        const thread = await this.contractStore.getThread(threadId);
        if (!thread) {
            return;
        }
        const messages = await this.listMessages(threadId);
        const bank = this.bankForNamespace(parseNamespace(thread.namespace));
        await this.contractStore.deleteThread(threadId);
        await Promise.all([
            ...messages.map((message) => {
                const id = documentId("message", message.id);
                return this.#projectBestEffort(`${bank}:${id}`, "memory deleteThread message projection", () => this.client.deleteDocument(bank, id));
            }),
            (() => {
                const id = documentId("thread", threadId);
                return this.#projectBestEffort(`${bank}:${id}`, "memory deleteThread projection", () => this.client.deleteDocument(bank, id));
            })(),
        ]);
    }

    /** @param {Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number }} msg */
    async saveMessage(msg) {
        await this.#retryPendingProjections();
        await this.contractStore.saveMessage(msg);
        const message = await this.findContractMessage(msg.id);
        if (!message) {
            throw new Error(`memory saveMessage: transactional readback missing ${msg.id}`);
        }
        const thread = await this.contractStore.getThread(message.threadId);
        if (!thread) {
            throw new Error(`memory saveMessage: no thread with id ${message.threadId}`);
        }
        const bank = this.bankForNamespace(parseNamespace(thread.namespace));
        const id = documentId("message", message.id);
        await this.#projectBestEffort(`${bank}:${id}`, "memory saveMessage projection", () => this.putRecord(bank, "message", id, message, {
            metadata: { run: message.runId, node: message.nodeId, iteration: message.iteration, session: message.threadId },
            context: `Smithers thread ${message.threadId} ${message.role} message`,
        }));
    }

    /** @param {string} id @returns {Promise<MemoryMessage | undefined>} */
    async findContractMessage(id) {
        for (const thread of await this.contractStore.listThreads()) {
            const message = (await this.contractStore.listMessages(thread.threadId)).find((candidate) => candidate.id === id);
            if (message) {
                return message;
            }
        }
        return undefined;
    }

    /** @param {string} threadId @param {number} [limit] */
    async listMessages(threadId, limit) {
        return this.contractStore.listMessages(threadId, limit);
    }

    /** @param {string} threadId */
    async countMessages(threadId) {
        return this.contractStore.countMessages(threadId);
    }

    /** @param {string} threadId @param {string[]} messageIds */
    async deleteMessages(threadId, messageIds) {
        await this.#retryPendingProjections();
        const thread = await this.contractStore.getThread(threadId);
        const existing = new Set((await this.contractStore.listMessages(threadId)).map((message) => message.id));
        const selected = [...new Set(messageIds)].filter((id) => existing.has(id));
        const deleted = await this.contractStore.deleteMessages(threadId, messageIds);
        if (thread) {
            const bank = this.bankForNamespace(parseNamespace(thread.namespace));
            await Promise.all(selected.map((messageId) => {
                const id = documentId("message", messageId);
                return this.#projectBestEffort(`${bank}:${id}`, "memory deleteMessages projection", () => this.client.deleteDocument(bank, id));
            }));
        }
        return deleted;
    }

    async deleteExpiredFacts() {
        await this.#retryPendingProjections();
        const now = Date.now();
        const expired = (await this.contractStore.listAllFacts()).filter((fact) => fact.ttlMs != null && fact.updatedAtMs + fact.ttlMs < now);
        const deleted = await this.contractStore.deleteExpiredFacts();
        for (const fact of expired) {
            const ns = parseNamespace(fact.namespace);
            const bank = this.bankForNamespace(ns);
            const id = documentId("fact", `${fact.namespace}\0${fact.key}`);
            await this.#projectBestEffort(`${bank}:${id}`, "memory deleteExpiredFacts projection", async () => {
                if (await this.client.getDocument(bank, id)) {
                    await this.client.deleteDocument(bank, id);
                }
            });
        }
        return deleted;
    }

    /** @param {SaveNoteInput} input */
    async saveNote(input) {
        await this.#retryPendingProjections();
        const note = await this.contractStore.saveNote(input);
        const bank = this.bankForNamespace(parseNamespace(note.namespace));
        const tags = note.tagsJson ? JSON.parse(note.tagsJson) : [];
        const id = documentId("note", note.id);
        await this.#projectBestEffort(`${bank}:${id}`, "memory saveNote projection", () => this.putRecord(bank, "note", id, note, {
            tags,
            metadata: { run: note.runId, node: note.nodeId, iteration: note.iteration },
            context: note.kind ? `Smithers ${note.kind} note` : "Smithers knowledge note",
        }));
        return note;
    }

    /** @param {string} id */
    async getNote(id) {
        return this.contractStore.getNote(id);
    }

    /** @param {MemoryNamespace} ns @param {NoteReadFilter} [filter] */
    async listNotes(ns, filter) {
        return this.contractStore.listNotes(ns, filter);
    }

    /** @param {string} id @param {string} status */
    async setNoteStatus(id, status) {
        await this.#retryPendingProjections();
        await this.contractStore.setNoteStatus(id, status);
        const note = await this.contractStore.getNote(id);
        if (!note) {
            throw new Error(`memory setNoteStatus: transactional readback missing ${id}`);
        }
        const tags = note.tagsJson ? JSON.parse(note.tagsJson) : [];
        const bank = this.bankForNamespace(parseNamespace(note.namespace));
        const recordId = documentId("note", id);
        await this.#projectBestEffort(`${bank}:${recordId}`, "memory setNoteStatus projection", () => this.putRecord(bank, "note", recordId, note, {
            tags,
            metadata: { run: note.runId, node: note.nodeId, iteration: note.iteration },
        }));
    }

    /** @param {string} _kind */
    async enableNoteSearch(_kind) {
        await this.#retryPendingProjections();
        // Hindsight indexes retained content on write, so no separate FTS setup is needed.
    }

    /**
     * @param {string} kind
     * @param {string} query
     * @param {number} [limit]
     * @param {NoteReadFilter} [filter]
     */
    async searchNotes(kind, query, limit, filter) {
        const max = limit ?? 20;
        if (!Number.isInteger(max) || max < 0) {
            throw new TypeError("memory searchNotes limit must be a non-negative integer.");
        }
        if (max === 0 || query.trim().length === 0) {
            return [];
        }
        const banks = filter?.namespace ? [this.bankForNamespace(filter.namespace)] : await this.listBankIds();
        /** @type {MemoryNote[]} */
        const notes = [];
        for (const bank of banks) {
            const response = await this.client.recall(bank, query, {
                budget: "low",
                maxTokens: Math.max(256, max * 128),
                tagGroups: [{ tags: [`${RECORD_TAG_PREFIX}note`], match: "all_strict" }],
            });
            for (const result of response.results ?? []) {
                if (!result.document_id) {
                    continue;
                }
                const document = await this.client.getDocument(bank, result.document_id);
                const envelope = parseEnvelope(document?.original_text);
                if (envelope?.type !== "note") {
                    continue;
                }
                const note = /** @type {MemoryNote} */ (envelope.value);
                if (parseNamespace(note.namespace).kind === kind) {
                    notes.push(note);
                }
            }
        }
        const unique = [...new Map(notes.map((note) => [note.id, note])).values()];
        /** @type {Map<string, Set<string>>} */
        const permittedByNamespace = new Map();
        for (const note of unique) {
            if (!permittedByNamespace.has(note.namespace)) {
                const permitted = await this.contractStore.listNotes(parseNamespace(note.namespace), filter);
                permittedByNamespace.set(note.namespace, new Set(permitted.map((candidate) => candidate.id)));
            }
        }
        return unique
            .filter((note) => permittedByNamespace.get(note.namespace)?.has(note.id))
            .slice(0, max);
    }

    /**
     * Recall task memories. Stable config tags are encoded exclusively as a
     * tag_groups filter so the SDK never receives the mutually-exclusive
     * tags and tag_groups fields together.
     * @param {HindsightRecallInput} input
     * @returns {Promise<Array<RecallResult & { bank: string }>>}
     */
    async recallMemory(input) {
        const banks = input.banks.map((rawBank) => ({ rawBank, bank: this.resolveBank(rawBank) }));
        if (banks.length === 0) {
            return [];
        }
        if (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 0)) {
            throw new TypeError("memory recall maxTokens must be a non-negative safe integer.");
        }
        const perBankTokens = input.maxTokens === undefined
            ? undefined
            : Math.max(1, Math.floor(input.maxTokens / banks.length));
        const responses = await Promise.all(banks.map(async ({ rawBank, bank }) => {
            const tagGroups = input.tagGroupsByBank?.[rawBank]
                ?? input.tagGroupsByBank?.[bank]
                ?? (input.tags?.length ? [{ tags: [...input.tags], match: "all_strict" }] : undefined);
            const response = await this.client.recall(bank, input.query, {
                budget: input.budget ?? "mid",
                maxTokens: perBankTokens,
                ...(tagGroups?.length ? { tagGroups } : {}),
                signal: input.signal,
            });
            return (response.results ?? []).map((result) => ({ ...result, bank }));
        }));
        return capMemoryRecallResults(responses.flat(), input.maxTokens);
    }

    /**
     * Fetch mental-model content verbatim for task primer injection.
     * @param {{ banks: string[]; primerIds: string[]; signal?: AbortSignal }} input
     */
    async getPrimers(input) {
        const lookups = input.banks.flatMap((rawBank) => {
            const bank = this.resolveBank(rawBank);
            return input.primerIds.map(async (primerId) => {
                try {
                    const model = await this.client.getMentalModel(bank, primerId, { signal: input.signal });
                    if (typeof model.content === "string" && model.content.length > 0) {
                        return { bank, id: primerId, content: model.content };
                    }
                }
                catch (error) {
                    if (error instanceof HindsightError && error.statusCode === 404) {
                        return null;
                    }
                    throw error;
                }
                return null;
            });
        });
        const contents = await Promise.all(lookups);
        return contents.flatMap((content) => content ? [content] : []);
    }

    /**
     * Retain an engine/tool memory using append semantics and stable document
     * identity. Callers put volatile run/session ids in metadata.
     * @param {HindsightRetainInput} input
     */
    async retainMemory(input) {
        const bank = this.resolveBank(input.bank);
        await this.client.retain(bank, input.content, {
            context: input.context,
            metadata: stringMetadata(input.metadata),
            documentId: input.documentId,
            tags: input.tags,
            updateMode: input.updateMode ?? "append",
            async: input.async ?? true,
            signal: input.signal,
        });
    }

    // Effect variants preserve the existing MemoryStore contract.
    getFactEffect(ns, key) { return remoteEffect("memory getFact", "DB_QUERY_FAILED", () => this.getFact(ns, key)); }
    setFactEffect(ns, key, value, ttlMs, provenance) { return remoteEffect("memory setFact", "DB_WRITE_FAILED", () => this.setFact(ns, key, value, ttlMs, provenance)); }
    deleteFactEffect(ns, key) { return remoteEffect("memory deleteFact", "DB_WRITE_FAILED", () => this.deleteFact(ns, key)); }
    listFactsEffect(ns) { return remoteEffect("memory listFacts", "DB_QUERY_FAILED", () => this.listFacts(ns)); }
    listAllFactsEffect() { return remoteEffect("memory listAllFacts", "DB_QUERY_FAILED", () => this.listAllFacts()); }
    createThreadEffect(ns, title) { return remoteEffect("memory createThread", "DB_WRITE_FAILED", () => this.createThread(ns, title)); }
    getThreadEffect(threadId) { return remoteEffect("memory getThread", "DB_QUERY_FAILED", () => this.getThread(threadId)); }
    listThreadsEffect() { return remoteEffect("memory listThreads", "DB_QUERY_FAILED", () => this.listThreads()); }
    deleteThreadEffect(threadId) { return remoteEffect("memory deleteThread", "DB_WRITE_FAILED", () => this.deleteThread(threadId)); }
    saveMessageEffect(msg) { return remoteEffect("memory saveMessage", "DB_WRITE_FAILED", () => this.saveMessage(msg)); }
    listMessagesEffect(threadId, limit) { return remoteEffect("memory listMessages", "DB_QUERY_FAILED", () => this.listMessages(threadId, limit)); }
    countMessagesEffect(threadId) { return remoteEffect("memory countMessages", "DB_QUERY_FAILED", () => this.countMessages(threadId)); }
    deleteMessagesEffect(threadId, messageIds) { return remoteEffect("memory deleteMessages", "DB_WRITE_FAILED", () => this.deleteMessages(threadId, messageIds)); }
    deleteExpiredFactsEffect() { return remoteEffect("memory deleteExpiredFacts", "DB_WRITE_FAILED", () => this.deleteExpiredFacts()); }
    saveNoteEffect(input) { return remoteEffect("memory saveNote", "DB_WRITE_FAILED", () => this.saveNote(input)); }
    getNoteEffect(id) { return remoteEffect("memory getNote", "DB_QUERY_FAILED", () => this.getNote(id)); }
    listNotesEffect(ns, filter) { return remoteEffect("memory listNotes", "DB_QUERY_FAILED", () => this.listNotes(ns, filter)); }
    setNoteStatusEffect(id, status) { return remoteEffect("memory setNoteStatus", "DB_WRITE_FAILED", () => this.setNoteStatus(id, status)); }
    enableNoteSearchEffect(kind) { return remoteEffect("memory enableNoteSearch", "DB_WRITE_FAILED", () => this.enableNoteSearch(kind)); }
    searchNotesEffect(kind, query, limit, filter) { return remoteEffect("memory searchNotes", "DB_QUERY_FAILED", () => this.searchNotes(kind, query, limit, filter)); }
}

/** @param {HindsightMemoryStoreOptions} options */
export function createHindsightMemoryStore(options) {
    return new HindsightMemoryStore(options);
}
