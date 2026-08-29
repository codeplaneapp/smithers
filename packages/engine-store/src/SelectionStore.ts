/**
 * Durable suspected-edge storage for probabilistic selection.
 *
 * The store persists advisory beliefs only: training moves edge confidence and
 * appends evidence, but it never writes scheduler journal records, step keys,
 * or cache rows (law 5). The edge and snapshot schemas are `Selection`'s own —
 * one source of truth, so a stored edge is by construction what
 * `Selection.select` consumes. Evidence entries stay strings: training appends
 * the observation JSON-encoded, so audits can replay the asymmetric rule
 * without the schema forking from `Selection.SuspectedEdge`.
 *
 * Model-backed selection, CLI verbs, approval routing, auto-appending
 * proposals, and scheduled recertification cadence are deliberately out of
 * scope here: `engine-store` must not grow a model dependency, this repo has
 * no CLI or approval machinery at this seam, proposal admission still needs
 * human product review, and cadence belongs to a system-flow/product layer
 * rather than the primitive store.
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Selection from "./Selection.ts"

/**
 * Training outcomes for a suspected edge: a `hit` is a recertified deferral
 * that passed, a `miss` is one that failed — the guess was confidently wrong.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const TrainingOutcome = Schema.Literals(["hit", "miss"])

/**
 * Training outcomes for a suspected edge.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TrainingOutcome = typeof TrainingOutcome.Type

/**
 * One observed result for a stored suspected edge.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const TrainingObservation = Schema.Struct({
  scope: Schema.NonEmptyString,
  affects: Schema.NonEmptyString,
  outcome: TrainingOutcome
})

/**
 * One observed result for a stored suspected edge.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TrainingObservation = typeof TrainingObservation.Type

/**
 * Durable suspected-edge persistence operations. `snapshot` pins the injected
 * clock's now, never `Date.now()`; `train` applies the asymmetric rule — a
 * hit gains five percent of the remaining headroom, a miss halves — to
 * matching stored edges only, ignoring unknown pairs rather than creating
 * them.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly upsert: (edges: ReadonlyArray<Selection.SuspectedEdge>) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Selection.SuspectedEdge>>
  readonly snapshot: () => Effect.Effect<Selection.BeliefSnapshot>
  readonly train: (observations: ReadonlyArray<TrainingObservation>) => Effect.Effect<void>
}

/**
 * Service tag for the durable suspected-edge store.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class SelectionStore extends Context.Service<SelectionStore, Service>()(
  "@smthrs/engine-store/SelectionStore"
) {}

const EvidenceListFromJsonString = Schema.fromJsonString(Schema.Array(Schema.String))

const EdgeRow = Schema.Struct({
  scope: Schema.NonEmptyString,
  affects: Schema.NonEmptyString,
  confidence: Schema.Number,
  validFromMs: Schema.Number,
  evidenceJson: Schema.String
})

type EdgeRow = typeof EdgeRow.Type

const decodeObservation = (input: unknown): Effect.Effect<TrainingObservation> =>
  Schema.decodeUnknownEffect(TrainingObservation)(input).pipe(Effect.orDie)

const decodeEdge = (input: unknown): Effect.Effect<Selection.SuspectedEdge> =>
  Schema.decodeUnknownEffect(Selection.SuspectedEdge)(input).pipe(Effect.orDie)

const encodeEvidence = (evidence: ReadonlyArray<string>): Effect.Effect<string> =>
  Schema.encodeEffect(EvidenceListFromJsonString)(evidence).pipe(Effect.orDie)

const decodeEvidence = (evidenceJson: string): Effect.Effect<ReadonlyArray<string>> =>
  Schema.decodeUnknownEffect(EvidenceListFromJsonString)(evidenceJson).pipe(Effect.orDie)

const decodeRow = (input: unknown): Effect.Effect<Selection.SuspectedEdge> =>
  Schema.decodeUnknownEffect(EdgeRow)(input).pipe(
    Effect.orDie,
    Effect.flatMap((row) =>
      decodeEvidence(row.evidenceJson).pipe(
        Effect.flatMap((evidence) =>
          decodeEdge({
            scope: row.scope,
            affects: row.affects,
            confidence: row.confidence,
            validFromMs: row.validFromMs,
            evidence
          })
        )
      )
    )
  )

const trainConfidence = (confidence: number, outcome: TrainingOutcome): number =>
  outcome === "hit"
    ? confidence + 0.05 * (1 - confidence)
    : confidence * 0.5

/**
 * Builds the SQL-backed suspected-edge store.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter

  const selectEdge = (observation: TrainingObservation) =>
    sql<EdgeRow>`
      SELECT
        scope,
        affects,
        confidence,
        valid_from_ms AS "validFromMs",
        evidence_json AS "evidenceJson"
      FROM flows_selection_suspected_edges
      WHERE scope = ${observation.scope}
        AND affects = ${observation.affects}
    `

  const writeEdge = (edge: Selection.SuspectedEdge): Effect.Effect<void, unknown> =>
    Effect.gen(function*() {
      const evidenceJson = yield* encodeEvidence(edge.evidence)
      yield* sql`
        INSERT INTO flows_selection_suspected_edges (
          scope, affects, confidence, valid_from_ms, evidence_json
        ) VALUES (
          ${edge.scope}, ${edge.affects}, ${edge.confidence}, ${edge.validFromMs}, ${evidenceJson}
        ) ON CONFLICT (scope, affects) DO UPDATE SET
          confidence = excluded.confidence,
          valid_from_ms = excluded.valid_from_ms,
          evidence_json = excluded.evidence_json
      `
    })

  const upsert: Service["upsert"] = Effect.fn("SelectionStore.upsert")((edges) =>
    Effect.gen(function*() {
      const decoded = yield* Effect.forEach(edges, decodeEdge)
      yield* writer.write(Effect.forEach(decoded, writeEdge, { discard: true })).pipe(Effect.orDie)
    })
  )

  const list: Service["list"] = Effect.fn("SelectionStore.list")(() =>
    Effect.gen(function*() {
      const rows = yield* sql<EdgeRow>`
        SELECT
          scope,
          affects,
          confidence,
          valid_from_ms AS "validFromMs",
          evidence_json AS "evidenceJson"
        FROM flows_selection_suspected_edges
        ORDER BY scope, affects
      `.pipe(Effect.orDie)
      return yield* Effect.forEach(rows, decodeRow)
    })
  )

  const snapshot: Service["snapshot"] = Effect.fn("SelectionStore.snapshot")(() =>
    Effect.gen(function*() {
      const pinnedAtMs = yield* Clock.currentTimeMillis
      const edges = yield* list()
      return { pinnedAtMs, edges }
    })
  )

  const train: Service["train"] = Effect.fn("SelectionStore.train")((observations) =>
    Effect.gen(function*() {
      const decoded = yield* Effect.forEach(observations, decodeObservation)
      yield* writer.write(Effect.forEach(
        decoded,
        (observation) =>
          Effect.gen(function*() {
            const rows = yield* selectEdge(observation)
            const row = rows[0]
            if (row === undefined) return
            const edge = yield* decodeRow(row)
            yield* writeEdge({
              ...edge,
              confidence: trainConfidence(edge.confidence, observation.outcome),
              evidence: [...edge.evidence, JSON.stringify(observation)]
            })
          }),
        { discard: true }
      )).pipe(Effect.orDie)
    })
  )

  return { upsert, list, snapshot, train }
})

/**
 * Provides the SQL-backed suspected-edge store.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<SelectionStore, never, DurableWriter | SqlClient.SqlClient> = Layer.effect(
  SelectionStore
)(make)
