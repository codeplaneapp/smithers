import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { createAppStore } from "../state/AppStore"
import {
  APP_SCHEMA_VERSION,
  enforceSchemaVersion,
  PERSISTED_COLLECTION_IDS,
  PERSISTED_KEY_PREFIX,
  persistedStorageKeys,
  PERSISTENCE_BACKEND_STORAGE_KEY,
  readRecordedBackend,
  recordBackend,
  SCHEMA_QUARANTINE_PREFIX,
  SCHEMA_VERSION_STORAGE_KEY
} from "./SchemaVersion"

/** Each case gets its own storage so no case observes another case's writes. */
const memoryStorage = (): StorageApi & { readonly data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/** A storage that also enumerates, the way a real window.localStorage does. */
const enumerableStorage = (): StorageApi & { readonly data: Map<string, string> } => {
  const base = memoryStorage()
  // defineProperty, not Object.assign: assign would copy the getter's value
  // once and freeze length at 0.
  Object.defineProperty(base, "length", { get: () => base.data.size })
  Object.defineProperty(base, "key", {
    value: (index: number) => [...base.data.keys()][index] ?? null
  })
  return base
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/*
 * The persisted envelope TanStack's localStorage collection writes:
 * {"<key>": {versionKey, data}}. Writing one by hand is how a store left by an
 * older build is reproduced without shipping an old build.
 */
const legacyRow = (key: string, row: Record<string, unknown>): string =>
  JSON.stringify({ [key]: { versionKey: "legacy", data: row } })

describe("the persisted collection inventory the gate clears", () => {
  /*
   * The gate clears a declared list, so a collection added to AppStore and not
   * declared here would keep its rows across a bump — exactly the silent
   * survival E14.2 exists to stop. Compare against the ids a real store
   * exposes, not against a copy of the list.
   */
  test("covers every collection a real store exposes", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const liveIds = Object.values(store.collections)
      .map((collection) => collection.id)
      .sort()
    expect([...PERSISTED_COLLECTION_IDS].sort()).toEqual(liveIds)
  })

  /*
   * Everything a real boot writes is either a declared collection key or one
   * of the two bookkeeping stamps. A key that is neither would be data the
   * gate cannot reach, which is what leaves an old shape behind after a bump.
   */
  test("uses the storage key template a real store writes under", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "probe" })
      .isPersisted.promise
    const written = [...storage.data.keys()]
    expect(written.length).toBeGreaterThan(0)
    const declared = new Set([
      ...persistedStorageKeys(),
      SCHEMA_VERSION_STORAGE_KEY,
      PERSISTENCE_BACKEND_STORAGE_KEY
    ])
    for (const key of written) {
      expect(key.startsWith(PERSISTED_KEY_PREFIX)).toBe(true)
      expect(declared.has(key)).toBe(true)
    }
    // The gate ran on the path the app actually takes, rather than beside it.
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(String(APP_SCHEMA_VERSION))
  })
})

