/**
 * SQLite-backed score observation store.
 *
 * @see docs/specs/Concepts/Scoring.md
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "./migrations/index.ts"
import { ScorerError } from "./ScorerError.ts"
import * as ScoreStore from "./ScoreStore.ts"

interface ObservationRow {
  readonly kind: "score" | "inconclusive"
  readonly target_step_key: string
  readonly scorer_key: string
  readonly value: number | null
  readonly reason: string | null
  readonly metadata_json: string | null
  readonly at_ms: number
}

interface AggregateRow {
  readonly count: number
  readonly mean: number
  readonly min: number
}

const failure = (message: string) => (cause: unknown): ScorerError => new ScorerError({ code: "store", message, cause })

const changes = (result: unknown): number =>
  typeof result === "object" &&
    result !== null &&
    "changes" in result &&
    typeof result.changes === "number"
    ? result.changes
    : 0

const metadataJson = (observation: ScoreStore.Observation): Effect.Effect<string | null, ScorerError> =>
  observation.kind === "inconclusive" || observation.meta === undefined
    ? Effect.succeed(null)
    : Effect.try({
      try: () => {
        const encoded = JSON.stringify(observation.meta)
        if (encoded === undefined) throw new TypeError("metadata is not JSON-serializable")
        return encoded
      },
      catch: failure("Score observation metadata is not JSON-serializable")
    })

const decode = (row: ObservationRow): Effect.Effect<ScoreStore.Observation, ScorerError> =>
  row.kind === "inconclusive"
    ? row.reason === null
      ? Effect.fail(
        new ScorerError({ code: "store", message: "Stored inconclusive observation is missing its reason" })
      )
      : Effect.succeed({
        kind: "inconclusive",
        targetStepKey: row.target_step_key,
        scorerKey: row.scorer_key,
        reason: row.reason,
        at: Number(row.at_ms)
      })
    : row.value === null
    ? Effect.fail(new ScorerError({ code: "store", message: "Stored score observation is missing its value" }))
    : Effect.try({
      try: () => ({
        kind: "score" as const,
        targetStepKey: row.target_step_key,
        scorerKey: row.scorer_key,
        score: Number(row.value),
        ...(row.reason === null ? {} : { reason: row.reason }),
        ...(row.metadata_json === null ? {} : { meta: JSON.parse(row.metadata_json) as unknown }),
        at: Number(row.at_ms)
      }),
      catch: failure("Could not decode score observation metadata")
    })

/**
 * Builds the SQL-backed score store and applies its migrations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<
  ScoreStore.Service,
  ScorerError,
  DurableWriter | SqlClient.SqlClient
> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter
  yield* Migrations.run.pipe(Effect.mapError(failure("Could not run score-store migrations")))

  const observations: ScoreStore.Service["observations"] = (targetStepKey, scorerKey) =>
    (scorerKey === undefined
      ? sql<ObservationRow>`SELECT kind, target_step_key, scorer_key, value, reason, metadata_json, at_ms
          FROM flows_scores WHERE target_step_key = ${targetStepKey} ORDER BY id`
      : sql<ObservationRow>`SELECT kind, target_step_key, scorer_key, value, reason, metadata_json, at_ms
          FROM flows_scores
          WHERE target_step_key = ${targetStepKey} AND scorer_key = ${scorerKey}
          ORDER BY id`).pipe(
        Effect.mapError(failure("Could not read score observations")),
        Effect.flatMap((rows) => Effect.forEach(rows, decode))
      )

  const aggregate: ScoreStore.Service["aggregate"] = (targetStepKey, scorerKey) =>
    (scorerKey === undefined
      ? sql<AggregateRow>`SELECT count(*) AS count, avg(value) AS mean, min(value) AS min
          FROM flows_scores WHERE target_step_key = ${targetStepKey} AND kind = 'score'`
      : sql<AggregateRow>`SELECT count(*) AS count, avg(value) AS mean, min(value) AS min
          FROM flows_scores
          WHERE target_step_key = ${targetStepKey} AND scorer_key = ${scorerKey} AND kind = 'score'`).pipe(
        Effect.mapError(failure("Could not aggregate score observations")),
        Effect.map((rows) =>
          rows[0] === undefined || Number(rows[0].count) === 0
            ? undefined
            : {
              count: Number(rows[0].count),
              mean: Number(rows[0].mean),
              min: Number(rows[0].min)
            }
        )
      )

  const insert = (
    observation: ScoreStore.Observation
  ): Effect.Effect<void, ScorerError> =>
    metadataJson(observation).pipe(
      Effect.flatMap((metadata) =>
        sql`INSERT INTO flows_scores (
          kind, target_step_key, scorer_key, value, reason, metadata_json, at_ms
        ) VALUES (
          ${observation.kind},
          ${observation.targetStepKey},
          ${observation.scorerKey},
          ${observation.kind === "score" ? observation.score : null},
          ${observation.reason ?? null},
          ${metadata},
          ${observation.at}
        )`
      ),
      Effect.mapError(failure("Could not record score observation")),
      Effect.asVoid
    )

  return ScoreStore.make({
    record: (observation) =>
      writer.write(insert(observation)).pipe(
        Effect.mapError(failure("Could not record score observation"))
      ),
    recordOnce: (identity, observation) =>
      writer.write(
        Effect.gen(function*() {
          const claimed = yield* sql`INSERT INTO flows_score_jobs (identity, created_at_ms)
            VALUES (${identity}, ${observation.at})
            ON CONFLICT (identity) DO NOTHING`.raw
          if (changes(claimed) === 0) return false
          yield* insert(observation)
          return true
        })
      ).pipe(Effect.mapError(failure("Could not atomically record scorer job"))),
    observations,
    aggregate
  })
})

/**
 * Provides the SQL-backed score store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<
  ScoreStore.ScoreStore,
  ScorerError,
  DurableWriter | SqlClient.SqlClient
> = Layer.effect(
  ScoreStore.ScoreStore,
  make
)
