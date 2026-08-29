/**
 * Rewind an ordinary engine run to an earlier frame, and re-derive a view.
 *
 * Both operations hang off one injectable service:
 *
 * `inspect` folds committed journal entries up to a frame through a pure
 * reducer. It reads; it never plans a flow body or runs an action.
 *
 * `rewind` is the mutating protocol. Behind the one call it claims the run,
 * records an audit, assesses external effects recorded on the journal, restores
 * the workspace, and archives and truncates the suffix past the frame in one
 * transaction. The ownership claim, the audit id, and the compensation-handler
 * registry are wired inside the service — none of them appear here.
 *
 * A position is a run id plus a frame `{ lineageId, seq }`, and `inspect` folds
 * only entries whose `meta.lineageId` matches. **Nothing below writes that
 * metadata.** The engine mints the lineage id from the run and stamps it on
 * every record it writes, so an ordinary run driven by the production
 * composition is inspectable as it stands — this example used to hand-author a
 * journal with `meta: { lineageId }` on every entry precisely because it was
 * not.
 *
 * The run is left SUSPENDED on purpose: rewind is a writer, so it takes the
 * ownership claim like any driver and refuses a live run. Phase one below parks
 * the run at a `DurableDeferred.await`, which is what makes it rewindable.
 */
import { Action, DurableDeferred, Flow, Interpreter } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { SqlTimeTravelStore, TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { durableEngine } from "./durable-layer.ts"

/** The declared step the flow's body names; the wait lives in its implementation. */
export const Post = Action.make("examples/Post", {
  payload: {},
  success: Schema.String
})

export const Ledger = Flow.make("examples/Ledger", {
  payload: {},
  success: Schema.String,
  body: (payload) => Post.call(payload)
})

export const Settlement = DurableDeferred.make("examples/settlement", {
  success: Schema.String
})

/** The run's root lineage, exactly as `FlowEngine.Lineage` mints it. */
const lineageId = "ledger-1/root"

/**
 * `TimeTravel.layer` asks only for injectable contracts — the store plus the
 * journal, run, cache, and jj services the engine already provides — so it
 * merges straight onto the engine composition. Building it also resolves any
 * rewind a crash left half-finished, which is why recovery never appears as a
 * call below.
 */
const layer = (filename: string) =>
  Layer.mergeAll(Post.toLayer(post), Interpreter.layer(Ledger)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(TimeTravel.layer),
    Layer.provideMerge(SqlTimeTravelStore.layer),
    Layer.provideMerge(durableEngine(filename, "ledger"))
  )

export interface Summary {
  readonly derivedAttempts: number
  readonly totalEntries: number
  readonly archivedCount: number
  readonly remainingSeqs: ReadonlyArray<number>
  readonly auditStatus: string
}

const Credit = Action.make({
  name: "examples/Credit",
  success: Schema.Number,
  tier: "sealed",
  idempotencyKey: "examples/credit/v1",
  execute: Effect.succeed(30)
})

const post = () =>
  Effect.gen(function*() {
    const amount = yield* Credit
    const settlement = yield* DurableDeferred.await(Settlement)
    return `${amount}:${settlement}`
  })

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    // Drive the run until it parks at the deferred. It releases ownership on
    // the way out, which is the state a rewind requires.
    yield* Ledger.execute({}, { executionId: "ledger-1", discard: true })

    const journal = yield* Journal.Journal
    yield* journal.flush
    const before = yield* journal.entries({ runId: "ledger-1" as JournalEvent.RunId, limit: 200 })
    // Rewind to the middle of what the run recorded.
    const seq = before.entries[Math.floor(before.entries.length / 2)]!.seq
    const position = { runId: "ledger-1", frame: { lineageId, seq } }

    // Read-only: count the action attempts the frame covers, folding the
    // engine's own records.
    const derivedAttempts = yield* TimeTravel.pipe(
      Effect.flatMap((timeTravel) =>
        timeTravel.inspect(position, {
          initial: 0,
          reduce: (state: number, committed) =>
            committed.eventType === "flows.engine.attempt-started" ? state + 1 : state
        })
      )
    )

    // Mutating: drop everything after the frame.
    const timeTravel = yield* TimeTravel
    const result = yield* timeTravel.rewind(position)

    const remaining = yield* journal.entries({ runId: "ledger-1" as JournalEvent.RunId, limit: 200 })
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const audits = yield* sql<{ readonly status: string }>`
      SELECT status FROM flows_time_travel_audits WHERE id = ${result.auditId}
    `

    return {
      derivedAttempts,
      totalEntries: before.entries.length,
      archivedCount: result.archive.archived,
      remainingSeqs: remaining.entries.map((committed) => committed.seq),
      auditStatus: audits[0]?.status ?? "missing"
    }
  }).pipe(
    Effect.provide(layer(filename)),
    Effect.scoped,
    Effect.orDie
  )
