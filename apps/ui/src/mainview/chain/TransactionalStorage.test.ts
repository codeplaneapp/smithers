import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  ENVELOPE_QUARANTINE_PREFIX,
  ENVELOPE_STORAGE_KEY,
  ENVELOPE_VERSION,
  openTransactionalStorage,
  ROW_QUARANTINE_PREFIX,
  STAGED_ENVELOPE_STORAGE_KEY
} from "./TransactionalStorage"

/*
 * Crash-injection coverage for the write-ahead commit protocol
 * (docs/persistence.md): every stage of stage → commit → clear gets a crash
 * or a kill, and both recovery directions — complete and roll back — are
 * proven from the stages that can produce them.
 */

/** A StorageApi host whose writes can be made to crash at a chosen stage. */
const scriptableHost = () => {
  const data = new Map<string, string>()
  const host: StorageApi & {
    readonly data: Map<string, string>
    crashOnSet: string | undefined
    crashOnRemove: string | undefined
  } = {
    data,
    crashOnSet: undefined,
    crashOnRemove: undefined,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (host.crashOnSet === key) throw new Error(`crash writing ${key}`)
      data.set(key, value)
    },
    removeItem: (key) => {
      if (host.crashOnRemove === key) throw new Error(`crash removing ${key}`)
      data.delete(key)
    }
  }
  return host
}

const WidgetSchema = z.object({ id: z.string(), label: z.string() })
const COLLECTIONS = [{ id: "widgets", schema: WidgetSchema }]

const open = (host: StorageApi) => openTransactionalStorage(host, { collections: COLLECTIONS })

/** The envelope bytes an open store committed, decoded. */
const liveEntries = (host: StorageApi): Record<string, string> => {
  const raw = host.getItem(ENVELOPE_STORAGE_KEY)
  if (raw === null) return {}
  return (JSON.parse(raw) as { entries: Record<string, string> }).entries
}

describe("the write-ahead commit protocol", () => {
  test("a clean commit leaves no staged bytes behind", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem(
      "smithers-mvp.widgets",
      "{\"w1\":{\"versionKey\":\"v\",\"data\":{\"id\":\"w1\",\"label\":\"a\"}}}"
    )
    expect(host.getItem(STAGED_ENVELOPE_STORAGE_KEY)).toBe(null)
    expect(store.recovery).toBe("clean")
    expect(liveEntries(host)["smithers-mvp.widgets"]).toContain("\"label\":\"a\"")
  })

  test("a batch commits every projection or none", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnSet = ENVELOPE_STORAGE_KEY
    await expect(
      store.batch(async () => {
        store.storage.setItem("one", "1")
        store.storage.setItem("two", "2")
        store.storage.setItem("keep", "after")
      })
    ).rejects.toThrow("crash writing smithers-mvp.store")
    // None of the batch's projections reached the host — not even the keys
    // whose own write succeeded before the crash.
    expect(liveEntries(host)).toEqual({ keep: "before" })
  })

  test("a failed commit leaves the live store reading the last committed envelope", async () => {
    /*
     * The mirror the session reads from must never run ahead of the host.
     * When the commit write throws (a quota rejection, a revoked host) the
     * facade used to keep the uncommitted value in memory: the session read
     * a projection the host never took, and the NEXT successful commit
     * wrote it out — exactly the half-applied transition this facade exists
     * to prevent.
     */
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnSet = ENVELOPE_STORAGE_KEY
    expect(() => store.storage.setItem("keep", "after")).toThrow()
    host.crashOnSet = undefined
    expect(store.storage.getItem("keep")).toBe("before")
    // A later, unrelated commit must not smuggle the failed write out.
    store.storage.setItem("other", "x")
    expect(liveEntries(host)).toEqual({ keep: "before", other: "x" })
  })

  test("an aborted batch leaves neither the host nor the live store holding its writes", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnSet = ENVELOPE_STORAGE_KEY
    await expect(
      store.batch(async () => {
        store.storage.setItem("keep", "after")
        store.storage.setItem("extra", "1")
      })
    ).rejects.toThrow("crash writing smithers-mvp.store")
    host.crashOnSet = undefined
    expect(store.storage.getItem("keep")).toBe("before")
    expect(store.storage.getItem("extra")).toBe(null)
    store.storage.setItem("other", "x")
    expect(liveEntries(host)).toEqual({ keep: "before", other: "x" })
  })

  test("a crash during the stage write rolls back: the old envelope stays authoritative", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnSet = STAGED_ENVELOPE_STORAGE_KEY
    expect(() => store.storage.setItem("keep", "after")).toThrow()
    host.crashOnSet = undefined
    const reopened = await open(host)
    expect(reopened.recovery).toBe("clean")
    expect(reopened.storage.getItem("keep")).toBe("before")
  })

  test("a crash at the commit write rolls back: staged bytes are dropped, the old envelope stays", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnSet = ENVELOPE_STORAGE_KEY
    expect(() => store.storage.setItem("keep", "after")).toThrow()
    host.crashOnSet = undefined
    // The stage landed before the crash, so recovery has something to undo.
    expect(host.getItem(STAGED_ENVELOPE_STORAGE_KEY)).not.toBe(null)
    const reopened = await open(host)
    expect(reopened.recovery).toBe("rollback")
    expect(reopened.storage.getItem("keep")).toBe("before")
    expect(host.getItem(STAGED_ENVELOPE_STORAGE_KEY)).toBe(null)
  })

  test("a kill between stage and commit rolls back the interrupted commit", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    // Simulate the kill: the stage holds the next envelope, the commit
    // point never ran, and the process simply never came back to it.
    host.setItem(STAGED_ENVELOPE_STORAGE_KEY, JSON.stringify({ version: ENVELOPE_VERSION, entries: { keep: "after" } }))
    const reopened = await open(host)
    expect(reopened.recovery).toBe("rollback")
    expect(reopened.storage.getItem("keep")).toBe("before")
  })

  test("a crash after the commit write completes the commit: the new envelope stays", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnRemove = STAGED_ENVELOPE_STORAGE_KEY
    expect(() => store.storage.setItem("keep", "after")).toThrow()
    host.crashOnRemove = undefined
    // The commit point ran and only the clear was interrupted.
    const reopened = await open(host)
    expect(reopened.recovery).toBe("complete")
    expect(reopened.storage.getItem("keep")).toBe("after")
    expect(host.getItem(STAGED_ENVELOPE_STORAGE_KEY)).toBe(null)
  })
})

