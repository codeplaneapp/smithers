/**
 * SQLite-backed score observation store.
 *
 * Package documentation: `packages/scorers/docs/api.md`.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Text from "./internal/text.ts"
import * as Migrations from "./migrations/index.ts"
import { ScorerError } from "./ScorerError.ts"
import * as ScoreStore from "./ScoreStore.ts"

interface ObservationRow {
  readonly id: number
  readonly kind: "score" | "inconclusive"
  readonly target_step_key: string
  readonly scorer_key: string
  readonly value: number | null
  readonly reason: string | null
  readonly failure_code: string | null
  readonly metadata_json: string | null
  readonly at_ms: number
}

interface AggregateRow {
  readonly count: number
  readonly mean: number | null
  readonly min: number | null
  readonly inconclusive: number
}

/** A validated, fully encoded observation, snapshotted before the transaction opens. */
interface Insertable {
  readonly kind: "score" | "inconclusive"
  readonly targetStepKey: string
  readonly scorerKey: string
  readonly value: number | null
  readonly reason: string | null
  readonly failureCode: string | null
  readonly metadataJson: string | null
  readonly at: number
}

const failure = (message: string) => (cause: unknown): ScorerError => new ScorerError({ code: "store", message, cause })

/**
 * Maps a write failure to one stable scorer code.
 *
 * The outer mapper cannot simply be dropped: `DurableWriter.write` widens the
 * error channel with `DatabaseError`, and removing it is what keeps that off a
 * scorer caller's channel. Mapping every failure through one fixed sentence
 * was the defect. A permanent constraint violation, which retrying can never
 * fix, was indistinguishable from a transient `busy`, and the underlying
 * database text never surfaced at all.
 *
 * Every statement below normalizes its own `SqlError` with
 * `DurableWriter.fromSqlError` first, so this sees exactly one error type and
 * has no unreachable arm for a shape the runtime never produces.
 *
 * @internal
 */
const classify = (message: string) => (error: DurableWriter.DatabaseError): ScorerError =>
  new ScorerError({
    code: error.code === "constraint" ? "constraint" : "store",
    message: `${message} (database: ${error.code})`,
    cause: error
  })

const invalid = (message: string, cause?: unknown): ScorerError =>
  new ScorerError({
    code: "invalid_observation",
    message,
    ...(cause === undefined ? {} : { cause })
  })

/**
 * Encodes `meta` through the canonical form the scorer key already uses.
 *
 * A bare `JSON.stringify` inside `writer.write` ran caller code (getters,
 * Proxy traps, `toJSON`) while holding the single-writer transaction, and
 * preserved insertion order rather than the canonical key order every other
 * identity in this package is built from. Encoding here, before the
 * transaction opens, also bounds the stored size.
 *
 * @internal
 */
const metadataJson = (observation: ScoreStore.Observation): Effect.Effect<string | null, ScorerError> => {
  if (observation.kind === "inconclusive" || observation.meta === undefined) return Effect.succeed(null)
  const meta = observation.meta
  return Effect.try({
    try: () => Digest.canonical(meta),
    catch: (cause) => invalid("Score observation metadata is not representable as canonical JSON", cause)
  }).pipe(
    Effect.flatMap((encoded) =>
      Text.byteLength(encoded) > ScoreStore.maxMetadataBytes
        ? Effect.fail(
          invalid(
            `Score observation metadata exceeds ${ScoreStore.maxMetadataBytes} UTF-8 bytes`
          )
        )
        : Effect.succeed(encoded)
    )
  )
}

const withinReasonBound = (observation: ScoreStore.Observation): Effect.Effect<void, ScorerError> =>
  observation.reason !== undefined && Text.byteLength(observation.reason) > ScoreStore.maxReasonBytes
    ? Effect.fail(invalid(`An observation reason exceeds ${ScoreStore.maxReasonBytes} UTF-8 bytes`))
    : Effect.void

