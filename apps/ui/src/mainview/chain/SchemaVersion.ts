import type { StorageApi } from "@tanstack/db"
import { ENVELOPE_STORAGE_KEY, STAGED_ENVELOPE_STORAGE_KEY } from "./TransactionalStorage"

/*
 * The boot gate for the persisted store: which backend holds it (E3.6) and
 * which shape version it was written under (E14.2).
 *
 * AppStore calls both halves before it constructs a single collection.
 *
 * The version half. The OPFS/wa-sqlite backend already declares a version:
 * AppStore passes `schemaVersion` plus `schemaMismatchPolicy: "reset"` to
 * `persistedCollectionOptions`, so a shape change drops the database and the
 * app reseeds. The localStorage fallback had no equivalent.
 * `localStorageCollectionOptions` takes no version, and TanStack's
 * `loadFromStorage` only JSON.parses each `{versionKey, data}` envelope — it
 * never runs the collection schema. A row written under an older shape
 * therefore enters the live collection unvalidated, and the first update that
 * validates the full row wedges every later dispatch. `enforceSchemaVersion`
 * gives the fallback the same contract: boot stamps the version, and a boot
 * that reads a DIFFERENT stamp clears every persisted collection key. Reset,
 * not migration, matches the OPFS policy, so both backends behave identically
 * on a bump.
 *
 * A store with NO stamp is adopted rather than cleared. See
 * `enforceSchemaVersion` for why: clearing it wipes the conversation of every
 * user who upgrades into this gate, which is the failure the backend half of
 * this module exists to prevent.
 *
 * The backend half. AppStore can persist into either store, and it cannot
 * merge them. A launch that opens the store the previous launch did not write
 * reads an empty database and greets a returning user with a first-run app
 * while their whole transcript sits in the other one. `recordBackend` stamps
 * the store a launch committed to, and `readRecordedBackend` is what the next
 * launch honours.
 *
 * Both stamps live in localStorage, under the same prefix as the data, and
 * neither is ever cleared as data: they describe where the store is and what
 * shape it has, so losing them with a reset would strand the next launch.
 */

/**
 * The shape version of everything AppStore persists. Bump it whenever a
 * persisted schema changes in a way an older row cannot satisfy.
 */
export const APP_SCHEMA_VERSION = 9

/** The prefix AppStore gives every persisted collection's storage key. */
export const PERSISTED_KEY_PREFIX = "smithers-mvp."

/** Where the gate stamps the version it last wrote the store under. */
export const SCHEMA_VERSION_STORAGE_KEY = `${PERSISTED_KEY_PREFIX}schemaVersion`

/** Where boot stamps the backend that holds the live store. */
export const PERSISTENCE_BACKEND_STORAGE_KEY = `${PERSISTED_KEY_PREFIX}persistenceBackend`

/** Raw pre-migration envelopes retained outside the live namespace on a reset. */
export const SCHEMA_QUARANTINE_PREFIX = "smithers-mvp-quarantine."

/** The two stores AppStore can persist into. */
export type PersistenceBackendKind = "opfs" | "localStorage"

/*
 * The gate's own bookkeeping, as opposed to the data. A reset clears the data
 * and keeps these: the version stamp is rewritten by the reset itself, and the
 * backend stamp names where the store lives, which a reset does not change.
 */
const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  SCHEMA_VERSION_STORAGE_KEY,
  PERSISTENCE_BACKEND_STORAGE_KEY
])

/**
 * The backend the last launch committed to, or null when no launch has stamped
 * one (a first run, or a store written before the stamp existed).
 */
export const readRecordedBackend = (storage: StorageApi): PersistenceBackendKind | null => {
  const stamped = storage.getItem(PERSISTENCE_BACKEND_STORAGE_KEY)
  return stamped === "opfs" || stamped === "localStorage" ? stamped : null
}

/** Stamp the backend this launch committed to, for the next launch to honour. */
export const recordBackend = (storage: StorageApi, backend: PersistenceBackendKind): void => {
  storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, backend)
}

/**
 * Every collection id AppStore persists. SchemaVersion.test.ts asserts this
 * list equals the ids of the collections a real store exposes, so adding a
 * collection without adding it here fails the suite instead of leaving a
 * stale key behind after a bump.
 */
export const PERSISTED_COLLECTION_IDS: ReadonlyArray<string> = [
  "app-sessions",
  "app-messages",
  "app-connectors",
  "app-connector-operations",
  "world-documents",
  "app-cards",
  "app-transitions",
  "app-identity-sessions",
  "app-billing-accounts",
  "app-toasts",
  "app-watched-repos",
  "app-tool-calls",
  "app-chain-events",
  "app-tabs",
  "app-harnesses",
  "app-repos"
]

