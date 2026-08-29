/**
 * The tier-2 anchor projector: engine snapshot records in, frame anchors out.
 *
 * `docs/specs/Concepts/Time Travel.md` says a frame must carry the jj pointer
 * current when its seq was journaled and the plan digest in force, because
 * replay cannot derive either. The engine emits both facts as ordinary journal
 * records — it has to, it is the only thing that knows them — but the engine
 * must NOT write `flows_time_travel_snapshots` itself: `@smthrs/time-travel`
 * already depends on `@smthrs/engine-store`, so an engine that wrote this
 * package's tables would close a dependency cycle.
 *
 * A projector is the seam that keeps the arrow one-way. It reads the journal
 * (which both packages may depend on) and folds it into the anchor table
 * through {@link TimeTravelStore.Service.recordSnapshot}. `docs/specs/Concepts/Journal Queue.md`'s
 * rule applies: a projection has no independent durable state, so replaying the
 * same entries reproduces the same anchors, and running it twice is a no-op.
 *
 * @since 0.1.0
 */
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import type * as Projection from "@smthrs/journal/Projection"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { error, type TimeTravelError } from "../TimeTravelError.ts"
import { TimeTravelStore } from "../TimeTravelStore.ts"

/**
 * What the fold carries between entries.
 *
 * `changeId` is the pointer the last anchor named, which is what a `carried`
 * record resolves to; `planDigest` is the digest the last plan record put in
 * force. Both start absent, and an anchor is written only once a pointer
 * exists — a lineage that has taken no snapshot has no tier-2 state to restore,
 * and inventing one would be worse than reporting none.
 *
 * @since 0.1.0
 * @category models
 */
export interface State {
  readonly changeId: string | undefined
  readonly planDigest: string | undefined
  readonly anchors: number
}

/**
 * The fold's starting {@link State}: no pointer, no digest, nothing anchored.
 *
 * Because a projection has no durable state of its own, every run of the
 * projector starts here and replays to the same result.
 *
 * @since 0.1.0
 * @category constants
 */
export const initial: State = { changeId: undefined, planDigest: undefined, anchors: 0 }

const LineageMeta = Schema.Struct({ lineageId: Schema.NonEmptyString })

const SnapshotPayload = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  snapshotId: Schema.optionalKey(Schema.NonEmptyString),
  carried: Schema.optionalKey(Schema.Boolean)
})

const PlanPayload = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  digest: Schema.NonEmptyString
})

/**
 * The fold, as a reproducible journal projection.
 *
 * @since 0.1.0
 * @category constructors
 */
export const projection = (
  store: TimeTravelStore["Service"]
): Projection.Projection<State, TimeTravelError> => ({
  name: "flows/time-travel/snapshots",
  initial,
  reduce: (state, entry) =>
    Effect.gen(function*() {
      if (entry.eventType === "flows.engine.plan-recorded" || entry.eventType === "flows.engine.subgraph-appended") {
        const plan = yield* Schema.decodeUnknownEffect(PlanPayload)(entry.payload).pipe(
          Effect.mapError((cause) => error("invalid", `plan event ${entry.eventId} is corrupt`, cause))
        )
        return { ...state, planDigest: plan.digest }
      }
      if (entry.eventType !== "flows.engine.snapshot-identified") return state
      const { lineageId } = yield* Schema.decodeUnknownEffect(LineageMeta)(entry.meta).pipe(
        Effect.mapError((cause) =>
          error("invalid", `snapshot event ${entry.eventId} has corrupt lineage metadata`, cause)
        )
      )
      const payload = yield* Schema.decodeUnknownEffect(SnapshotPayload)(entry.payload).pipe(
        Effect.mapError((cause) => error("invalid", `snapshot event ${entry.eventId} is corrupt`, cause))
      )
      // `carried` asserts "the same pointer as the previous anchor" — the cheap
      // half of the per-frame obligation. Resolving it here is what turns one
      // journal row into a real tier-2 address.
      const changeId = payload.snapshotId ?? state.changeId
      if (changeId === undefined) return { ...state, anchors: state.anchors }
      yield* store.recordSnapshot({
        runId: entry.runId,
        frame: { lineageId, seq: entry.seq },
        changeId,
        ...(state.planDigest === undefined ? {} : { planDigest: state.planDigest })
      })
      return { changeId, planDigest: state.planDigest, anchors: state.anchors + 1 }
    })
})

/**
 * Folds one run's committed journal into its frame anchors, up to the head.
 *
 * The fold is {@link projection}, a plain `@smthrs/journal` `Projection` that
 * `Journal.project` runs unchanged — that is the reusable artifact, and a live
 * follower should use exactly that. What this driver does NOT do is call
 * `Journal.project` itself, because that stream replays a run and then FOLLOWS
 * its committed tail: it never ends, so a verb that awaited it would hang
 * forever instead of forking. Paging `entries` gives the same fold a terminating
 * driver, and re-running it is a no-op because `recordSnapshot` is an upsert
 * over `(runId, lineageId, seq)`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const project = (
  runId: string,
  pageSize = 200
): Effect.Effect<State, TimeTravelError, Journal.Journal | TimeTravelStore> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const store = yield* TimeTravelStore
    const fold = projection(store)
    let state = fold.initial
    let after: JournalEvent.Seq | undefined
    while (true) {
      const page = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after }),
        limit: pageSize
      }).pipe(Effect.mapError((cause) => error("unknown", `could not read ${runId} for anchoring`, cause)))
      for (const entry of page.entries) state = yield* fold.reduce(state, entry)
      const tail = page.entries.at(-1)?.seq
      if (!page.hasMore) return state
      const previous = after ?? -1
      if (tail === undefined || tail <= previous) {
        return yield* Effect.fail(error("invalid", `snapshot pagination did not advance for ${runId}`))
      }
      after = tail
    }
  })
