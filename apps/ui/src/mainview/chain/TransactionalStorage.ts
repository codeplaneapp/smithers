import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { StorageApi } from "@tanstack/db"

/*
 * The transactional storage host for the localStorage backend (see
 * apps/ui/docs/persistence.md).
 *
 * localStorage has no transaction primitive, and AppStore persists 13
 * collections as 13 independent host keys, so a dispatch's mutationFn fan-out
 * could die half-applied. This facade gives the host one atomic commit point:
 * the whole persisted state lives in ONE versioned envelope
 * (`smithers-mvp.store`), and every commit runs a three-step write-ahead
 * protocol — stage, commit, clear — that a boot can always finish or always
 * undo. Collections keep reading and writing their own TanStack keys through
 * the `storage` facade; nothing above this module changes shape.
 */

/** The one host key holding the whole persisted state as a versioned envelope. */
export const ENVELOPE_STORAGE_KEY = "smithers-mvp.store"

/** The write-ahead key: the next envelope, staged before the commit point. */
export const STAGED_ENVELOPE_STORAGE_KEY = `${ENVELOPE_STORAGE_KEY}.staged`

/** The envelope shape version this build writes. */
export const ENVELOPE_VERSION = 1

/** Raw envelopes retained outside the live namespace (never deleted). */
export const ENVELOPE_QUARANTINE_PREFIX = "smithers-mvp-quarantine.store."

/** Legacy rows that failed schema decode during adoption (never deleted). */
export const ROW_QUARANTINE_PREFIX = "smithers-mvp-quarantine.row."

interface Envelope {
  readonly version: number
  readonly entries: Record<string, string>
}

/** A collection whose pre-envelope host rows the 0→1 migration adopts. */
export interface LegacyCollectionSpec {
  readonly id: string
  readonly schema: StandardSchemaV1
}

export type RecoveryOutcome = "clean" | "complete" | "rollback"

export interface TransactionalStorage {
  /** The StorageApi the persisted collections read and write. */
  readonly storage: StorageApi
  /**
   * Open a batch: writes accumulate into a pending delta. Batches nest;
   * only the outermost commit writes the envelope.
   */
  readonly beginBatch: () => void
  /** Close a batch, committing every write it buffered as ONE envelope write. */
  readonly commitBatch: () => void
  /** Abandon a batch: nothing it buffered reaches the host. */
  readonly abortBatch: () => void
  /**
   * Run `work` against a pending delta and commit every write it made as ONE
   * envelope write. A throw (or rejection) aborts the batch: no projection of
   * it reaches the host.
   */
  readonly batch: <T>(work: () => T) => T
  /** How the boot recovered the interrupted commit it found, if any. */
  readonly recovery: RecoveryOutcome
  /** The quarantine keys this open wrote (adoption failures, future shapes). */
  readonly quarantinedKeys: ReadonlyArray<string>
}

const parseEnvelope = (raw: string): Envelope | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof parsed.version === "number" &&
      "entries" in parsed &&
      typeof parsed.entries === "object" &&
      parsed.entries !== null
    ) {
      return parsed as Envelope
    }
    return undefined
  } catch {
    return undefined
  }
}

/*
 * Finish or undo an interrupted commit.
 *
 * The commit point is the envelope write itself, so a staged key can only
 * mean two things: the crash came after the commit (staged bytes equal the
 * live envelope — complete it by clearing the stage) or before it (they
 * differ — roll back by dropping the stage; the old envelope is untouched).
 */
export const recoverInterruptedCommit = (host: StorageApi): RecoveryOutcome => {
  const staged = host.getItem(STAGED_ENVELOPE_STORAGE_KEY)
  if (staged === null) return "clean"
  const outcome: RecoveryOutcome = host.getItem(ENVELOPE_STORAGE_KEY) === staged ? "complete" : "rollback"
  host.removeItem(STAGED_ENVELOPE_STORAGE_KEY)
  return outcome
}