/** The storage keys the gate clears on a mismatch. */
export const persistedStorageKeys = (): ReadonlyArray<string> => [
  ...PERSISTED_COLLECTION_IDS.map((id) => `${PERSISTED_KEY_PREFIX}${id}`),
  // The transactional envelope and its write-ahead stage
  // (TransactionalStorage.ts): persisted state, cleared with the rest.
  ENVELOPE_STORAGE_KEY,
  STAGED_ENVELOPE_STORAGE_KEY
]

export interface SchemaVersionOutcome {
  /**
   * "match" left the store alone. "reset" cleared it: either the stamp named
   * a different version, or there was no stamp and the rows predate the gate.
   */
  /**
   * "match" left the store alone. "reset" cleared it: the stamp named a
   * different version. "adopt" left an unstamped store's data in place and
   * stamped it — see `enforceSchemaVersion`.
   */
  readonly action: "match" | "reset" | "adopt"
  /** The stamp the gate read, or null when the store carried none. */
  readonly from: string | null
  /** The version now stamped. */
  readonly to: number
  /** The keys the gate removed, sorted. */
  readonly clearedKeys: ReadonlyArray<string>
  /** Backup keys holding the raw envelopes removed from the live namespace. */
  readonly quarantinedKeys: ReadonlyArray<string>
}

export interface SchemaVersionOptions {
  /** Defaults to APP_SCHEMA_VERSION. Tests pass a bump. */
  readonly version?: number
}

/*
 * StorageApi is the three-method subset TanStack needs. A real Storage also
 * enumerates, which lets the gate reach keys the declared list has forgotten
 * (a collection deleted in an earlier release, say). Enumeration is a bonus,
 * never the contract: the declared list is always cleared too.
 */
interface EnumerableStorage {
  readonly length: number
  key: (index: number) => string | null
}

const enumerable = (storage: StorageApi): EnumerableStorage | undefined => {
  const candidate = storage as Partial<EnumerableStorage>
  return typeof candidate.length === "number" && typeof candidate.key === "function"
    ? (candidate as EnumerableStorage)
    : undefined
}

const keysToClear = (storage: StorageApi): ReadonlyArray<string> => {
  const keys = new Set<string>(persistedStorageKeys())
  const scannable = enumerable(storage)
  if (scannable !== undefined) {
    for (let index = 0; index < scannable.length; index += 1) {
      const key = scannable.key(index)
      if (key === null) continue
      if (!key.startsWith(PERSISTED_KEY_PREFIX)) continue
      if (BOOKKEEPING_KEYS.has(key)) continue
      keys.add(key)
    }
  }
  return [...keys].sort()
}

/**
 * Reconciles a localStorage-backed store with the current schema version.
 *
 * Call it before any collection is constructed.
 *
 * - A stamp that matches: untouched.
 * - A stamp that differs: cleared and restamped. The rows were written under a
 *   shape this build cannot satisfy, and reset matches the OPFS policy.
 * - No stamp: **adopted**, not cleared. The data stays and the store is
 *   stamped.
 *
 * Adopting is the difference between an upgrade and a data-loss event. An
 * unstamped store is not an old store; it is a store written before this gate
 * existed, and the gate ships in the same build as the version it stamps, so
 * the rows in it were written by the release immediately before this one. The
 * gate cannot tell that store apart from a genuinely ancient one, and clearing
 * on that ambiguity destroys a real user's conversation to avoid a shape
 * mismatch that is unlikely and recoverable. The failure it trades for is a
 * collection that wedges on the first full-row validation, which `/clear`
 * resolves; the failure it avoids is silent, total, and permanent.
 *
 * This is the same rule the backend stamp follows in `resolvePersistence`:
 * never present an empty store as a returning user's conversation.
 */
export const enforceSchemaVersion = (
  storage: StorageApi,
  options: SchemaVersionOptions = {}
): SchemaVersionOutcome => {
  const version = options.version ?? APP_SCHEMA_VERSION
  const from = storage.getItem(SCHEMA_VERSION_STORAGE_KEY)
  if (from === String(version)) {
    return { action: "match", from, to: version, clearedKeys: [], quarantinedKeys: [] }
  }
  if (from === null) {
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(version))
    return { action: "adopt", from, to: version, clearedKeys: [], quarantinedKeys: [] }
  }
  const clearedKeys = keysToClear(storage)
  const quarantinedKeys: string[] = []
  for (const key of clearedKeys) {
    const raw = storage.getItem(key)
    if (raw === null) continue
    const quarantineKey = `${SCHEMA_QUARANTINE_PREFIX}${from}.${key.slice(PERSISTED_KEY_PREFIX.length)}`
    storage.setItem(quarantineKey, raw)
    quarantinedKeys.push(quarantineKey)
  }
  for (const key of clearedKeys) storage.removeItem(key)
  storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(version))
  return { action: "reset", from, to: version, clearedKeys, quarantinedKeys }
}
