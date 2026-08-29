import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { APP_SCHEMA_VERSION, SCHEMA_VERSION_STORAGE_KEY } from "../chain/SchemaVersion"
import { ENVELOPE_STORAGE_KEY } from "../chain/TransactionalStorage"
import type { ChainEventRecord, ToolCallRecord, TransitionRecord } from "./AppState"
import { createAppStore, MAX_CHAIN_EVENT_RECORDS, MAX_TOOL_CALL_RECORDS, MAX_TRANSITION_RECORDS } from "./AppStore"

/*
 * Ruling A, store level (docs/persistence.md): a dispatch is one atomic
 * commit — every projection changes or none does — and the log collections
 * compact to their documented retention bounds inside the committing
 * transaction.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/** A host whose envelope commit write can be made to crash mid-dispatch. */
const crashableStorage = (): StorageApi & { crashCommit: () => void; heal: () => void } => {
  const inner = memoryStorage()
  let armed = false
  return {
    crashCommit: () => {
      armed = true
    },
    heal: () => {
      armed = false
    },
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      if (armed && key === ENVELOPE_STORAGE_KEY) throw new Error("crash at the commit point")
      inner.setItem(key, value)
    },
    removeItem: (key) => inner.removeItem(key)
  }
}

describe("an atomic commit point per logical transition", () => {
  test("a dispatch commits every projection or none", async () => {
    const host = crashableStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const transitionsBefore = store.collections.transitions.size
    const draftBefore = store.session().draft

    host.crashCommit()
    await expect(
      store.dispatch({ type: "composer.changed", actor: "user", draft: "half-written" }).isPersisted
        .promise
    ).rejects.toThrow()
    host.heal()

    // Reopening recovers by rolling the interrupted commit back: neither
    // the session projection (the draft) nor the transition record survived.
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe(draftBefore)
    expect(reopened.collections.transitions.size).toBe(transitionsBefore)
  })

  test("a dispatch whose commit lands persists every projection", async () => {
    const host = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "kept" }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe("kept")
    expect(
      [...reopened.collections.transitions.values()].some((record) => record.type === "composer.changed")
    ).toBe(true)
  })
})

describe("retention bounds", () => {
  test("transitions compact to the newest 500 inside the appending transaction", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const seeded: TransitionRecord[] = Array.from({ length: MAX_TRANSITION_RECORDS + 10 }, (_, index) => ({
      id: `transition-seed-${index}`,
      revision: index + 1,
      actor: "user",
      type: "composer.changed",
      payload: "{}",
      createdAt: index + 1
    }))
    await store.collections.transitions.insert(seeded).isPersisted.promise
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "x" }).isPersisted.promise
    const remaining = [...store.collections.transitions.values()]
    expect(remaining.length).toBe(MAX_TRANSITION_RECORDS)
    expect(remaining.some((record) => record.id === "transition-seed-0")).toBe(false)
    expect(remaining.some((record) => record.id === `transition-seed-${MAX_TRANSITION_RECORDS + 9}`)).toBe(true)
  })

  test("tool-call records compact to the newest 250", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const seeded: ToolCallRecord[] = Array.from({ length: MAX_TOOL_CALL_RECORDS + 5 }, (_, index) => ({
      id: `toolcall-seed-${index}`,
      turnId: "turn",
      name: "tool",
      arguments: "{}",
      result: "ok",
      createdAt: index + 1
    }))
    await store.collections.toolCalls.insert(seeded).isPersisted.promise
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "x" }).isPersisted.promise
    const remaining = [...store.collections.toolCalls.values()]
    expect(remaining.length).toBe(MAX_TOOL_CALL_RECORDS)
    expect(remaining.some((record) => record.id === "toolcall-seed-0")).toBe(false)
    expect(remaining.some((record) => record.id === `toolcall-seed-${MAX_TOOL_CALL_RECORDS + 4}`)).toBe(true)
  })

  test("chain-event records compact to the newest 1000", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const seeded: ChainEventRecord[] = Array.from({ length: MAX_CHAIN_EVENT_RECORDS + 5 }, (_, index) => ({
      id: `chain-seed-${index}`,
      lineageId: "lineage",
      seq: index,
      event: { kind: "tick" },
      createdAt: index + 1
    }))
    await store.collections.chainEvents.insert(seeded).isPersisted.promise
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "x" }).isPersisted.promise
    const remaining = [...store.collections.chainEvents.values()]
    expect(remaining.length).toBe(MAX_CHAIN_EVENT_RECORDS)
    expect(remaining.some((record) => record.id === "chain-seed-0")).toBe(false)
    expect(remaining.some((record) => record.id === `chain-seed-${MAX_CHAIN_EVENT_RECORDS + 4}`)).toBe(true)
  })
})

describe("adoption of pre-envelope rows", () => {
  test("a legacy message row is adopted into a reopened store only after schema decode", async () => {
    const host = memoryStorage()
    // A store written before the envelope existed: the app-level version
    // stamp matches, and the collection key holds TanStack's row map.
    host.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION))
    host.setItem(
      "smithers-mvp.app-messages",
      JSON.stringify({
        m1: {
          versionKey: "v1",
          data: {
            id: "m1",
            role: "user",
            text: "from before the envelope",
            status: "complete",
            createdAt: 1,
            ordinal: 0
          }
        },
        m2: { versionKey: "v2", data: { id: "m2", role: "user", text: 42 } }
      })
    )
    const store = await createAppStore({ kind: "localStorage", storage: host })
    expect(store.collections.messages.get("m1")?.text).toBe("from before the envelope")
    // The row that fails decode was quarantined, not adopted blind.
    expect(store.collections.messages.get("m2")).toBe(undefined)
    expect(host.getItem("smithers-mvp-quarantine.row.app-messages.m2")).not.toBe(null)
  })
})