const prepare = (observation: ScoreStore.Observation): Effect.Effect<Insertable, ScorerError> =>
  Effect.gen(function*() {
    const valid = yield* ScoreStore.validate(observation)
    yield* withinReasonBound(valid)
    const metadata = yield* metadataJson(valid)
    return {
      kind: valid.kind,
      targetStepKey: valid.targetStepKey,
      scorerKey: valid.scorerKey,
      value: valid.kind === "score" ? valid.score : null,
      reason: valid.reason ?? null,
      failureCode: valid.kind === "inconclusive" ? valid.code ?? null : null,
      metadataJson: metadata,
      at: valid.at
    }
  })

const identity = (value: string): Effect.Effect<string, ScorerError> => {
  if (value.trim().length === 0) {
    return Effect.fail(new ScorerError({ code: "invalid_request", message: "A scorer job identity must not be empty" }))
  }
  return Text.byteLength(value) > ScoreStore.maxIdentityBytes
    ? Effect.fail(
      new ScorerError({
        code: "invalid_request",
        message: `A scorer job identity exceeds ${ScoreStore.maxIdentityBytes} UTF-8 bytes`
      })
    )
    : Effect.succeed(value)
}

const pageLimit = (page: ScoreStore.Page | undefined): Effect.Effect<number, ScorerError> => {
  const limit = page?.limit
  if (limit === undefined) return Effect.succeed(ScoreStore.maxObservations)
  return Number.isSafeInteger(limit) && limit > 0 && limit <= ScoreStore.maxObservations
    ? Effect.succeed(limit)
    : Effect.fail(
      new ScorerError({
        code: "invalid_request",
        message: `An observation page limit must be an integer in [1, ${ScoreStore.maxObservations}], received ${
          String(limit)
        }`
      })
    )
}

const decodeStored = Schema.decodeUnknownEffect(ScoreStore.Observation)

/**
 * Reads one row back through the same contract the write path decodes against.
 *
 * Every guarantee is stated once, in {@link ScoreStore.Observation}, and the
 * row id travels with the failure: the earlier hand-written guards reported
 * "Stored inconclusive observation is missing its reason" with no way to find
 * which row, so one poisoned row made every later read of that target fail
 * with nothing to act on.
 *
 * @internal
 */
const decode = (row: ObservationRow): Effect.Effect<ScoreStore.Observation, ScorerError> =>
  Effect.try({
    try: (): unknown => {
      const at = Number(row.at_ms)
      return row.kind === "inconclusive"
        ? {
          kind: "inconclusive",
          targetStepKey: row.target_step_key,
          scorerKey: row.scorer_key,
          reason: row.reason,
          ...(row.failure_code === null ? {} : { code: row.failure_code }),
          at
        }
        : {
          kind: "score",
          targetStepKey: row.target_step_key,
          scorerKey: row.scorer_key,
          score: row.value === null ? null : Number(row.value),
          ...(row.reason === null ? {} : { reason: row.reason }),
          ...(row.metadata_json === null ? {} : { meta: JSON.parse(row.metadata_json) as unknown }),
          at
        }
    },
    catch: failure(`Could not decode the metadata of stored observation ${row.id}`)
  }).pipe(
    Effect.flatMap((candidate) =>
      decodeStored(candidate).pipe(
        Effect.mapError(
          failure(`Stored observation ${row.id} does not match the durable observation contract`)
        )
      )
    )
  )

