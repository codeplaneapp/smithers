/**
 * A typed, journaled gate observation.
 *
 * A failed gate is never a harness crash: it is recorded in the journal and
 * projected into the next authored link's context so the model corrects it
 * (`packages/smithers/agent/chain/docs/contract.md`).
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * Which gate produced the observation, or which stage failed.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Kind = Schema.Literals([
  "shape",
  "fuel",
  "catalog",
  "call_failed",
  "script_failed",
  "denied"
])

/**
 * The decoded form of {@link Kind}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Kind = typeof Kind.Type

/**
 * One gate observation: its kind and the prose the next authoring reads.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Observation = Schema.Struct({
  kind: Kind,
  message: Schema.String
})

/**
 * The decoded form of {@link Observation}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Observation = typeof Observation.Type

/**
 * Builds an observation from its kind and message.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (kind: Kind, message: string): Observation => ({ kind, message })

/**
 * Renders an observation as one context line for the next author call.
 *
 * @category projections
 * @since 0.1.0
 * @slop
 */
export const render = (observation: Observation): string => `[${observation.kind}] ${observation.message}`
