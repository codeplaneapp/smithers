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
import { namespaceToString } from "./namespaceToString.js";
import { parseNamespace } from "./parseNamespace.js";

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
 * @property {"low" | "mid" | "high"} [budget]
 * @property {number} [maxTokens]
 * @property {AbortSignal} [signal]
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

/** @param {unknown} value */
function asTimestamp(value) {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
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
 * @param {NoteReadFilter | undefined} filter
 * @param {MemoryNote} note
 * @param {Set<string>} superseded
 */
function noteMatches(filter, note, superseded) {
    if (!filter?.includeSuperseded && superseded.has(note.id)) {
        return false;
    }
    const status = filter?.status ?? "accepted";
    if (status !== "any") {
        if (Array.isArray(status) ? !status.includes(note.status) : note.status !== status) {
            return false;
        }
    }
    if (filter?.kind && note.kind !== filter.kind) {
        return false;
    }
    if (filter?.namespace && note.namespace !== namespaceToString(filter.namespace)) {
        return false;
    }
    return true;
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
 * - namespace identity selects a bank, while stable note/config tags stay tags;
 * - semantic note search and task recall call Hindsight recall;
 * - run/session identity is metadata, never a tag.
 *
 * @implements {MemoryStore}
 */
export class HindsightMemoryStore {
    /** @param {HindsightMemoryStoreOptions} options */
    constructor(options) {
        if (!options || typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0) {
            throw new TypeError("HindsightMemoryStore requires a non-empty baseUrl.");
        }
        this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
        this.apiKey = options.apiKey;
        this.bankPrefix = options.bankPrefix ?? "";
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

    /**
     * @param {string} id
     * @param {"thread" | "note"} type
     */
    async findRecord(id, type) {
        const docId = documentId(type, id);
        for (const bank of await this.listBankIds()) {
            const document = await this.client.getDocument(bank, docId);
            const envelope = parseEnvelope(document?.original_text);
            if (document && envelope?.type === type) {
                return { bank, document, envelope };
            }
        }
        return undefined;
    }

    /** @param {MemoryNamespace} ns @param {string} key */
    async getFact(ns, key) {
        const bank = this.bankForNamespace(ns);
        const doc = await this.client.getDocument(bank, documentId("fact", `${namespaceToString(ns)}\0${key}`));
        const envelope = parseEnvelope(doc?.original_text);
        return envelope?.type === "fact" ? /** @type {MemoryFact} */ (envelope.value) : undefined;
    }

    /**
     * @param {MemoryNamespace} ns
     * @param {string} key
     * @param {unknown} value
     * @param {number} [ttlMs]
     * @param {MemoryProvenance} [provenance]
     */
    async setFact(ns, key, value, ttlMs, provenance) {
        const valueJson = JSON.stringify(value);
        if (valueJson === undefined) {
            throw new TypeError("memory setFact cannot store undefined.");
        }
        const previous = await this.getFact(ns, key);
        const now = Date.now();
        /** @type {MemoryFact} */
        const fact = {
            namespace: namespaceToString(ns),
            key,
            valueJson,
            schemaSig: null,
            createdAtMs: previous?.createdAtMs ?? now,
            updatedAtMs: now,
            ttlMs: ttlMs ?? null,
            runId: provenance?.runId ?? null,
            nodeId: provenance?.nodeId ?? null,
            iteration: provenance?.iteration ?? null,
        };
        await this.putRecord(this.bankForNamespace(ns), "fact", documentId("fact", `${fact.namespace}\0${key}`), fact, {
            metadata: provenance,
            context: `Exact Smithers fact ${fact.namespace}/${key}`,
        });
    }

    /** @param {MemoryNamespace} ns @param {string} key */
    async deleteFact(ns, key) {
        const bank = this.bankForNamespace(ns);
        const id = documentId("fact", `${namespaceToString(ns)}\0${key}`);
        if (await this.client.getDocument(bank, id)) {
            await this.client.deleteDocument(bank, id);
        }
    }

    /** @param {MemoryNamespace} ns */
    async listFacts(ns) {
        const namespace = namespaceToString(ns);
        const records = await this.listRecords(this.bankForNamespace(ns), "fact");
        return records
            .map((record) => /** @type {MemoryFact} */ (record.envelope.value))
            .filter((fact) => fact.namespace === namespace)
            .sort((a, b) => a.key.localeCompare(b.key));
    }

    async listAllFacts() {
        const facts = (await Promise.all((await this.listBankIds()).map(async (bank) =>
            (await this.listRecords(bank, "fact")).map((record) => /** @type {MemoryFact} */ (record.envelope.value))))).flat();
        return facts.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key));
    }

    /** @param {MemoryNamespace} ns @param {string} [title] */
    async createThread(ns, title) {
        const now = Date.now();
        /** @type {MemoryThread} */
        const thread = {
            threadId: crypto.randomUUID(),
            namespace: namespaceToString(ns),
            title: title ?? null,
            metadataJson: null,
            createdAtMs: now,
            updatedAtMs: now,
        };
        await this.putRecord(this.bankForNamespace(ns), "thread", documentId("thread", thread.threadId), thread);
        return thread;
    }

    /** @param {string} threadId */
    async getThread(threadId) {
        const record = await this.findRecord(threadId, "thread");
        return record ? /** @type {MemoryThread} */ (record.envelope.value) : undefined;
    }

    async listThreads() {
        const threads = (await Promise.all((await this.listBankIds()).map(async (bank) =>
            (await this.listRecords(bank, "thread")).map((record) => /** @type {MemoryThread} */ (record.envelope.value))))).flat();
        return threads.sort((a, b) => a.createdAtMs - b.createdAtMs || a.threadId.localeCompare(b.threadId));
    }

    /** @param {string} threadId */
    async deleteThread(threadId) {
        const record = await this.findRecord(threadId, "thread");
        if (!record) {
            return;
        }
        const messages = await this.listMessages(threadId);
        await Promise.all(messages.map((message) => this.client.deleteDocument(record.bank, documentId("message", message.id))));
        await this.client.deleteDocument(record.bank, documentId("thread", threadId));
    }

    /** @param {Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number }} msg */
    async saveMessage(msg) {
        const threadRecord = await this.findRecord(msg.threadId, "thread");
        if (!threadRecord) {
            throw new Error(`memory saveMessage: no thread with id ${msg.threadId}`);
        }
        const existingDoc = await this.client.getDocument(threadRecord.bank, documentId("message", msg.id));
        const existing = parseEnvelope(existingDoc?.original_text);
        /** @type {MemoryMessage} */
        const message = {
            id: msg.id,
            threadId: msg.threadId,
            role: msg.role,
            contentJson: msg.contentJson,
            runId: msg.runId ?? null,
            nodeId: msg.nodeId ?? null,
            iteration: msg.iteration ?? null,
            createdAtMs: existing?.type === "message"
                ? /** @type {MemoryMessage} */ (existing.value).createdAtMs
                : (msg.createdAtMs ?? Date.now()),
        };
        await this.putRecord(threadRecord.bank, "message", documentId("message", msg.id), message, {
            metadata: { run: msg.runId, node: msg.nodeId, iteration: msg.iteration, session: msg.threadId },
            context: `Smithers thread ${msg.threadId} ${msg.role} message`,
        });
    }

    /** @param {string} threadId @param {number} [limit] */
    async listMessages(threadId, limit) {
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
            throw new TypeError("memory listMessages limit must be a non-negative integer.");
        }
        const threadRecord = await this.findRecord(threadId, "thread");
        if (!threadRecord || limit === 0) {
            return [];
        }
        const messages = (await this.listRecords(threadRecord.bank, "message"))
            .map((record) => /** @type {MemoryMessage} */ (record.envelope.value))
            .filter((message) => message.threadId === threadId)
            .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
        return limit === undefined ? messages : messages.slice(0, limit);
    }

    /** @param {string} threadId */
    async countMessages(threadId) {
        return (await this.listMessages(threadId)).length;
    }

    /** @param {string} threadId @param {string[]} messageIds */
    async deleteMessages(threadId, messageIds) {
        if (messageIds.length === 0) {
            return 0;
        }
        const threadRecord = await this.findRecord(threadId, "thread");
        if (!threadRecord) {
            return 0;
        }
        const existing = new Set((await this.listMessages(threadId)).map((message) => message.id));
        const selected = [...new Set(messageIds)].filter((id) => existing.has(id));
        await Promise.all(selected.map((id) => this.client.deleteDocument(threadRecord.bank, documentId("message", id))));
        return selected.length;
    }

    async deleteExpiredFacts() {
        const now = Date.now();
        const expired = (await this.listAllFacts()).filter((fact) => fact.ttlMs != null && fact.updatedAtMs + fact.ttlMs < now);
        for (const fact of expired) {
            await this.deleteFact(parseNamespace(fact.namespace), fact.key);
        }
        return expired.length;
    }

    /** @param {SaveNoteInput} input */
    async saveNote(input) {
        const id = input.id ?? crypto.randomUUID();
        const bank = this.bankForNamespace(input.namespace);
        const existing = await this.client.getDocument(bank, documentId("note", id));
        const existingEnvelope = parseEnvelope(existing?.original_text);
        if (existingEnvelope?.type === "note") {
            return /** @type {MemoryNote} */ (existingEnvelope.value);
        }
        const now = Date.now();
        /** @type {MemoryNote} */
        const note = {
            id,
            namespace: namespaceToString(input.namespace),
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
        await this.putRecord(bank, "note", documentId("note", id), note, {
            tags: input.tags,
            metadata: { run: note.runId, node: note.nodeId, iteration: note.iteration },
            supersedes: input.supersedes,
            context: input.kind ? `Smithers ${input.kind} note` : "Smithers knowledge note",
        });
        return note;
    }

    /** @param {string} id */
    async getNote(id) {
        const record = await this.findRecord(id, "note");
        return record ? /** @type {MemoryNote} */ (record.envelope.value) : undefined;
    }

    /** @param {MemoryNamespace} ns @param {NoteReadFilter} [filter] */
    async listNotes(ns, filter) {
        const namespace = namespaceToString(ns);
        const records = await this.listRecords(this.bankForNamespace(ns), "note");
        const acceptedSuperseders = records.filter((record) => /** @type {MemoryNote} */ (record.envelope.value).status === "accepted");
        const superseded = new Set(acceptedSuperseders.flatMap((record) => record.envelope.supersedes ?? []));
        return records
            .map((record) => /** @type {MemoryNote} */ (record.envelope.value))
            .filter((note) => note.namespace === namespace && noteMatches(filter, note, superseded))
            .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
    }

    /** @param {string} id @param {string} status */
    async setNoteStatus(id, status) {
        const record = await this.findRecord(id, "note");
        if (!record) {
            throw new Error(`memory setNoteStatus: no note with id ${id}`);
        }
        const note = /** @type {MemoryNote} */ (record.envelope.value);
        const updated = { ...note, status, statusChangedAtMs: Date.now() };
        const tags = note.tagsJson ? JSON.parse(note.tagsJson) : [];
        await this.putRecord(record.bank, "note", record.document.id, updated, {
            tags,
            supersedes: record.envelope.supersedes,
            metadata: { run: note.runId, node: note.nodeId, iteration: note.iteration },
        });
    }

    /** @param {string} _kind */
    async enableNoteSearch(_kind) {
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
        const allNotes = (await Promise.all(banks.map(async (bank) => this.listRecords(bank, "note")))).flat();
        const superseded = new Set(allNotes
            .filter((record) => /** @type {MemoryNote} */ (record.envelope.value).status === "accepted")
            .flatMap((record) => record.envelope.supersedes ?? []));
        return unique.filter((note) => noteMatches(filter, note, superseded)).slice(0, max);
    }

    /**
     * Recall task memories. Stable config tags are encoded exclusively as a
     * tag_groups filter so the SDK never receives the mutually-exclusive
     * tags and tag_groups fields together.
     * @param {HindsightRecallInput} input
     * @returns {Promise<Array<RecallResult & { bank: string }>>}
     */
    async recallMemory(input) {
        const banks = input.banks.map((bank) => this.resolveBank(bank));
        if (banks.length === 0) {
            return [];
        }
        const perBankTokens = input.maxTokens === undefined
            ? undefined
            : Math.max(1, Math.floor(input.maxTokens / banks.length));
        const responses = await Promise.all(banks.map(async (bank) => {
            const response = await this.client.recall(bank, input.query, {
                budget: input.budget ?? "mid",
                maxTokens: perBankTokens,
                ...(input.tags?.length ? {
                    tagGroups: [{ tags: [...input.tags], match: "all_strict" }],
                } : {}),
                signal: input.signal,
            });
            return (response.results ?? []).map((result) => ({ ...result, bank }));
        }));
        return responses.flat();
    }

    /**
     * Fetch mental-model content verbatim for task primer injection.
     * @param {{ banks: string[]; primerIds: string[]; signal?: AbortSignal }} input
     */
    async getPrimers(input) {
        const contents = [];
        for (const rawBank of input.banks) {
            const bank = this.resolveBank(rawBank);
            for (const primerId of input.primerIds) {
                const model = await this.client.getMentalModel(bank, primerId, { signal: input.signal });
                if (typeof model.content === "string" && model.content.length > 0) {
                    contents.push({ bank, id: primerId, content: model.content });
                }
            }
        }
        return contents;
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
