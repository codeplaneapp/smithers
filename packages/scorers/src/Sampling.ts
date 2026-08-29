/**
 * Replay-stable scorer sampling.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ScorerError } from "./ScorerError.ts"

/**
 * Sampling policy for a scorer binding.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Sampling = Schema.Union([
  Schema.Literals(["all", "none"]),
  Schema.Struct({ ratio: Schema.Finite, seed: Schema.String })
])

/**
 * Sampling policy for a scorer binding.
 *
 * @category models
 * @since 0.1.0
 */
export type Sampling = typeof Sampling.Type

const hash = (text: string): number => {
  let value = 2166136261
  for (const character of text) {
    value ^= character.charCodeAt(0)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0) / 4294967296
}

const invalid = (cause?: unknown): ScorerError =>
  new ScorerError({
    code: "invalid_sampling",
    message: "Sampling ratio must be strictly between zero and one",
    ...(cause === undefined ? {} : { cause })
  })

/**
 * Decides a ratio sample from stable target, scorer, and seed material.
 *
 * @category predicates
 * @since 0.1.0
 */
export const decide = (
  sampling: Sampling,
  targetStepKey: string,
  scorerKey: string
): Effect.Effect<boolean, ScorerError> =>
  Schema.decodeUnknownEffect(Sampling)(sampling).pipe(
    Effect.mapError(invalid),
    Effect.flatMap((value) => {
      if (value === "all") return Effect.succeed(true)
      if (value === "none") return Effect.succeed(false)
      return value.ratio > 0 && value.ratio < 1
        ? Effect.succeed(hash(`${targetStepKey}:${scorerKey}:${value.seed}`) < value.ratio)
        : Effect.fail(invalid())
    })
  )