/**
 * Builds the SQL-backed score store and applies its migrations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<
  ScoreStore.Service,
  ScorerError,
  DurableWriter.DurableWriter | SqlClient.SqlClient
> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter.DurableWriter
  yield* Migrations.run.pipe(Effect.mapError(failure("Could not run score-store migrations")))

  const observations: ScoreStore.Service["observations"] = (targetStepKey, scorerKey, page) =>
    pageLimit(page).pipe(
      Effect.flatMap((limit) => {
        const scorerFilter = scorerKey === undefined ? sql`` : sql`AND scorer_key = ${scorerKey}`
        const beforeFilter = page?.before === undefined ? sql`` : sql`AND at_ms < ${page.before}`
        // `at_ms` first so the (target_step_key, scorer_key, at_ms) index can
        // serve the ordering; `id` only breaks ties, preserving insertion
        // order within one millisecond.
        return sql<ObservationRow>`SELECT id, kind, target_step_key, scorer_key, value, reason, failure_code,
            metadata_json, at_ms
          FROM flows_scores
          WHERE target_step_key = ${targetStepKey} ${scorerFilter} ${beforeFilter}
          ORDER BY at_ms, id
          LIMIT ${limit}`.pipe(
          Effect.mapError(failure("Could not read score observations")),
          Effect.flatMap((rows) => Effect.forEach(rows, decode))
        )
      })
    )

  const aggregate: ScoreStore.Service["aggregate"] = (targetStepKey, scorerKey) => {
    const scorerFilter = scorerKey === undefined ? sql`` : sql`AND scorer_key = ${scorerKey}`
    return sql<AggregateRow>`SELECT
        count(*) FILTER (WHERE kind = 'score') AS count,
        avg(value) FILTER (WHERE kind = 'score') AS mean,
        min(value) FILTER (WHERE kind = 'score') AS min,
        count(*) FILTER (WHERE kind = 'inconclusive') AS inconclusive
      FROM flows_scores
      WHERE target_step_key = ${targetStepKey} ${scorerFilter}`.pipe(
      Effect.mapError(failure("Could not aggregate score observations")),
      Effect.map((rows) =>
        rows
          .map((row): ScoreStore.Aggregate => ({
            count: Number(row.count),
            mean: row.mean === null ? undefined : Number(row.mean),
            min: row.min === null ? undefined : Number(row.min),
            inconclusive: Number(row.inconclusive)
          }))
          .find((value) => value.count > 0 || value.inconclusive > 0)
      )
    )
  }

  const insert = (row: Insertable) =>
    sql`INSERT INTO flows_scores (
      kind, target_step_key, scorer_key, value, reason, failure_code, metadata_json, at_ms
    ) VALUES (
      ${row.kind},
      ${row.targetStepKey},
      ${row.scorerKey},
      ${row.value},
      ${row.reason},
      ${row.failureCode},
      ${row.metadataJson},
      ${row.at}
    )`.pipe(Effect.mapError(DurableWriter.fromSqlError))

  return ScoreStore.make({
    record: (observation) =>
      prepare(observation).pipe(
        Effect.flatMap((row) =>
          writer.write(insert(row)).pipe(
            Effect.asVoid,
            Effect.mapError(classify("Could not record score observation"))
          )
        )
      ),
    recordOnce: (jobIdentity, observation) =>
      Effect.gen(function*() {
        const claim = yield* identity(jobIdentity)
        const row = yield* prepare(observation)
        return yield* writer.write(
          Effect.gen(function*() {
            const claimed = yield* sql`INSERT INTO flows_score_jobs (identity, created_at_ms)
                VALUES (${claim}, ${row.at})
                ON CONFLICT (identity) DO NOTHING`.raw.pipe(Effect.mapError(DurableWriter.fromSqlError))
            // `DurableWriter.affectedRows` is dialect-agnostic and accepts a
            // safe bigint. Reading an own numeric `changes` here treated the
            // bigint that `SqlClient.SafeIntegers` produces as "already
            // claimed", so the claim committed and the observation was lost
            // forever, silently, on every retry. It also refuses anything that
            // is not a non-negative safe integer, and this single-row insert
            // affects at most one, so zero is the only "already claimed"
            // answer.
            const count = yield* DurableWriter.affectedRows(claimed)
            if (count === 0) return false
            yield* insert(row)
            return true
          })
        ).pipe(Effect.mapError(classify("Could not atomically record scorer job")))
      }),
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
  DurableWriter.DurableWriter | SqlClient.SqlClient
> = Layer.effect(
  ScoreStore.ScoreStore,
  make
)