describe("enforceSchemaVersion", () => {
  test("stamps a fresh store and then matches it", () => {
    const storage = memoryStorage()
    const first = enforceSchemaVersion(storage)
    expect(first.action).toBe("adopt")
    expect(first.from).toBe(null)
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(String(APP_SCHEMA_VERSION))
    const second = enforceSchemaVersion(storage)
    expect(second.action).toBe("match")
    expect(second.clearedKeys).toEqual([])
  })

  /*
   * The upgrade path, and the reason `adopt` exists. Every store written
   * before this gate shipped carries no stamp. Clearing it would wipe the
   * conversation of every existing user on their first boot after the
   * upgrade — the silent whole-store loss the backend stamp exists to
   * prevent, reintroduced by the version half.
   *
   * This caught a real regression: the gate's first form cleared unstamped
   * stores, which failed the connectors e2e suite because its seeded rows
   * were wiped before the collections loaded.
   */
  test("adopts an unstamped store instead of wiping a pre-gate user's data", () => {
    const storage = memoryStorage()
    for (const key of persistedStorageKeys()) storage.setItem(key, "{\"rows\":\"real user data\"}")
    const outcome = enforceSchemaVersion(storage)
    expect(outcome.action).toBe("adopt")
    expect(outcome.from).toBe(null)
    expect(outcome.clearedKeys).toEqual([])
    for (const key of persistedStorageKeys()) {
      expect(storage.getItem(key)).toBe("{\"rows\":\"real user data\"}")
    }
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(String(APP_SCHEMA_VERSION))
    // Adopted once: the next boot is an ordinary match, not a second adopt.
    expect(enforceSchemaVersion(storage).action).toBe("match")
  })

  test("clears every declared collection key on a bump", () => {
    const storage = memoryStorage()
    for (const key of persistedStorageKeys()) storage.setItem(key, "{}")
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION))
    const outcome = enforceSchemaVersion(storage, { version: APP_SCHEMA_VERSION + 1 })
    expect(outcome.action).toBe("reset")
    expect(outcome.from).toBe(String(APP_SCHEMA_VERSION))
    expect([...outcome.clearedKeys]).toEqual([...persistedStorageKeys()].sort())
    for (const key of persistedStorageKeys()) expect(storage.getItem(key)).toBe(null)
    expect(outcome.quarantinedKeys).toHaveLength(persistedStorageKeys().length)
    for (const key of outcome.quarantinedKeys) {
      expect(key.startsWith(SCHEMA_QUARANTINE_PREFIX)).toBe(true)
      expect(storage.getItem(key)).toBe("{}")
    }
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(String(APP_SCHEMA_VERSION + 1))
  })

  test("leaves a matching store untouched", () => {
    const storage = memoryStorage()
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION))
    storage.setItem(`${PERSISTED_KEY_PREFIX}app-sessions`, "{}")
    const outcome = enforceSchemaVersion(storage)
    expect(outcome.action).toBe("match")
    expect(storage.getItem(`${PERSISTED_KEY_PREFIX}app-sessions`)).toBe("{}")
  })

  test("does not touch keys outside the store's namespace", () => {
    const storage = enumerableStorage()
    storage.setItem("unrelated-app.state", "keep me")
    enforceSchemaVersion(storage, { version: APP_SCHEMA_VERSION + 1 })
    expect(storage.getItem("unrelated-app.state")).toBe("keep me")
  })

  /*
   * An enumerating storage reaches keys the declared list has forgotten: a
   * collection removed in an earlier release still has rows in an alpha
   * user's browser, and leaving them there leaks the old shape forward.
   */
  test("an enumerating storage also clears a retired collection's key", () => {
    const storage = enumerableStorage()
    storage.setItem(`${PERSISTED_KEY_PREFIX}app-retired-collection`, "{}")
    // A genuine bump, so the stamp must be present: an unstamped store is
    // adopted rather than cleared, and would clear nothing to enumerate.
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION))
    const outcome = enforceSchemaVersion(storage, { version: APP_SCHEMA_VERSION + 1 })
    expect(outcome.clearedKeys).toContain(`${PERSISTED_KEY_PREFIX}app-retired-collection`)
    expect(storage.getItem(`${PERSISTED_KEY_PREFIX}app-retired-collection`)).toBe(null)
  })
})

