import { Event, Journal } from "@smthrs/chain"
import { Effect, Layer, Schema } from "effect"
import type { AppStore } from "../state/AppStore"

/*
 * The chain Journal port over the chainEvents collection (DESIGN.md §14).
 *
 * One instance is scoped to one lineage: reads filter the collection to the
 * lineage and order by seq; appends enter through the shared transition
 * dispatcher (actor recorded, like every other state change) and resolve only
 * after the transaction persists — a journal append is durable evidence, not
 * an optimistic hope. Events are schema-validated in both directions, so a
 * corrupted row fails loudly as JournalError instead of feeding the chain
 * garbage. This layer is the app-side stand-in the flows engine journal
 * replaces in Phase 4; nothing outside this module knows the residency.
 *
 * Single-writer assumption: seq derives from this instance's view of the
 * collection, and the persistence layer enforces no cross-instance
 * uniqueness. One lineage must have one live writer. The append guard below
 * turns a same-instance collision into a typed JournalError; a second store
 * instance over the same storage (two tabs on the localStorage fallback) is
 * outside this layer's protection and waits on the flows engine journal.
 */

export interface CollectionJournalOptions {
  readonly store: AppStore
  readonly lineageId: string
  readonly actor?: "smithers" | "system"
}

const encodeEvent = Schema.encodeUnknownSync(Event.Event)
const decodeEvent = Schema.decodeUnknownSync(Event.Event)

export const makeCollectionJournal = (options: CollectionJournalOptions): Journal.Service => {
  const { store, lineageId } = options
  const actor = options.actor ?? "smithers"

  const lineageRecords = () =>
    [...store.collections.chainEvents.values()]
      .filter((record) => record.lineageId === lineageId)
      .sort((left, right) => left.seq - right.seq)

  return Journal.make({
    append: (event) =>
      Effect.tryPromise({
        try: async () => {
          const records = lineageRecords()
          const seq = records.length === 0 ? 0 : (records[records.length - 1]?.seq ?? -1) + 1
          if (store.collections.chainEvents.get(`chain-${lineageId}-${seq}`) !== undefined) {
            throw new Error(`seq ${seq} already exists — a second writer holds this lineage`)
          }
          await store.dispatch({
            type: "chain.event.appended",
            actor,
            lineageId,
            seq,
            event: encodeEvent(event)
          }).isPersisted.promise
        },
        catch: (cause) =>
          new Journal.JournalError({
            message: `chain journal append failed for lineage ${lineageId}: ${String(cause)}`
          })
      }),
    read: Effect.try({
      try: () => lineageRecords().map((record) => decodeEvent(record.event)),
      catch: (cause) =>
        new Journal.JournalError({
          message: `chain journal read failed for lineage ${lineageId}: ${String(cause)}`
        })
    })
  })
}

export const layerCollection = (
  options: CollectionJournalOptions
): Layer.Layer<Journal.Journal> => Layer.succeed(Journal.Journal)(makeCollectionJournal(options))