describe("versioned envelopes, migrations, and quarantine", () => {
  test("unstamped legacy rows are schema-decoded before adoption, never adopted blind", async () => {
    const host = scriptableHost()
    // The pre-envelope layout: one host key per collection, TanStack's
    // { encodedKey: { versionKey, data } } map, with one row that satisfies
    // the schema and one that does not.
    host.setItem(
      "smithers-mvp.widgets",
      JSON.stringify({
        w1: { versionKey: "v1", data: { id: "w1", label: "adopted" } },
        w2: { versionKey: "v2", data: { id: "w2", label: 42 } }
      })
    )
    const store = await open(host)
    const adopted = JSON.parse(liveEntries(host)["smithers-mvp.widgets"] ?? "{}") as Record<string, unknown>
    expect(Object.keys(adopted)).toEqual(["w1"])
    expect(store.quarantinedKeys).toEqual([`${ROW_QUARANTINE_PREFIX}widgets.w2`])
    // The quarantined row keeps its raw bytes and is never deleted.
    expect(host.getItem(`${ROW_QUARANTINE_PREFIX}widgets.w2`)).toContain("\"label\":42")
    // The legacy key left the live namespace.
    expect(host.getItem("smithers-mvp.widgets")).toBe(null)
    await open(host)
    expect(host.getItem(`${ROW_QUARANTINE_PREFIX}widgets.w2`)).toContain("\"label\":42")
  })

  test("a legacy collection key whose bytes do not parse is quarantined whole", async () => {
    const host = scriptableHost()
    host.setItem("smithers-mvp.widgets", "{not json")
    const store = await open(host)
    expect(store.quarantinedKeys).toEqual([`${ENVELOPE_QUARANTINE_PREFIX}unparseable.widgets`])
    expect(host.getItem(`${ENVELOPE_QUARANTINE_PREFIX}unparseable.widgets`)).toBe("{not json")
    expect(host.getItem("smithers-mvp.widgets")).toBe(null)
  })

  test("migrations run in order from the stored version to the current one", async () => {
    const host = scriptableHost()
    // A version-0 envelope (envelope entries already present) plus legacy
    // host rows: the 0→1 step must run over the envelope's own entries too.
    host.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify({ version: 0, entries: { earlier: "kept" } }))
    host.setItem(
      "smithers-mvp.widgets",
      JSON.stringify({ w1: { versionKey: "v", data: { id: "w1", label: "migrated" } } })
    )
    const store = await open(host)
    expect(store.storage.getItem("earlier")).toBe("kept")
    expect(store.storage.getItem("smithers-mvp.widgets")).toContain("\"label\":\"migrated\"")
    const raw = host.getItem(ENVELOPE_STORAGE_KEY)
    expect((JSON.parse(raw ?? "{}") as { version: number }).version).toBe(ENVELOPE_VERSION)
  })

  test("an envelope from a future version quarantines and is never deleted", async () => {
    const host = scriptableHost()
    const future = JSON.stringify({ version: ENVELOPE_VERSION + 41, entries: { "new-shape": "data" } })
    host.setItem(ENVELOPE_STORAGE_KEY, future)
    const store = await open(host)
    expect(store.quarantinedKeys).toEqual([`${ENVELOPE_QUARANTINE_PREFIX}future.${ENVELOPE_VERSION + 41}`])
    expect(host.getItem(ENVELOPE_STORAGE_KEY)).not.toBe(future)
    expect(store.storage.getItem("new-shape")).toBe(null)
    // A later boot leaves the quarantine copy in place.
    await open(host)
    expect(host.getItem(`${ENVELOPE_QUARANTINE_PREFIX}future.${ENVELOPE_VERSION + 41}`)).toBe(future)
  })

  test("an unparseable envelope quarantines instead of booting over corrupt bytes", async () => {
    const host = scriptableHost()
    host.setItem(ENVELOPE_STORAGE_KEY, "not an envelope")
    const store = await open(host)
    expect(store.quarantinedKeys).toEqual([`${ENVELOPE_QUARANTINE_PREFIX}corrupt`])
    expect(host.getItem(`${ENVELOPE_QUARANTINE_PREFIX}corrupt`)).toBe("not an envelope")
  })
})
