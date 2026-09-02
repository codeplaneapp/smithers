/**
 * Browser-safe keyword recall.
 *
 * Scores each authoritative row by the number of normalized query terms
 * occurring in its key and text, breaks ties by newest update, then applies
 * the shared Smithers-compatible byte cap.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { compareText } from "./internal/Text.ts"
import type * as MemoryError from "./MemoryError.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Namespace from "./Namespace.ts"
import * as Recall from "./Recall.ts"

/**
 * A row accepted from the store retrieval seam.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Row {
  readonly bank?: string | undefined
  readonly namespace?: Namespace.Namespace | undefined
  readonly key: string
  readonly text: string
  readonly tags: ReadonlyArray<string>
  readonly status?: string | undefined
  readonly updatedAtMs: number
}

const normalize = (value: string): ReadonlyArray<string> =>
  value.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)

const score = (query: ReadonlyArray<string>, row: Row): number => {
  const haystack = `${row.key} ${row.text}`.normalize("NFKC").toLowerCase()
  return query.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
}

const matches = (row: Row, groups: ReadonlyArray<Recall.TagGroup> | undefined): boolean =>
  groups === undefined || groups.every((group) => Namespace.matches(group, row.tags))

const authoritative = (row: Row, groups: ReadonlyArray<Recall.TagGroup> | undefined): boolean =>
  matches(row, groups) && (row.status === undefined || row.status === "accepted")

const run = (input: Recall.Input): Effect.Effect<Recall.Output, MemoryError.MemoryError, MemoryStore.MemoryStore> =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const terms = normalize(input.query)
    if (input.banks.length === 0) return []
    const rows = yield* Effect.all(
      input.banks.map((namespace) =>
        store.searchRows({
          namespace: Recall.namespaceForBank(namespace),
          status: "accepted"
        })
      ),
      { concurrency: "unbounded" }
    )
    const ranked = rows.flatMap((bankRows, index) =>
      bankRows
        .map((row) => ({ ...row, bank: input.banks[index] ?? "" }))
        .filter((row) => authoritative(row, input.tagGroups))
        .map((row) => ({
          bank: input.banks[index] ?? "",
          key: row.key,
          text: row.text,
          score: score(terms, row),
          updatedAtMs: row.updatedAtMs
        }))
        .filter((row) => row.score > 0)
    )
    ranked.sort((left, right) =>
      right.score - left.score || right.updatedAtMs - left.updatedAtMs || compareText(left.key, right.key)
    )
    return Recall.capRecallResults(ranked, input.maxTokens ?? 2048)
  })

/**
 * Runs keyword recall against the supplied MemoryStore.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const recall = run

/**
 * Provides keyword recall as the default replaceable recall slot.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<Recall.Recall, never, MemoryStore.MemoryStore> = Layer.effect(
  Recall.Recall,
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    return Recall.make({ recall: (input) => run(input).pipe(Effect.provideService(MemoryStore.MemoryStore, store)) })
  })
)

/**
 * Splits a query into the normalized terms scoring compares against.
 * Exported so the ranking can be tested without a store.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const normalizeQueryTerms = normalize

/**
 * Scores one row against normalized query terms. Exported so the ranking
 * can be tested without a store.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const scoreRow = score