const decodeRow = async (
  schema: StandardSchemaV1,
  row: unknown
): Promise<{ readonly ok: boolean }> => {
  const result = schema["~standard"].validate(row)
  const settled = result instanceof Promise ? await result : result
  return { ok: settled.issues === undefined || settled.issues.length === 0 }
}

/*
 * The 0→1 migration: adopt the pre-envelope layout (one host key per
 * collection, each holding TanStack's `{ encodedKey: { versionKey, data } }`
 * map) into the envelope. Every row is schema-decoded before adoption — an
 * unstamped legacy row is never adopted blind: rows that fail decode are
 * quarantined with their raw bytes, and a collection key that does not parse
 * is quarantined whole. Adopted or not, the legacy key leaves the live
 * namespace.
 */
const adoptLegacyRows = async (
  host: StorageApi,
  collections: ReadonlyArray<LegacyCollectionSpec>,
  entries: Record<string, string>,
  quarantinedKeys: string[]
): Promise<void> => {
  for (const collection of collections) {
    const legacyKey = `smithers-mvp.${collection.id}`
    const raw = host.getItem(legacyKey)
    if (raw === null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      const quarantineKey = `${ENVELOPE_QUARANTINE_PREFIX}unparseable.${collection.id}`
      host.setItem(quarantineKey, raw)
      quarantinedKeys.push(quarantineKey)
      host.removeItem(legacyKey)
      continue
    }
    const adopted: Record<string, unknown> = {}
    for (const [encodedKey, stored] of Object.entries(parsed)) {
      const row = typeof stored === "object" && stored !== null && "data" in stored
        ? (stored as { readonly data: unknown }).data
        : undefined
      if (row !== undefined && (await decodeRow(collection.schema, row)).ok) {
        adopted[encodedKey] = stored
      } else {
        const quarantineKey = `${ROW_QUARANTINE_PREFIX}${collection.id}.${encodedKey}`
        host.setItem(quarantineKey, JSON.stringify(stored))
        quarantinedKeys.push(quarantineKey)
      }
    }
    entries[legacyKey] = JSON.stringify(adopted)
    host.removeItem(legacyKey)
  }
}

/**
 * Ordered envelope migrations: step at index `n` migrates version `n` to
 * version `n + 1`. Open applies every step between the stored version and
 * ENVELOPE_VERSION, in order. Version 0 is the pre-envelope host layout, so
 * step 0 is the legacy adoption above.
 */
const migrateEntries = async (
  host: StorageApi,
  collections: ReadonlyArray<LegacyCollectionSpec>,
  fromVersion: number,
  entries: Record<string, string>,
  quarantinedKeys: string[]
): Promise<Record<string, string>> => {
  let migrated = entries
  for (let version = fromVersion; version < ENVELOPE_VERSION; version += 1) {
    if (version === 0) {
      await adoptLegacyRows(host, collections, migrated, quarantinedKeys)
    }
    // Later steps slot in here, one pure entries→entries transform each.
  }
  return migrated
}

/**
 * Open the transactional store over `host`: recover any interrupted commit,
 * load or migrate the envelope, and hand out the facade the collections write
 * through.
 */
