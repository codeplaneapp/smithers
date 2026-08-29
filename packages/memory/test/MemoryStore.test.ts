import { Effect } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import type { MemoryError } from "../src/MemoryError.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import type * as Namespace from "../src/Namespace.ts"
import { literalFtsQuery } from "../src/RecallFts.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const namespace = { kind: "flow", id: "project-1" } as const
const other = { kind: "flow", id: "project-2" } as const

const run = <A, E>(effect: Effect.Effect<A, E, MemoryStore.MemoryStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestMemory.layer), Effect.provide(TestClock.layer())))

const runWithDatabase = <A, E>(
  effect: Effect.Effect<A, E, MemoryStore.MemoryStore | SqlClient.SqlClient>
) => Effect.runPromise(effect.pipe(Effect.provide(TestMemory.layerWithDatabase)))

describe("MemoryStore", () => {
  it("applies the authoritative and projection schemas idempotently", async () => {
    const tables = await Effect.runPromise(
      Effect.gen(function*() {
        yield* MemoryStore.MemoryStore
        yield* MemoryStore.make
        yield* MemoryStore.make
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const rows = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'memory_%'
          ORDER BY name
        `
        return rows.map((row) => row.name)
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(tables).toEqual([
      "memory_facts",
      "memory_fts_kinds",
      "memory_messages",
      "memory_note_supersedes",
      "memory_notes",
      "memory_threads",
      "memory_vectors"
    ])
  })

  it("upserts facts last-write-wins and restarts TTL from the last update", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "session:state",
        value: { version: 1 },
        ttlMs: 10,
        provenance: { runId: "run-1" }
      })
      yield* TestClock.adjust("6 millis")
      yield* store.putFact({
        namespace,
        key: "session:state",
        value: { version: 2 },
        ttlMs: 10,
        provenance: { runId: "run-2" }
      })
      yield* store.putFact({
        namespace,
        key: "other",
        value: "ignored by prefix",
        provenance: {}
      })
      yield* TestClock.adjust("5 millis")
      const current = yield* store.getFact({ namespace, key: "session:state" })
      const listed = yield* store.listFacts({ namespace, prefix: "session:" })
      yield* TestClock.adjust("5 millis")
      const expired = yield* store.getFact({ namespace, key: "session:state" })
      const afterExpiry = yield* store.listFacts({ namespace, prefix: "session:" })
      return { current, listed, expired, afterExpiry }
    }))

    expect(result.current).toMatchObject({ value: { version: 2 }, provenance: { runId: "run-2" } })
    expect(result.listed.map((fact) => fact.key)).toEqual(["session:state"])
    expect(result.expired).toBeUndefined()
    expect(result.afterExpiry).toEqual([])
  })

  it("appends ordered history idempotently on message id", async () => {
    const messages = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage({ threadId: "thread-1", id: "b", role: "assistant", text: "second", at: 2 })
      yield* store.appendMessage({ threadId: "thread-1", id: "a", role: "user", text: "first", at: 1 })
      yield* store.appendMessage({
        threadId: "thread-1",
        id: "a",
        role: "user",
        text: "must not replace",
        at: 9
      })
      return yield* store.listMessages({ threadId: "thread-1" })
    }))

    expect(messages).toEqual([
      { threadId: "thread-1", id: "a", role: "user", text: "first", at: 1 },
      { threadId: "thread-1", id: "b", role: "assistant", text: "second", at: 2 }
    ])
  })

  it("supports the complete fact, thread, note, and message contract", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "delete-me", value: "value", provenance: {} })
      const allFacts = yield* store.listAllFacts()
      const deletedFact = yield* store.deleteFact({ namespace, key: "delete-me" })
      const thread = yield* store.createThread({
        id: "thread-crud",
        namespace,
        title: "Review",
        metadata: { branch: "main" }
      })
      yield* store.appendMessage({
        threadId: thread.id,
        id: "message-1",
        role: "user",
        text: "hello",
        at: 1
      })
      const count = yield* store.countMessages({ threadId: thread.id })
      const fetched = yield* store.getThread(thread.id)
      const threads = yield* store.listThreads({ namespace })
      yield* store.putNote({
        namespace,
        id: "get-note",
        text: "note",
        tags: [],
        provenance: {}
      })
      const note = yield* store.getNote({ id: "get-note" })
      const deletedThread = yield* store.deleteThread(thread.id)
      const missing = yield* store.getThread(thread.id)
      return {
        allFacts,
        deletedFact,
        count,
        fetched,
        threads,
        note,
        deletedThread,
        missing
      }
    }))

    expect(result.allFacts.map((fact) => fact.key)).toEqual(["delete-me"])
    expect(result.deletedFact).toBe(true)
    expect(result.count).toBe(1)
    expect(result.fetched).toMatchObject({ title: "Review", metadata: { branch: "main" } })
    expect(result.threads.map((thread) => thread.id)).toEqual(["thread-crud"])
    expect(result.note).toMatchObject({ id: "get-note", text: "note" })
    expect(result.deletedThread).toBe(true)
    expect(result.missing).toBeUndefined()
  })

  it("projects equal record ids independently in different namespaces", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* store.putFact({
          namespace: { kind: "flow", id: "one" },
          key: "shared",
          value: "first",
          provenance: {}
        })
        yield* store.putFact({
          namespace: { kind: "flow", id: "two" },
          key: "shared",
          value: "second",
          provenance: {}
        })
        return yield* sql<{ readonly namespace_id: string }>`
          SELECT namespace_id FROM memory_vectors
          WHERE record_kind = 'fact' AND record_id = 'shared'
          ORDER BY namespace_id
        `
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(rows.map((row) => row.namespace_id)).toEqual(["one", "two"])
  })

  it("keeps notes immutable and hides targets only for accepted superseders", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({
        namespace,
        id: "old",
        text: "old guidance",
        tags: ["scope:project"],
        provenance: { runId: "run-1" }
      })
      const duplicate = yield* Effect.flip(store.putNote({
        namespace,
        id: "old",
        text: "attempted mutation",
        tags: ["scope:secret"],
        provenance: { runId: "run-2" }
      }))
      yield* store.putNote({
        namespace,
        id: "replacement",
        text: "new guidance",
        tags: ["scope:project"],
        provenance: { runId: "run-3" },
        status: "pending",
        supersedes: ["old"]
      })
      const pending = yield* store.listNotes({ namespace })
      yield* store.setNoteStatus({ id: "replacement", status: "accepted" })
      const accepted = yield* store.listNotes({ namespace })
      yield* store.setNoteStatus({ id: "replacement", status: "rejected" })
      const rejected = yield* store.listNotes({ namespace })
      const audit = yield* store.listNotes({ namespace, status: "any", includeSuperseded: true })
      return { duplicate, pending, accepted, rejected, audit }
    }))

    expect(result.duplicate).toMatchObject({
      code: "supersede_conflict",
      message: expect.stringContaining("different creation data")
    })
    expect(result.pending.map((note) => note.id)).toEqual(["old"])
    expect(result.accepted.map((note) => note.id)).toEqual(["replacement"])
    expect(result.rejected.map((note) => note.id)).toEqual(["old"])
    expect(result.audit.map((note) => [note.id, note.text])).toEqual([
      ["old", "old guidance"],
      ["replacement", "new guidance"]
    ])
  })

  it("rejects note id collisions and supersession edges across namespaces", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({ namespace, id: "shared", text: "one", tags: [], provenance: {} })
      const collision = yield* Effect.flip(
        store.putNote({ namespace: other, id: "shared", text: "one", tags: [], provenance: {} })
      )
      yield* store.putNote({ namespace: other, id: "other", text: "two", tags: [], provenance: {} })
      const edge = yield* Effect.flip(store.supersede({ supersederId: "shared", targetId: "other" }))
      return { collision, edge }
    }))

    expect(failures.collision).toMatchObject({
      code: "supersede_conflict",
      message: expect.stringContaining("different creation data")
    })
    expect(failures.edge).toMatchObject({
      code: "supersede_conflict",
      message: expect.stringContaining("share a namespace")
    })
  })

  it("writes standalone supersession edges idempotently and rejects invalid edges", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({
        namespace,
        id: "target",
        text: "target",
        tags: [],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "superseder",
        text: "superseder",
        tags: [],
        provenance: {}
      })
      yield* store.supersede({ supersederId: "superseder", targetId: "target" })
      yield* store.supersede({ supersederId: "superseder", targetId: "target" })
      const visible = yield* store.listNotes({ namespace })
      const invalid = yield* Effect.flip(store.supersede({ supersederId: "missing", targetId: "target" }))
      return { visible, invalid }
    }))

    expect(result.visible.map((note) => note.id)).toEqual(["superseder"])
    expect(result.invalid.code).toBe("supersede_conflict")
  })

  it("rolls back an accompanying note when its supersession edge is invalid", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const failure = yield* Effect.flip(
        store.putNote({
          namespace,
          id: "must-roll-back",
          text: "not durable",
          tags: [],
          provenance: {},
          supersedes: ["missing"]
        })
      )
      const notes = yield* store.listNotes({ namespace, status: "any", includeSuperseded: true })
      return { failure, notes }
    }))

    expect(result.failure.code).toBe("supersede_conflict")
    expect(result.notes).toEqual([])
  })

  it("filters authoritative raw rows by tags, status, and supersession", async () => {
    const rows = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "fact-1",
        value: { content: "fact text", tags: ["scope:project"] },
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "note-1",
        text: "note text",
        tags: ["scope:project", "branch:main"],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "pending",
        text: "not authoritative",
        tags: ["scope:project"],
        provenance: {},
        status: "pending"
      })
      return yield* store.searchRows({
        namespace,
        tagGroups: [
          { tags: ["scope:project"], match: "all_strict" },
          { not: { tags: ["scope:secret"], match: "any_strict" } }
        ]
      })
    }))

    expect(rows.map((row) => [row.kind, row.key, row.text])).toEqual([
      ["fact", "fact-1", "fact text"],
      ["note", "note-1", "note text"]
    ])
    expect(rows.every((row) => row.bank === "flow-project-1")).toBe(true)
  })

  it("fails loudly before FTS enablement, then backfills and updates the per-kind index", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: { content: "durable checkout recovery", tags: ["scope:project"] },
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "note-fts",
        text: "durable release checklist",
        tags: ["scope:project"],
        provenance: {}
      })
      const disabled = yield* Effect.flip(store.searchFts({ namespace, query: "durable", limit: 10 }))
      yield* store.enableFts("flow")
      const backfilled = yield* store.searchFts({ namespace, query: "durable", limit: 10 })
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: { content: "fresh recovery procedure", tags: ["scope:project"] },
        provenance: {}
      })
      const stale = yield* store.searchFts({ namespace, query: "checkout", limit: 10 })
      const fresh = yield* store.searchFts({ namespace, query: "fresh recovery", limit: 10 })
      const compiled = yield* store.searchFts({
        namespace,
        query: literalFtsQuery("fresh recovery"),
        limit: 10
      })
      return { disabled, backfilled, stale, fresh, compiled }
    }))

    expect(result.disabled.code).toBe("fts_not_enabled")
    expect(result.backfilled.map((row) => row.key).sort()).toEqual(["note-fts", "runbook"])
    expect(result.stale).toEqual([])
    expect(result.fresh.map((row) => row.key)).toEqual(["runbook"])
    expect(result.compiled.map((row) => row.key)).toEqual(["runbook"])
    expect(result.fresh[0]?.rank).toEqual(expect.any(Number))
  })

  it("validates namespaces, identifiers, tags, and times before touching the database", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const overCap = Array.from({ length: 17 }, (_, index) => `scope:${index}`) as unknown as Namespace.Tags
      return [
        yield* Effect.flip(
          store.putFact({ namespace: { kind: "flow", id: "" }, key: "k", value: 1, provenance: {} })
        ),
        yield* Effect.flip(store.putFact({ namespace, key: "", value: 1, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "k", value: 1, ttlMs: -1, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "k", value: 1, ttlMs: 1.5, provenance: {} })),
        yield* Effect.flip(
          store.putNote({
            namespace,
            id: "n",
            text: "t",
            tags: ["vendor:x"] as unknown as Namespace.Tags,
            provenance: {}
          })
        ),
        yield* Effect.flip(store.putNote({ namespace, id: "n", text: "t", tags: overCap, provenance: {} })),
        yield* Effect.flip(store.putNote({ namespace, id: "", text: "t", tags: [], provenance: {} })),
        yield* Effect.flip(store.appendMessage({ threadId: "", id: "m", role: "user", text: "x", at: 0 })),
        yield* Effect.flip(store.appendMessage({ threadId: "t", id: "", role: "user", text: "x", at: 0 })),
        yield* Effect.flip(store.appendMessage({ threadId: "t", id: "m", role: "", text: "x", at: 0 })),
        yield* Effect.flip(store.appendMessage({ threadId: "t", id: "m", role: "user", text: "x", at: -1 })),
        yield* Effect.flip(store.getFact({ namespace, key: "" })),
        yield* Effect.flip(store.deleteFact({ namespace, key: "" })),
        yield* Effect.flip(store.getThread("")),
        yield* Effect.flip(store.deleteThread("")),
        yield* Effect.flip(store.listMessages({ threadId: "" })),
        yield* Effect.flip(store.countMessages({ threadId: "" })),
        yield* Effect.flip(store.deleteMessages({ threadId: "", ids: ["a"] })),
        yield* Effect.flip(store.getNote({ id: "" })),
        yield* Effect.flip(store.setNoteStatus({ id: "", status: "accepted" })),
        yield* Effect.flip(store.supersede({ supersederId: "", targetId: "t" })),
        yield* Effect.flip(store.supersede({ supersederId: "s", targetId: "" }))
      ]
    }))

    expect(failures.map((error) => [error.code, error.message])).toEqual([
      ["invalid_namespace", "memory namespace is invalid"],
      ["store", "fact key must not be empty"],
      ["store", "ttlMs must be a non-negative safe integer"],
      ["store", "ttlMs must be a non-negative safe integer"],
      ["invalid_tag", "memory tags violate the vocabulary or 16-tag cap"],
      ["invalid_tag", "memory tags violate the vocabulary or 16-tag cap"],
      ["store", "note id must not be empty"],
      ["store", "threadId must not be empty"],
      ["store", "message id must not be empty"],
      ["store", "message role must not be empty"],
      ["store", "message at must be a non-negative safe integer"],
      ["store", "fact key must not be empty"],
      ["store", "fact key must not be empty"],
      ["store", "threadId must not be empty"],
      ["store", "threadId must not be empty"],
      ["store", "threadId must not be empty"],
      ["store", "threadId must not be empty"],
      ["store", "threadId must not be empty"],
      ["store", "note id must not be empty"],
      ["store", "note id must not be empty"],
      ["store", "supersederId must not be empty"],
      ["store", "targetId must not be empty"]
    ])
    expect(failures[0]?.cause).toBeDefined()
    expect(failures[1]?.cause).toBeUndefined()
  })

  it("refuses a value, provenance, or metadata JSON cannot represent", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const unserializable = { runId: 1n as unknown as string }
      return [
        yield* Effect.flip(store.putFact({ namespace, key: "absent", value: undefined, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "big", value: 1n, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "k", value: 1, provenance: unserializable })),
        yield* Effect.flip(store.putNote({ namespace, id: "n", text: "t", tags: [], provenance: unserializable })),
        yield* Effect.flip(store.createThread({ namespace, metadata: 1n }))
      ]
    }))

    expect(failures.map((error) => [error.code, error.message])).toEqual([
      ["store", "fact value is not JSON-serializable"],
      ["store", "fact value is not JSON-serializable"],
      ["store", "fact provenance is not JSON-serializable"],
      ["store", "note provenance is not JSON-serializable"],
      ["store", "thread metadata is not JSON-serializable"]
    ])
  })

  it("reads, isolates, expires, and deletes facts at their boundaries", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const missing = yield* store.getFact({ namespace, key: "absent" })
      const notDeleted = yield* store.deleteFact({ namespace, key: "absent" })
      const emptyNamespace = yield* store.listFacts({ namespace })
      yield* store.putFact({ namespace, key: "instant", value: "gone", ttlMs: 0, provenance: {} })
      const immediatelyExpired = yield* store.getFact({ namespace, key: "instant" })
      yield* store.putFact({ namespace, key: "alpha", value: "a", provenance: {} })
      yield* store.putFact({ namespace, key: "beta", value: "b", provenance: {} })
      yield* store.putFact({ namespace: other, key: "alpha", value: "isolated", provenance: {} })
      const emptyPrefix = yield* store.listFacts({ namespace, prefix: "" })
      const unmatchedPrefix = yield* store.listFacts({ namespace, prefix: "zzz" })
      const isolated = yield* store.getFact({ namespace: other, key: "alpha" })
      const all = yield* store.listAllFacts()
      const deleted = yield* store.deleteFact({ namespace, key: "alpha" })
      const afterDelete = yield* store.listFacts({ namespace })
      return {
        missing,
        notDeleted,
        emptyNamespace,
        immediatelyExpired,
        emptyPrefix,
        unmatchedPrefix,
        isolated,
        all,
        deleted,
        afterDelete
      }
    }))

    expect(result.missing).toBeUndefined()
    expect(result.notDeleted).toBe(false)
    expect(result.emptyNamespace).toEqual([])
    expect(result.immediatelyExpired).toBeUndefined()
    expect(result.emptyPrefix.map((fact) => fact.key)).toEqual(["alpha", "beta"])
    expect(result.unmatchedPrefix).toEqual([])
    expect(result.isolated?.value).toBe("isolated")
    expect(result.all.map((fact) => [fact.namespace.id, fact.key])).toEqual([
      ["project-1", "alpha"],
      ["project-1", "beta"],
      ["project-2", "alpha"]
    ])
    expect(result.deleted).toBe(true)
    expect(result.afterDelete.map((fact) => fact.key)).toEqual(["beta"])
  })

  it("creates a thread with a generated id and omits absent optional columns", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const bare = yield* store.createThread({ namespace })
      const fetched = yield* store.getThread(bare.id)
      const duplicate = yield* Effect.flip(store.createThread({ id: bare.id, namespace: other, title: "ignored" }))
      const all = yield* store.listThreads()
      const scoped = yield* store.listThreads({ namespace: other })
      const ids = yield* store.listThreadIds
      const missing = yield* store.deleteThread("absent")
      return { bare, fetched, duplicate, all, scoped, ids, missing }
    }))

    expect(result.bare.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.bare).not.toHaveProperty("title")
    expect(result.bare).not.toHaveProperty("metadata")
    expect(result.fetched).toEqual(result.bare)
    expect(result.duplicate).toMatchObject({
      code: "store",
      message: expect.stringContaining("different creation data")
    })
    expect(result.all).toEqual([result.bare])
    expect(result.scoped).toEqual([])
    expect(result.ids).toEqual([result.bare.id])
    expect(result.missing).toBe(false)
  })

  it("counts, de-duplicates, chunks, and compacts messages at their boundaries", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const emptyCount = yield* store.countMessages({ threadId: "absent" })
      const noIds = yield* store.deleteMessages({ threadId: "thread", ids: [] })
      yield* store.appendMessage({ threadId: "thread", id: "m-0", role: "user", text: "a", at: 0 })
      yield* store.appendMessage({ threadId: "thread", id: "m-899", role: "user", text: "b", at: 1 })
      yield* store.appendMessage({ threadId: "thread", id: "m-900", role: "user", text: "c", at: 2 })
      const duplicates = yield* store.deleteMessages({ threadId: "thread", ids: ["m-0", "m-0"] })
      const chunked = yield* store.deleteMessages({
        threadId: "thread",
        ids: Array.from({ length: 901 }, (_, index) => `m-${index}`)
      })
      const mismatched = yield* Effect.flip(store.compactMessages({
        threadId: "thread",
        summary: { threadId: "other", id: "summary", role: "system", text: "s", at: 0 },
        deleteIds: []
      }))
      const summaryOnly = yield* store.compactMessages({
        threadId: "thread",
        summary: { threadId: "thread", id: "summary", role: "system", text: "s", at: 0 },
        deleteIds: ["summary"]
      })
      const unknownThread = yield* Effect.flip(store.compactMessages({
        threadId: "ghost",
        summary: { threadId: "ghost", id: "ghost-summary", role: "system", text: "s", at: 0 },
        deleteIds: ["ghost-message"]
      }))
      const remaining = yield* store.countMessages({ threadId: "thread" })
      return { emptyCount, noIds, duplicates, chunked, mismatched, summaryOnly, unknownThread, remaining }
    }))

    expect(result.emptyCount).toBe(0)
    expect(result.noIds).toBe(0)
    expect(result.duplicates).toBe(1)
    expect(result.chunked).toBe(2)
    expect([result.mismatched.code, result.mismatched.message]).toEqual([
      "store",
      "summary threadId must match the compacted thread"
    ])
    expect(result.summaryOnly).toBe(0)
    expect([result.unknownThread.code, result.unknownThread.message]).toEqual([
      "store",
      "could not compact memory history"
    ])
    expect(result.remaining).toBe(0)
  })

  it("rejects self-supersession and reports missing notes", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const onInsert = yield* Effect.flip(
        store.putNote({ namespace, id: "self", text: "t", tags: [], provenance: {}, supersedes: ["self"] })
      )
      const onEdge = yield* Effect.flip(store.supersede({ supersederId: "same", targetId: "same" }))
      const absent = yield* store.getNote({ id: "absent" })
      const unknownStatus = yield* Effect.flip(store.setNoteStatus({ id: "absent", status: "accepted" }))
      return { onInsert, onEdge, absent, unknownStatus }
    }))

    expect([result.onInsert.code, result.onInsert.message]).toEqual([
      "supersede_conflict",
      "a note cannot supersede itself"
    ])
    expect([result.onEdge.code, result.onEdge.message]).toEqual([
      "supersede_conflict",
      "a note cannot supersede itself"
    ])
    expect(result.absent).toBeUndefined()
    expect([result.unknownStatus.code, result.unknownStatus.message]).toEqual([
      "not_found",
      "memory note \"absent\" was not found"
    ])
  })

  it("selects notes by a status list, a single tag group, and a group list", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({ namespace, id: "accepted", text: "a", tags: ["scope:project"], provenance: {} })
      yield* store.putNote({
        namespace,
        id: "pending",
        text: "p",
        tags: ["scope:project", "branch:main"],
        provenance: {},
        status: "pending"
      })
      yield* store.putNote({ namespace, id: "rejected", text: "r", tags: [], provenance: {}, status: "rejected" })
      const byDefault = yield* store.listNotes({ namespace })
      const byList = yield* store.listNotes({ namespace, status: ["pending", "rejected"] })
      const byGroup = yield* store.listNotes({
        namespace,
        status: "any",
        tagGroup: { tags: ["branch:main"], match: "all_strict" }
      })
      const byGroups = yield* store.listNotes({
        namespace,
        status: "any",
        tagGroups: [
          { tags: ["scope:project"], match: "all_strict" },
          { not: { tags: ["branch:main"], match: "any_strict" } }
        ]
      })
      const byBank = yield* store.listNotes({ namespace: "project-1" })
      return { byDefault, byList, byGroup, byGroups, byBank }
    }))

    expect(result.byDefault.map((note) => note.id)).toEqual(["accepted"])
    expect(result.byList.map((note) => note.id)).toEqual(["pending", "rejected"])
    expect(result.byGroup.map((note) => note.id)).toEqual(["pending"])
    expect(result.byGroups.map((note) => note.id)).toEqual(["accepted"])
    expect(result.byBank.map((note) => note.id)).toEqual(["accepted"])
  })

  it("resolves a bank name to a namespace and rejects an empty bank", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({
        namespace: { kind: "agent", id: "fleet" },
        id: "agent-note",
        text: "a",
        tags: [],
        provenance: {}
      })
      yield* store.putNote({ namespace: { kind: "flow", id: "flow-" }, id: "odd", text: "o", tags: [], provenance: {} })
      yield* store.putNote({
        namespace: { kind: "flow", id: "plain" },
        id: "plain-note",
        text: "p",
        tags: [],
        provenance: {}
      })
      const prefixed = yield* store.searchRows({ namespace: "agent-fleet" })
      const boundary = yield* store.searchRows({ namespace: "flow-" })
      const unprefixed = yield* store.searchRows({ namespace: "plain" })
      const structured = yield* store.searchRows({ namespace: { kind: "agent", id: "fleet" } })
      const empty = yield* Effect.flip(store.searchRows({ namespace: "" }))
      return { prefixed, boundary, unprefixed, structured, empty }
    }))

    expect(result.prefixed.map((row) => [row.bank, row.key])).toEqual([["agent-fleet", "agent-note"]])
    expect(result.boundary.map((row) => [row.bank, row.key])).toEqual([["flow-", "odd"]])
    expect(result.unprefixed.map((row) => [row.bank, row.key])).toEqual([["plain", "plain-note"]])
    expect(result.structured.map((row) => row.bank)).toEqual(["agent-fleet"])
    expect([result.empty.code, result.empty.message]).toEqual(["invalid_namespace", "memory bank must not be empty"])
  })

  it("orders, tags, and limits authoritative raw rows", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "plain", value: "a bare string", provenance: {} })
      yield* store.putFact({
        namespace,
        key: "tagged",
        value: { content: "structured", tags: ["scope:project", 7] },
        provenance: {}
      })
      const all = yield* store.searchRows({ namespace })
      const none = yield* store.searchRows({ namespace, limit: 0 })
      const one = yield* store.searchRows({ namespace, limit: 1 })
      const generous = yield* store.searchRows({ namespace, limit: 99 })
      const single = yield* store.searchRows({
        namespace,
        tagGroup: { tags: ["scope:project"], match: "all_strict" }
      })
      const negative = yield* Effect.flip(store.searchRows({ namespace, limit: -1 }))
      const fractional = yield* Effect.flip(store.searchRows({ namespace, limit: 1.5 }))
      return { all, none, one, generous, single, negative, fractional }
    }))

    expect(result.all.map((row) => [row.key, row.text, row.tags])).toEqual([
      ["plain", "a bare string", []],
      ["tagged", "structured", ["scope:project"]]
    ])
    expect(result.none).toEqual([])
    expect(result.one.map((row) => row.key)).toEqual(["plain"])
    expect(result.generous).toHaveLength(2)
    expect(result.single.map((row) => row.key)).toEqual(["tagged"])
    expect([result.negative.message, result.fractional.message]).toEqual([
      "searchRows limit must be a non-negative safe integer",
      "searchRows limit must be a non-negative safe integer"
    ])
  })

  it("enables FTS per namespace kind and applies query, limit, and filter boundaries", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const badKind = yield* Effect.flip(store.enableFts("run" as MemoryStore.EnableFtsInput))
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: { content: "durable checkout recovery", tags: ["scope:project"] },
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "durable-note",
        text: "durable release checklist",
        tags: ["scope:project"],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "durable-extra",
        text: "durable rollback drill",
        tags: ["scope:project"],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "durable-pending",
        text: "durable draft",
        tags: ["scope:project"],
        provenance: {},
        status: "pending"
      })
      yield* store.enableFts("flow")
      yield* store.enableFts("flow")
      const blank = yield* store.searchFts({ namespace, query: "   " })
      const surrogate = yield* store.searchFts({ namespace, query: "\uD800durable" })
      const zeroLimit = yield* store.searchFts({ namespace, query: "durable", limit: 0 })
      const negativeLimit = yield* Effect.flip(store.searchFts({ namespace, query: "durable", limit: -1 }))
      const fractionalLimit = yield* Effect.flip(store.searchFts({ namespace, query: "durable", limit: 0.5 }))
      const defaulted = yield* store.searchFts({ namespace, query: "durable" })
      const truncated = yield* store.searchFts({ namespace, query: "durable", limit: 2, status: "any" })
      const filtered = yield* store.searchFts({
        namespace,
        query: "durable",
        limit: 10,
        status: "any",
        includeSuperseded: true,
        tagGroup: { tags: ["scope:project"], match: "all_strict" },
        tagGroups: [{ not: { tags: ["scope:secret"], match: "any_strict" } }]
      })
      yield* store.deleteFact({ namespace, key: "runbook" })
      const afterDelete = yield* store.searchFts({ namespace, query: "durable", limit: 10 })
      const otherKind = yield* Effect.flip(
        store.searchFts({ namespace: { kind: "agent", id: "fleet" }, query: "durable" })
      )
      return {
        badKind,
        blank,
        surrogate,
        zeroLimit,
        negativeLimit,
        fractionalLimit,
        defaulted,
        truncated,
        filtered,
        afterDelete,
        otherKind
      }
    }))

    expect([result.badKind.code, result.badKind.message]).toEqual([
      "invalid_namespace",
      "FTS namespace kind is invalid"
    ])
    expect(result.blank).toEqual([])
    expect(result.surrogate.map((row) => row.key).sort()).toEqual(["durable-extra", "durable-note", "runbook"])
    expect(result.zeroLimit).toEqual([])
    expect([result.negativeLimit.message, result.fractionalLimit.message]).toEqual([
      "searchFts limit must be a non-negative safe integer",
      "searchFts limit must be a non-negative safe integer"
    ])
    expect(result.defaulted.map((row) => row.key).sort()).toEqual(["durable-extra", "durable-note", "runbook"])
    expect(result.truncated).toHaveLength(2)
    expect(result.filtered.map((row) => row.key).sort()).toEqual([
      "durable-extra",
      "durable-note",
      "durable-pending",
      "runbook"
    ])
    expect(result.afterDelete.map((row) => row.key).sort()).toEqual(["durable-extra", "durable-note"])
    expect(result.otherKind.code).toBe("fts_not_enabled")
  })

  it("fails every operation on the unavailable store and honours overrides", async () => {
    const noop = MemoryStore.makeNoop()
    const calls: ReadonlyArray<readonly [string, Effect.Effect<unknown, MemoryError>]> = [
      ["putFact", noop.putFact({ namespace, key: "k", value: 1, provenance: {} })],
      ["getFact", noop.getFact({ namespace, key: "k" })],
      ["deleteFact", noop.deleteFact({ namespace, key: "k" })],
      ["listFacts", noop.listFacts({ namespace })],
      ["listAllFacts", noop.listAllFacts()],
      ["createThread", noop.createThread({ namespace })],
      ["getThread", noop.getThread("t")],
      ["listThreads", noop.listThreads()],
      ["deleteThread", noop.deleteThread("t")],
      ["appendMessage", noop.appendMessage({ threadId: "t", id: "m", role: "user", text: "x", at: 0 })],
      ["listMessages", noop.listMessages({ threadId: "t" })],
      ["countMessages", noop.countMessages({ threadId: "t" })],
      ["putNote", noop.putNote({ namespace, id: "n", text: "t", tags: [], provenance: {} })],
      ["getNote", noop.getNote({ id: "n" })],
      ["setNoteStatus", noop.setNoteStatus({ id: "n", status: "accepted" })],
      ["supersede", noop.supersede({ supersederId: "s", targetId: "t" })],
      ["listNotes", noop.listNotes({ namespace })],
      ["enableFts", noop.enableFts("flow")],
      ["searchFts", noop.searchFts({ namespace, query: "q" })],
      ["searchRows", noop.searchRows({ namespace })],
      ["deleteExpiredFacts", noop.deleteExpiredFacts],
      ["listThreadIds", noop.listThreadIds],
      ["deleteMessages", noop.deleteMessages({ threadId: "t", ids: ["m"] })],
      [
        "compactMessages",
        noop.compactMessages({
          threadId: "t",
          summary: { threadId: "t", id: "s", role: "system", text: "x", at: 0 },
          deleteIds: ["m"]
        })
      ]
    ]
    const overridden = MemoryStore.makeNoop({
      getFact: () => Effect.succeed(undefined),
      listThreadIds: Effect.succeed(["kept"])
    })

    const messages = await Effect.runPromise(
      Effect.forEach(calls, ([name, effect]) => Effect.map(Effect.flip(effect), (error) => `${name}: ${error.message}`))
    )
    const kept = await Effect.runPromise(
      Effect.all([overridden.getFact({ namespace, key: "k" }), overridden.listThreadIds])
    )
    const stillUnavailable = await Effect.runPromise(
      Effect.flip(overridden.putFact({ namespace, key: "k", value: 1, provenance: {} }))
    )
    const layered = await Effect.runPromise(
      Effect.service(MemoryStore.MemoryStore).pipe(
        Effect.flatMap((store) => Effect.flip(store.listAllFacts())),
        Effect.provide(MemoryStore.layerNoop())
      )
    )
    const layeredOverride = await Effect.runPromise(
      Effect.service(MemoryStore.MemoryStore).pipe(
        Effect.flatMap((store) => store.listAllFacts()),
        Effect.provide(MemoryStore.layerNoop({ listAllFacts: () => Effect.succeed([]) }))
      )
    )

    expect(messages).toEqual(calls.map(([name]) => `${name}: ${name} is unavailable`))
    expect(kept).toEqual([undefined, ["kept"]])
    expect(stillUnavailable.message).toBe("putFact is unavailable")
    expect(layered.message).toBe("listAllFacts is unavailable")
    expect(layeredOverride).toEqual([])
  })

  it("surfaces a typed store error when an authoritative table is gone", async () => {
    const failure = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`DROP TABLE memory_facts`
      return yield* Effect.flip(store.listFacts({ namespace }))
    }))

    expect([failure.code, failure.message]).toEqual(["store", "could not list memory facts"])
    expect(failure.cause).toBeDefined()
  })

  it("keeps an authoritative write when the advisory vector projection fails", async () => {
    const stored = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`DROP TABLE memory_vectors`
      yield* store.putFact({ namespace, key: "durable", value: "written", provenance: {} })
      return yield* store.getFact({ namespace, key: "durable" })
    }))

    expect(stored?.value).toBe("written")
  })

  it("reports a stored row it cannot decode as a typed memory error", async () => {
    const failures = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES ('flow', 'scalar', 'k', '1', NULL, '5', 0, 0)`
      const scalarProvenance = yield* Effect.flip(store.listFacts({ namespace: { kind: "flow", id: "scalar" } }))
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES ('flow', 'null-provenance', 'k', '1', NULL, 'null', 0, 0)`
      const nullProvenance = yield* Effect.flip(
        store.listFacts({ namespace: { kind: "flow", id: "null-provenance" } })
      )
      yield* sql`INSERT INTO memory_notes (
        id, namespace_kind, namespace_id, text, tags_json, provenance_json, status, created_at_ms
      ) VALUES ('bad-tags', 'flow', 'notes', 'text', '["vendor:x"]', '{}', 'accepted', 0)`
      const storedTags = yield* Effect.flip(store.getNote({ id: "bad-tags" }))
      yield* sql`PRAGMA ignore_check_constraints = ON`
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES ('flow', 'invalid-json', 'k', '{oops', NULL, '{}', 0, 0)`
      const invalidJson = yield* Effect.flip(store.listFacts({ namespace: { kind: "flow", id: "invalid-json" } }))
      yield* sql`INSERT INTO memory_threads (
        thread_id, namespace_kind, namespace_id, title, metadata_json, created_at_ms, updated_at_ms
      ) VALUES ('bad-thread', 'flow', 'threads', NULL, '{oops', 0, 0)`
      const invalidMetadata = yield* Effect.flip(store.getThread("bad-thread"))
      return [scalarProvenance, nullProvenance, storedTags, invalidJson, invalidMetadata]
    }))

    expect(failures.map((error) => [error.code, error.message])).toEqual([
      ["store", "stored provenance is not an object"],
      ["store", "stored provenance is not an object"],
      ["invalid_tag", "stored tags violate the memory vocabulary"],
      ["store", "could not decode fact value"],
      ["store", "could not decode thread metadata"]
    ])
  })
})
