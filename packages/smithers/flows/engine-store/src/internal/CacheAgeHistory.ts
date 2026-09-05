/**
 * Read-only validation of copied cache-age decisions. Producer identities and
 * persisted payloads remain unchanged; ancestry alone is not a reuse proof.
 * @since 1.0.0-rc.0
 */
import { FlowEngine } from "@smthrs/engine"
import { Journal, JournalEvent } from "@smthrs/journal"
import type { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"

/** Paged lookup retains only the matching record, including unexpected event types.
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const find = (
  journal: Journal.Service,
  runId: string,
  predicate: (entry: JournalEvent.Entry) => boolean
): Effect.Effect<JournalEvent.Entry | undefined, Journal.JournalError> =>
  Effect.gen(function*() {
    let after: JournalEvent.Seq | undefined
    while (true) {
      const page = yield* journal.entries({
        runId: JournalEvent.RunId.make(runId),
        limit: 128,
        ...after === undefined ? {} : { after }
      })
      const entry = page.entries.find(predicate)
      if (entry !== undefined) return entry
      if (!page.hasMore) return undefined
      const next = page.entries.at(-1)?.seq
      if (next === undefined || (after !== undefined && next <= after)) {
        return yield* Effect.fail(
          new Journal.JournalError({ code: "read_failed", message: "cache history cursor did not advance" })
        )
      }
      after = next
    }
  })

const fieldsEqual = (value: unknown, expected: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) return false
  const record = value as Readonly<Record<string, unknown>>
  const keys = Object.keys(expected)
  return Object.keys(record).length === keys.length &&
    keys.every((key) => record[key] === (expected as Readonly<Record<string, unknown>>)[key])
}

/** A copied verdict is usable only through an exact, retained fork prefix.
 * Missing/compacted ancestry and malformed or unrelated history fail closed.
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const copiedVerdict = (options: {
  readonly journal: Journal.Service
  readonly runs: RunStore.Service
  readonly runId: string
  readonly decision: JournalEvent.Input
  readonly conflict: Journal.JournalError
}): Effect.Effect<"admitted" | "expired", Journal.JournalError> =>
  Effect.gen(function*() {
    const { journal, runs, conflict, decision } = options
    const source = (entry: JournalEvent.Entry) =>
      entry.sourceId === decision.sourceId && entry.sourceSeq === decision.sourceSeq
    let entry = yield* find(journal, options.runId, source)
    if (entry === undefined) return yield* Effect.fail(conflict)
    const payload = entry.payload as { readonly verdict?: unknown } | null
    const verdict = payload?.verdict
    if (verdict !== "admitted" && verdict !== "expired") return yield* Effect.fail(conflict)
    const expected = { ...decision.payload as Readonly<Record<string, unknown>>, verdict }
    if (entry.eventType !== decision.eventType || !fieldsEqual(entry.payload, expected)) {
      return yield* Effect.fail(conflict)
    }
    let child = options.runId
    const visited = new Set<string>()
    while (!visited.has(child)) {
      visited.add(child)
      const run = yield* runs.get(child).pipe(Effect.mapError((cause) =>
        new Journal.JournalError({
          code: "idempotency_conflict",
          message: conflict.message,
          cause
        })
      ))
      const parent = run.parentRunId
      if (parent === null) return yield* Effect.fail(conflict)
      const marker = yield* find(journal, child, (candidate) => {
        const value = candidate.payload as {
          readonly childRunId?: unknown
          readonly parentRunId?: unknown
          readonly forkJournalOffset?: unknown
        } | null
        return candidate.eventType === "flows.time-travel.fork-created" &&
          candidate.sourceId === "flows/time-travel/fork" && Number(candidate.sourceSeq) === candidate.seq &&
          value?.childRunId === child &&
          value.parentRunId === parent && typeof value.forkJournalOffset === "number" &&
          Number.isSafeInteger(value.forkJournalOffset) && value.forkJournalOffset >= entry!.seq &&
          candidate.seq === value.forkJournalOffset + 1 &&
          fieldsEqual(value, { childRunId: child, parentRunId: parent, forkJournalOffset: value.forkJournalOffset })
      })
      if (marker === undefined) return yield* Effect.fail(conflict)
      const cutoff = yield* find(journal, parent, (candidate) => candidate.seq === marker.seq - 1)
      if (
        cutoff === undefined ||
        !fieldsEqual(marker.meta, { lineageId: (cutoff.meta as { lineageId?: unknown } | null)?.lineageId })
      ) {
        return yield* Effect.fail(conflict)
      }
      const original = yield* find(journal, parent, source)
      if (
        original === undefined || original.seq !== entry.seq || original.emittedAtMs !== entry.emittedAtMs ||
        original.eventType !== entry.eventType ||
        !fieldsEqual(original.payload, expected) ||
        !fieldsEqual(entry.meta, original.meta)
      ) return yield* Effect.fail(conflict)
      if (fieldsEqual(original.meta, { lineageId: FlowEngine.Lineage.root(parent) })) return verdict
      child = parent
      entry = original
    }
    return yield* Effect.fail(conflict)
  })