export const openTransactionalStorage = async (
  host: StorageApi,
  options: { readonly collections: ReadonlyArray<LegacyCollectionSpec> }
): Promise<TransactionalStorage> => {
  const recovery = recoverInterruptedCommit(host)
  const quarantinedKeys: string[] = []
  let entries: Record<string, string> = {}
  const raw = host.getItem(ENVELOPE_STORAGE_KEY)
  if (raw === null) {
    // No envelope: anything under the declared legacy keys is version 0.
    entries = await migrateEntries(host, options.collections, 0, entries, quarantinedKeys)
  } else {
    const envelope = parseEnvelope(raw)
    if (envelope === undefined) {
      const quarantineKey = `${ENVELOPE_QUARANTINE_PREFIX}corrupt`
      host.setItem(quarantineKey, raw)
      quarantinedKeys.push(quarantineKey)
      host.removeItem(ENVELOPE_STORAGE_KEY)
    } else if (envelope.version > ENVELOPE_VERSION) {
      // A newer build wrote this store. Quarantine — never delete — and
      // boot empty rather than guess at a shape this build cannot read.
      const quarantineKey = `${ENVELOPE_QUARANTINE_PREFIX}future.${envelope.version}`
      host.setItem(quarantineKey, raw)
      quarantinedKeys.push(quarantineKey)
      host.removeItem(ENVELOPE_STORAGE_KEY)
    } else {
      entries = await migrateEntries(
        host,
        options.collections,
        envelope.version,
        { ...envelope.entries },
        quarantinedKeys
      )
    }
  }

  let base = new Map<string, string>(Object.entries(entries))
  let pending: Map<string, string | null> | undefined
  let batchDepth = 0

  const serialize = (next: ReadonlyMap<string, string>): string =>
    JSON.stringify({ version: ENVELOPE_VERSION, entries: Object.fromEntries(next) })

  /*
   * The one commit point. Stage the next envelope, commit it with a single
   * atomic write, then clear the stage. A crash before the middle write
   * leaves the old envelope authoritative; a crash after it leaves the new
   * one; the boot's recovery finishes either direction.
   *
   * The in-memory mirror adopts `next` only after the host write returns.
   * A commit that throws (a quota rejection, a revoked host) must leave the
   * mirror on the last committed envelope: otherwise the live session would
   * read a projection the host never took, and the NEXT successful commit
   * would persist it — the half-applied transition this facade exists to
   * prevent.
   */
  const commit = (next: Map<string, string>): void => {
    const serialized = serialize(next)
    host.setItem(STAGED_ENVELOPE_STORAGE_KEY, serialized)
    host.setItem(ENVELOPE_STORAGE_KEY, serialized)
    host.removeItem(STAGED_ENVELOPE_STORAGE_KEY)
    base = next
  }

  /** The mirror the pending delta would produce, without touching `base`. */
  const withPending = (): Map<string, string> => {
    const next = new Map(base)
    if (pending !== undefined) {
      for (const [key, value] of pending) {
        if (value === null) next.delete(key)
        else next.set(key, value)
      }
    }
    return next
  }

  const storage: StorageApi = {
    getItem: (key) => {
      if (pending !== undefined && pending.has(key)) return pending.get(key) ?? null
      return base.get(key) ?? null
    },
    setItem: (key, value) => {
      if (pending !== undefined) {
        pending.set(key, value)
        return
      }
      const next = new Map(base)
      next.set(key, value)
      commit(next)
    },
    removeItem: (key) => {
      if (pending !== undefined) {
        pending.set(key, null)
        return
      }
      const next = new Map(base)
      next.delete(key)
      commit(next)
    }
  }

  const beginBatch = (): void => {
    if (batchDepth === 0) pending = new Map()
    batchDepth += 1
  }

  const commitBatch = (): void => {
    if (batchDepth === 0) return
    batchDepth -= 1
    if (batchDepth > 0) return
    const next = withPending()
    // `pending` is cleared before the write so a throwing commit leaves the
    // facade out of the batch entirely, on the last committed mirror.
    pending = undefined
    commit(next)
  }

  const abortBatch = (): void => {
    batchDepth = 0
    pending = undefined
  }

  const batch = <T>(work: () => T): T => {
    beginBatch()
    try {
      const out = work()
      if (out instanceof Promise) {
        return out.then(
          (value) => {
            commitBatch()
            return value
          },
          (error: unknown) => {
            abortBatch()
            throw error
          }
        ) as T
      }
      commitBatch()
      return out
    } catch (error) {
      abortBatch()
      throw error
    }
  }

  // Persist the freshly recovered/migrated/adopted state as one committed
  // write. Rewriting identical bytes in the common case costs one write per
  // boot and keeps every open's end state committed by construction.
  commit(base)

  return { storage, beginBatch, commitBatch, abortBatch, batch, recovery, quarantinedKeys }
}
