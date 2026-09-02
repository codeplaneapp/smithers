/**
 * SQLite FTS5 recall binding.
 *
 * Terms are quoted independently, preserving FTS5 implicit AND semantics
 * while preventing user input from becoming an operator or column selector.
 * The store owns enablement and authoritative SQL filtering; a disabled
 * namespace kind therefore remains a loud `fts_not_enabled` MemoryError.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { compareText, literalFtsQuery } from "./internal/Text.ts"
import type * as MemoryError from "./MemoryError.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Namespace from "./Namespace.ts"
import * as Recall from "./Recall.ts"

/**
 * Escapes a query into a quoted, implicit-AND FTS5 expression.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export { literalFtsQuery }

const run = (input: Recall.Input): Effect.Effect<Recall.Output, MemoryError.MemoryError, MemoryStore.MemoryStore> =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const query = literalFtsQuery(input.query)
    if (query.length === 0 || input.banks.length === 0) return []
    const requested = Math.max(1, Math.ceil((input.maxTokens ?? 2048) / 256))
    const rows = yield* Effect.all(
      input.banks.map((namespace) =>
        store.searchFts({
          namespace: Recall.namespaceForBank(namespace),
          query: input.query,
          limit: requested * 5,
          status: "accepted"
        })
      ),
      { concurrency: "unbounded" }
    )
    const results: Array<Recall.Result> = []
    for (let index = 0; index < rows.length; index++) {
      for (const row of rows[index] ?? []) {
        if (row.status !== undefined && row.status !== "accepted") continue
        if (input.tagGroups !== undefined && !input.tagGroups.every((group) => Namespace.matches(group, row.tags))) {
          continue
        }
        results.push({
          bank: input.banks[index] ?? "",
          key: row.key,
          text: row.text,
          score: row.score ?? 0,
          updatedAtMs: row.updatedAtMs
        })
      }
    }
    results.sort((left, right) =>
      right.score - left.score || (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0) ||
      compareText(left.key, right.key)
    )
    return Recall.capRecallResults(results.slice(0, requested), input.maxTokens ?? 2048)
  })

/**
 * Runs FTS recall against the supplied MemoryStore.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const recall = run

/**
 * Provides FTS recall as a replaceable recall slot.
 *
 * A disabled namespace is not converted to an empty result: the store's
 * typed `fts_not_enabled` error propagates to the caller.
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
