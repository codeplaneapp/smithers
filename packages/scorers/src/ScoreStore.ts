/**
 * Durable score observation service.
 *
 * @see docs/specs/Concepts/Scoring.md
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { ScorerError } from "./ScorerError.ts"

/**
 * Fields shared by successful and inconclusive observations.
 *
 * @category models
 * @since 0.1.0
 */
export interface ObservationBase {
  readonly targetStepKey: string
  readonly scorerKey: string
  readonly at: number
}

/**
 * A successful score retained by the store.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScoreObservation extends ObservationBase {
  readonly kind: "score"
  readonly score: number
  readonly reason?: string | undefined
  readonly meta?: unknown
}

/**
 * A scorer failure retained without failing its target.
 *
 * @category models
 * @since 0.1.0
 */
export interface InconclusiveObservation extends ObservationBase {
  readonly kind: "inconclusive"
  readonly reason: string
}

/**
 * Durable scorer observation.
 *
 * @category models
 * @since 0.1.0
 */
export type Observation = ScoreObservation | InconclusiveObservation

/**
 * Aggregate over successful scores only.
 *
 * @category models
 * @since 0.1.0
 */
export interface Aggregate {
  readonly count: number
  readonly mean: number
  readonly min: number
}

/**
 * Durable score store implementation.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly record: (observation: Observation) => Effect.Effect<void, ScorerError>
  readonly recordOnce: (
    identity: string,
    observation: Observation
  ) => Effect.Effect<boolean, ScorerError>
  readonly observations: (
    targetStepKey: string,
    scorerKey?: string | undefined
  ) => Effect.Effect<ReadonlyArray<Observation>, ScorerError>
  readonly aggregate: (
    targetStepKey: string,
    scorerKey?: string | undefined
  ) => Effect.Effect<Aggregate | undefined, ScorerError>
}

/**
 * Context service for durable scorer observations.
 *
 * @category services
 * @since 0.1.0
 */
export class ScoreStore extends Context.Service<ScoreStore, Service>()("flows/scorers/ScoreStore") {}

/**
 * Constructs a score store.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (service: Service): Service => ScoreStore.of(service)

/**
 * Constructs an inoperative score store.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service =>
  ScoreStore.of({
    record: () => Effect.void,
    recordOnce: () => Effect.succeed(true),
    observations: () => Effect.succeed([]),
    aggregate: () => Effect.succeed(undefined)
  })

/**
 * Provides the inoperative score store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<ScoreStore> = Layer.succeed(ScoreStore)(makeNoop())
