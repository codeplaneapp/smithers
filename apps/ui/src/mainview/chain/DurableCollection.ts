import type { StandardSchemaV1 } from "@standard-schema/spec"
import { localOnlyCollectionOptions } from "@tanstack/db"
import type { InferSchemaOutput, StorageApi } from "@tanstack/db"

interface StoredItem {
  readonly versionKey: string
  readonly data: unknown
}

export interface DurableBatch {
  readonly beginBatch: () => void
  readonly commitBatch: () => void
  readonly abortBatch: () => void
}

interface PersistedTransaction {
  readonly mutations: ReadonlyArray<{
    readonly collection: { readonly id: string }
    readonly key: string | number
    readonly type: "insert" | "update" | "delete"
    readonly original: unknown
    readonly modified: unknown
  }>
}

export interface CollectionPersistence {
  readonly register: (id: string) => ReadonlyArray<unknown>
  readonly persist: (transaction: PersistedTransaction) => Promise<void>
}

const storageKey = (id: string): string => `smithers-mvp.${id}`
const rowKey = (key: string | number): string => typeof key === "number" ? `n:${key}` : `s:${key}`

const comparableJson = (value: unknown): string | undefined => JSON.stringify(value, (_key, nested: unknown) =>
  typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)))
    : nested
)

export class StaleDurableMutationError extends Error {
  constructor(collectionId: string, key: string | number) {
    super(`The ${collectionId}/${key} mutation was based on state that did not persist. Retry after rollback.`)
  }
}

const readRows = (storage: StorageApi, id: string): Map<string, StoredItem> => {
  const raw = storage.getItem(storageKey(id))
  if (raw === null) return new Map()
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`Invalid persisted collection ${id}.`)
  const rows = new Map<string, StoredItem>()
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || !("versionKey" in value) || typeof value.versionKey !== "string" || !("data" in value)) {
      throw new Error(`Invalid persisted row ${id}/${key}.`)
    }
    // TanStack's historical loader also accepts unprefixed string keys.
    // Normalize them before mutation lookup and the next durable rewrite.
    const encodedKey = key.startsWith("s:") || key.startsWith("n:") ? key : rowKey(key)
    rows.set(encodedKey, { versionKey: value.versionKey, data: value.data })
  }
  return rows
}

/** One serialized durable commit per transaction, with no optimistic row cache. */
export const createCollectionPersistence = (options: {
  readonly storage: StorageApi
  readonly batch?: DurableBatch
  readonly flush?: () => Promise<void>
}): CollectionPersistence => {
  const registered = new Set<string>()
  let tail: Promise<void> = Promise.resolve()
  let generation = 0
  let priorFailure: unknown

  const persist = (transaction: PersistedTransaction): Promise<void> => {
    const acceptedGeneration = generation
    const mutations = transaction.mutations.filter((mutation) => registered.has(mutation.collection.id))
    const operation = tail.then(async () => {
      // Already queued transitions may have been derived from the failed
      // optimistic state. Reject them too; a later fresh dispatch may retry.
      if (acceptedGeneration !== generation) throw priorFailure
      const changed = new Map<string, Map<string, StoredItem>>()
      for (const mutation of mutations) {
        const id = mutation.collection.id
        const rows = changed.get(id) ?? readRows(options.storage, id)
        const prior = rows.get(rowKey(mutation.key))
        if (mutation.type === "insert" ? prior !== undefined : prior === undefined || comparableJson(prior.data) !== comparableJson(mutation.original)) {
          // A rejection handler can dispatch while another failed optimistic
          // transaction is still rolling back. Its generation is current but
          // its original row is not; never persist that stale derived state.
          throw new StaleDurableMutationError(id, mutation.key)
        }
        if (mutation.type === "delete") rows.delete(rowKey(mutation.key))
        else rows.set(rowKey(mutation.key), { versionKey: crypto.randomUUID(), data: mutation.modified })
        changed.set(id, rows)
      }
      // Serialize every projection before opening the synchronous batch.
      const writes = [...changed].map(([id, rows]) => [storageKey(id), JSON.stringify(Object.fromEntries(rows))] as const)
      options.batch?.beginBatch()
      try {
        for (const [key, value] of writes) options.storage.setItem(key, value)
        options.batch?.commitBatch()
        await options.flush?.()
      } catch (error) {
        options.batch?.abortBatch()
        throw error
      }
    }).catch((error: unknown) => {
      if (acceptedGeneration === generation) {
        generation += 1
        priorFailure = error
      }
      throw error
    })
    tail = operation.catch(() => {})
    return operation
  }

  return {
    register: (id) => {
      registered.add(id)
      return [...readRows(options.storage, id).values()].map((row) => row.data)
    },
    persist
  }
}

/** The store opener validates rows; this adapter confirms only durable writes. */
export const durableCollectionOptions = <TSchema extends StandardSchemaV1>(
  persistence: CollectionPersistence,
  spec: {
    readonly id: string
    readonly schema: TSchema
    readonly getKey: (item: InferSchemaOutput<TSchema>) => string
  }
) => localOnlyCollectionOptions({
  ...spec,
  initialData: [...persistence.register(spec.id)] as Array<InferSchemaOutput<TSchema>>,
  onInsert: ({ transaction }) => persistence.persist(transaction),
  onUpdate: ({ transaction }) => persistence.persist(transaction),
  onDelete: ({ transaction }) => persistence.persist(transaction)
})
