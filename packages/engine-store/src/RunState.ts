/**
 * The envelope a durable run's state is persisted inside.
 *
 * The engine never stores a flow's payload bare — it wraps it in a versioned
 * struct, so a store row written by an older build decodes under a known
 * shape instead of being guessed at. `version` is a literal rather than a
 * number for exactly that reason: a future revision adds a new literal and
 * both remain decodable.
 *
 * Time travel reads these rows too, deriving the state AT a frame by
 * replaying run-decision records rather than trusting the row's latest value.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/** @private */
const PositiveSafeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * The versioned state stored for a durable flow run: which flow it is, the
 * encoded `payload` it was started with, and — as they arrive — its
 * `result` and its cancellation timestamp.
 *
 * `parentExecutionId` is present only on a child run, and is what makes a
 * spawned subflow reachable from the run that spawned it.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const RunState = Schema.Struct({
  version: Schema.Literal(1),
  flowName: Schema.NonEmptyString,
  payload: Schema.Unknown,
  parentExecutionId: Schema.optionalKey(Schema.NonEmptyString),
  maxRounds: Schema.optionalKey(PositiveSafeInt),
  result: Schema.optionalKey(Schema.Unknown),
  cancellation: Schema.optionalKey(Schema.Struct({
    interruptedAtMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
  }))
})

/**
 * The value form of {@link RunState}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type RunState = typeof RunState.Type
