/**
 * Deriving a run's past state from committed journal evidence alone.
 *
 * This is what makes a frame an address rather than a snapshot: nothing stores
 * "the state at seq 17", so {@link rederive} folds the journal prefix up to a
 * frame through a caller-supplied {@link Projection}. It reads only durable
 * evidence — entries and sealed cache results — and has no dispatcher, so a
 * replay can never re-execute a model call or a child flow. Anything not
 * committed simply is not in the answer.
 *
 * Entries are filtered by lineage, so a run whose journal interleaves several
 * lineages replays exactly the one the frame names.
 *
 * @since 0.1.0
 */
import * as Journal from "@smthrs/journal/Journal"
import type { Entry, RunId, Seq } from "@smthrs/journal/JournalEvent"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Frame } from "../Frame.ts"
import { error, type TimeTravelError } from "../TimeTravelError.ts"

/**
 * A pure fold over durable journal evidence.
 *
 * @since 0.1.0
 * @category models
 */
export interface Projection<S> {
  readonly initial: S
  readonly reduce: (state: S, entry: Entry, sealed: unknown | undefined) => S
}
/**
 * Which run to replay, and how large a journal page to read at a time.
 *
 * `pageSize` is a throughput knob only — it never changes the derived state,
 * because the fold sees the same entries in the same order whatever the page
 * boundaries are. It defaults to 100.
 *
 * @since 0.1.0
 * @category models
 */
export interface ReplayOptions {
  readonly runId: string
  readonly pageSize?: number
}
/** @private */
const LineageMetadata = Schema.Struct({ lineageId: Schema.NonEmptyString })
/** @private */
const CacheMetadata = Schema.Struct({ cacheKey: Schema.NonEmptyString })
/**
 * Re-derives a projection from committed evidence only. This deliberately has
 * no dispatcher dependency: model and child results can only be cache reads.
 * @since 0.1.0
 * @category constructors
 */
export const rederive = <S>(
  frame: Frame,
  projection: Projection<S>,
  options: ReplayOptions
): Effect.Effect<S, TimeTravelError, Journal.Journal | CacheStore.CacheStore> =>
  Effect.fn("Replay.rederive")(() =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        runId: options.runId,
        lineageId: frame.lineageId,
        seq: frame.seq
      })
      const journal = yield* Journal.Journal
      const cache = yield* CacheStore.CacheStore
      let after: Seq | undefined
      /**
       * The prefix is normalized before the fold: one record per coordinate,
       * ordered by seq. A journal implementation may hand back duplicate or
       * out-of-order pages — the durable projection is a function of the run's
       * records, never of how a reader happened to page them.
       */
      const prefix = new Map<number, Entry>()
      while (true) {
        const page = yield* journal.entries({
          runId: options.runId as RunId,
          ...(after === undefined ? {} : { after }),
          limit: options.pageSize ?? 100
        }).pipe(Effect.mapError((cause) => error("unknown", "could not read journal", cause)))
        let pageTail: Seq | undefined
        for (const entry of page.entries) {
          if (pageTail === undefined || entry.seq > pageTail) pageTail = entry.seq
          if (entry.seq > frame.seq) continue
          if (!prefix.has(entry.seq)) prefix.set(entry.seq, entry)
        }
        if (!page.hasMore) break
        const previous = after ?? -1
        if (pageTail === undefined || pageTail <= previous) {
          return yield* Effect.fail(error("invalid", "journal replay pagination did not advance"))
        }
        after = pageTail
      }
      let state = projection.initial
      let foundLineage = false
      for (const entry of [...prefix.values()].sort((left, right) => left.seq - right.seq)) {
        const lineageId = Option.getOrUndefined(
          Schema.decodeUnknownOption(LineageMetadata)(entry.meta)
        )?.lineageId
        if (lineageId !== undefined && lineageId !== frame.lineageId) continue
        if (lineageId === frame.lineageId) foundLineage = true
        const cacheKey = Option.getOrUndefined(
          Schema.decodeUnknownOption(CacheMetadata)(entry.meta)
        )?.cacheKey
        // The provenance fence keeps the projection durable: the version this
        // exact record landed answers first, and only an entry recorded
        // elsewhere falls back to the shared content-addressed head.
        const sealed = cacheKey === undefined
          ? undefined
          : yield* cache.get(cacheKey, { recordedBy: { runId: options.runId, eventSeq: entry.seq } }).pipe(
            Effect.mapError((cause) => error("unknown", "could not read sealed result", cause)),
            Effect.map((cached) => cached._tag === "Some" ? cached.value.result : undefined)
          )
        state = projection.reduce(state, entry, sealed)
      }
      if (!foundLineage) {
        return yield* Effect.fail(error("not_found", `lineage ${frame.lineageId} is not present in ${options.runId}`))
      }
      return state
    })
  )()