describe("a real store across a schema version bump", () => {
  /*
   * The defect E14.2 names. TanStack's localStorage loader parses the
   * {versionKey, data} envelope and never runs the collection schema, so a row
   * whose shape no longer exists enters the live collection. Every case here
   * goes through `createAppStore`, because the gate is only real if it runs on
   * the path the app actually takes: an older build's store is reproduced by
   * writing its bytes and its stamp, never by calling the gate by hand.
   */
  /*
   * A boot over an UNSTAMPED store keeps its rows. This test asserted the
   * opposite until the whole-suite gate proved that behaviour was a
   * data-loss defect: every store written before this gate shipped carries
   * no stamp, so clearing on a missing stamp wipes the conversation of every
   * existing user on their first boot after the upgrade. It also broke the
   * connectors e2e suite, whose seeded rows were wiped before the
   * collections loaded.
   *
   * The mismatch case below is what actually protects against an
   * incompatible shape, and it is unchanged. A wedged collection from an
   * adopted row is recoverable with /clear; a wiped conversation is not.
   */
  test("a boot adopts rows written before the gate existed", async () => {
    const storage = memoryStorage()
    storage.setItem(
      `${PERSISTED_KEY_PREFIX}app-messages`,
      legacyRow("kept-message", {
        id: "kept-message",
        role: "user",
        text: "written before the gate existed",
        status: "complete",
        createdAt: 1,
        ordinal: 1
      })
    )
    const store = await createAppStore({ kind: "localStorage", storage })
    expect(store.collections.messages.get("kept-message")?.text).toBe(
      "written before the gate existed"
    )
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(String(APP_SCHEMA_VERSION))
  })

  test("a boot over an older stamp keeps that row out and reseeds clean", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await first.dispatch({ type: "composer.changed", actor: "user", draft: "written before the bump" })
      .isPersisted.promise
    storage.setItem(
      `${PERSISTED_KEY_PREFIX}app-cards`,
      legacyRow("legacy-card", { id: "legacy-card", kind: "kind-that-no-longer-exists" })
    )
    // The store as an older build left it: its rows, under its version.
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION - 1))

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.collections.cards.get("legacy-card")).toBeUndefined()
    expect(second.collections.cards.size).toBe(0)
    expect(second.session().draft).toBe("")
    expect(second.session().id).toBe("main")
    expect(second.collections.worldDocuments.size).toBeGreaterThan(0)
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(String(APP_SCHEMA_VERSION))
  })

  test("the reseeded store still dispatches and persists", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await first.dispatch({ type: "composer.changed", actor: "user", draft: "before" })
      .isPersisted.promise
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION - 1))

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().draft).toBe("")
    await second.dispatch({ type: "composer.changed", actor: "user", draft: "after" })
      .isPersisted.promise
    await settled()

    const third = await createAppStore({ kind: "localStorage", storage })
    expect(third.session().draft).toBe("after")
  })

  /*
   * The other half of the contract, and the one a too-eager gate breaks: an
   * ordinary reopen resets nothing. Without this, "clear on every boot" would
   * pass every case above and lose every conversation.
   */
  test("an ordinary reopen preserves what a real store persisted", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await first.dispatch({ type: "composer.changed", actor: "user", draft: "durable draft" })
      .isPersisted.promise

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().draft).toBe("durable draft")
  })

  /*
   * The reset clears the data and keeps the stamps. Clearing the backend stamp
   * would send the next launch to whichever store it opened first, which is
   * the E3.6 loss: the app reads an empty database while the conversation sits
   * in the other one.
   */
  test("a reset keeps the stamp that says which backend holds the store", async () => {
    const storage = memoryStorage()
    recordBackend(storage, "localStorage")
    storage.setItem(
      `${PERSISTED_KEY_PREFIX}app-cards`,
      legacyRow("legacy-card", { id: "legacy-card", kind: "kind-that-no-longer-exists" })
    )
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION - 1))

    const store = await createAppStore({ kind: "localStorage", storage })
    expect(store.collections.cards.get("legacy-card")).toBeUndefined()
    expect(readRecordedBackend(storage)).toBe("localStorage")
  })
})

describe("the recorded backend", () => {
  test("round-trips, and reads null when no launch has stamped one", () => {
    const storage = memoryStorage()
    expect(readRecordedBackend(storage)).toBe(null)
    recordBackend(storage, "opfs")
    expect(readRecordedBackend(storage)).toBe("opfs")
    recordBackend(storage, "localStorage")
    expect(readRecordedBackend(storage)).toBe("localStorage")
  })

  test("reads null for a stamp that names no backend this build knows", () => {
    const storage = memoryStorage()
    storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "indexeddb")
    expect(readRecordedBackend(storage)).toBe(null)
  })
})
