/**
 * Canonical committed evaluation baselines.
 *
 * @see docs/specs/Concepts/Scoring.md
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import { EvalError } from "./EvalError.ts"
import type { Observation, RunResult } from "./Runner.ts"

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/**
 * Current committed baseline artifact version.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const version = 1 as const

/**
 * One successful score retained by a baseline.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Record {
  readonly suite: string
  readonly case: string
  readonly scorer: string
  readonly stepKey: string
  readonly score: number
}

/**
 * Canonical committed evaluation baseline.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Baseline {
  readonly version: typeof version
  readonly records: ReadonlyArray<Record>
}

const isRecord = (value: unknown): value is Record => {
  if (typeof value !== "object" || value === null) return false
  const record = value as { readonly [key: string]: unknown }
  return typeof record.suite === "string" && typeof record.case === "string" && typeof record.scorer === "string" &&
    typeof record.stepKey === "string" && typeof record.score === "number" && Number.isFinite(record.score) &&
    record.score >= 0 && record.score <= 1
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => compareText(a, b)).map((
        [key, entry]
      ) => [key, canonical(entry)])
    )
  }
  return typeof value === "number" && Object.is(value, -0) ? 0 : value
}

const validate = (value: unknown): Effect.Effect<Baseline, EvalError> => {
  if (typeof value !== "object" || value === null) {
    return Effect.fail(new EvalError({ code: "invalid_baseline", message: "Baseline must be an object" }))
  }
  const artifact = value as { readonly version?: unknown; readonly records?: unknown }
  if (artifact.version !== version || !Array.isArray(artifact.records) || !artifact.records.every(isRecord)) {
    return Effect.fail(new EvalError({ code: "invalid_baseline", message: "Baseline version or records are invalid" }))
  }
  return Effect.succeed({ version, records: artifact.records })
}

/**
 * Builds and validates a baseline from a run's successful observations.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const fromRun = (run: RunResult): Effect.Effect<Baseline, EvalError> => {
  const records: Array<Record> = run.observations.flatMap((observation: Observation) =>
    observation.kind === "score"
      ? [{
        suite: run.suite,
        case: observation.case,
        scorer: observation.scorer,
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
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  baseline: Omit<Baseline, "version"> & { readonly version?: typeof version }
): Effect.Effect<Baseline, EvalError> => validate({ version: baseline.version ?? version, records: baseline.records })

/**
 * Serializes a baseline with recursively sorted keys and stable numbers.
 *
 * @category serialization
 * @since 0.1.0
 * @slop
 */
export const write = (baseline: Baseline): string => {
  const records = [...baseline.records].sort((left, right) =>
    compareText(
      `${left.suite}\u0000${left.case}\u0000${left.scorer}\u0000${left.stepKey}`,
      `${right.suite}\u0000${right.case}\u0000${right.scorer}\u0000${right.stepKey}`
    )
  )
  return `${JSON.stringify(canonical({ version: baseline.version, records }))}\n`
}

/**
 * Loads and validates canonical baseline JSON.
 *
 * @category serialization
 * @since 0.1.0
 * @slop
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
 * @slop
 */
export const parse = load
