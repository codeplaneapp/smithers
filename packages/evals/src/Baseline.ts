/**
 * Canonical committed evaluation baselines.
 *
 * A baseline is the record of what a suite used to score, committed beside the
 * suite it belongs to. It holds only the five fields a comparison reads, and
 * validation rebuilds every record from those fields, so nothing a caller
 * happened to attach to an object travels into a committed artifact.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import { EvalError } from "./EvalError.ts"
import { compareText, stringify } from "./internal/canonical.ts"
import type { Observation, RunResult } from "./Runner.ts"

/**
 * Current committed baseline artifact version.
 *
 * @category models
 * @since 0.1.0
 */
export const version = 1 as const

/**
 * One successful score retained by a baseline.
 *
 * `scorer` is the scorer key a comparison matches on. `scorerName` is the
 * readable name of the same scorer, optional so a baseline written before it
 * existed still loads.
 *
 * @category models
 * @since 0.1.0
 */
export interface BaselineRecord {
  readonly suite: string
  readonly case: string
  readonly scorer: string
  readonly scorerName?: string | undefined
  readonly stepKey: string
  readonly score: number
}

/**
 * Canonical committed evaluation baseline.
 *
 * @category models
 * @since 0.1.0
 */
export interface Baseline {
  readonly version: typeof version
  readonly records: ReadonlyArray<BaselineRecord>
}

const fail = (message: string, path?: string): Effect.Effect<never, EvalError> =>
  Effect.fail(
    new EvalError({ code: "invalid_baseline", message, ...(path === undefined ? {} : { path }) })
  )

const stringField = (value: unknown, field: string, path: string): Effect.Effect<string, EvalError> =>
  typeof value !== "string"
    ? fail(`Baseline record field '${field}' must be a string, got ${typeof value}`, path)
    : Effect.succeed(value)

const decodeRecord = (value: unknown, index: number): Effect.Effect<BaselineRecord, EvalError> =>
  Effect.gen(function*() {
    const at = `records[${index}]`
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return yield* fail(`Baseline record must be an object, got ${value === null ? "null" : typeof value}`, at)
    }
    const source = value as { readonly [key: string]: unknown }
    const suite = yield* stringField(source.suite, "suite", `${at}.suite`)
    const caseName = yield* stringField(source.case, "case", `${at}.case`)
    const scorer = yield* stringField(source.scorer, "scorer", `${at}.scorer`)
    const stepKey = yield* stringField(source.stepKey, "stepKey", `${at}.stepKey`)
    const score = source.score
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      return yield* fail(
        `Baseline record field 'score' must be a finite number in [0, 1], got ${String(score)}`,
        `${at}.score`
      )
    }
    if (source.scorerName !== undefined && typeof source.scorerName !== "string") {
      return yield* fail(
        `Baseline record field 'scorerName' must be a string, got ${typeof source.scorerName}`,
        `${at}.scorerName`
      )
    }
    // Every record is rebuilt field by field. Keeping the caller's object would
    // carry unknown keys, and any getter among them, straight into a committed
    // artifact.
    return {
      suite,
      case: caseName,
      scorer,
      ...(source.scorerName === undefined ? {} : { scorerName: source.scorerName }),
      stepKey,
      score: Object.is(score, -0) ? 0 : score
    }
  })

const validate = (value: unknown): Effect.Effect<Baseline, EvalError> =>
  Effect.gen(function*() {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return yield* fail("Baseline must be an object")
    }
    const artifact = value as { readonly version?: unknown; readonly records?: unknown }
    if (artifact.version !== version) {
      return yield* fail(`Baseline version must be ${version}, got ${String(artifact.version)}`, "version")
    }
    if (!Array.isArray(artifact.records)) {
      return yield* fail("Baseline records must be an array", "records")
    }
    const records = yield* Effect.forEach(artifact.records, decodeRecord)
    return { version, records: Object.freeze(records) }
  })

/**
 * Builds and validates a baseline from a run's successful observations.
 *
 * Inconclusive observations are dropped: a baseline records what was measured,
 * and an inconclusive observation measured nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromRun = (run: RunResult): Effect.Effect<Baseline, EvalError> => {
  const records: Array<BaselineRecord> = run.observations.flatMap((observation: Observation) =>
    observation.kind === "score"
      ? [{
        suite: run.suite,
        case: observation.case,
        scorer: observation.scorer,
        ...(observation.scorerName === undefined ? {} : { scorerName: observation.scorerName }),
        stepKey: observation.stepKey,
        score: observation.score
      }]
      : []
  )
  return validate({ version, records })
}

/**
 * Validates an in-memory baseline.
 *
 * The result is a snapshot: records are rebuilt from their five known fields
 * and the array is frozen, so mutating the array or the objects that were
 * passed in cannot change the validated baseline.
 *
 * Fails with `invalid_baseline` carrying the record index and field name in
 * `path` for a wrong version, a non-array `records`, a record that is not an
 * object, a non-string identity field, or a score that is not finite in
 * `[0, 1]`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  baseline: Omit<Baseline, "version"> & { readonly version?: typeof version }
): Effect.Effect<Baseline, EvalError> => validate({ version: baseline.version ?? version, records: baseline.records })

/**
 * Serializes a baseline with recursively sorted keys and stable numbers.
 *
 * Records are ordered by an injective encoding of `(suite, case, scorer,
 * stepKey)`, so two records whose names differ only in where a separator falls
 * still sort apart. The result ends with a newline and never throws: a
 * validated baseline holds only strings and finite numbers.
 *
 * @category serialization
 * @since 0.1.0
 */
export const write = (baseline: Baseline): string => {
  const sortKey = (record: BaselineRecord): string =>
    JSON.stringify([record.suite, record.case, record.scorer, record.stepKey])
  const records = [...baseline.records].sort((left, right) => compareText(sortKey(left), sortKey(right)))
  return stringify({ version: baseline.version, records })
}

/**
 * Loads and validates canonical baseline JSON.
 *
 * @category serialization
 * @since 0.1.0
 */
export const load = (text: string): Effect.Effect<Baseline, EvalError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new EvalError({ code: "invalid_baseline", message: "Baseline is not valid JSON", cause })
  }).pipe(Effect.flatMap(validate))

/**
 * Alias for {@link load}.
 *
 * @category serialization
 * @since 0.1.0
 */
export const parse = load
