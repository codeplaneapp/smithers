/**
 * Runner-independent conformance cases for flow engine implementations.
 *
 * @since 0.0.0
 */
import type * as Effect from "effect/Effect"
import type { EngineSubject } from "./EngineSubject.ts"
import * as Identity from "./pins/Identity.ts"
import * as Interrupt from "./pins/Interrupt.ts"
import * as Race from "./pins/Race.ts"
import * as Replay from "./pins/Replay.ts"

/**
 * A black-box assertion over an {@link EngineSubject} implementation.
 *
 * @category models
 * @since 0.0.0
 */
export interface ConformanceCase {
  readonly name: string
  readonly run: (engine: EngineSubject) => Effect.Effect<void, unknown>
}

const coreCases: ReadonlyArray<ConformanceCase> = [
  ...Identity.cases,
  ...Interrupt.cases,
  ...Replay.cases,
  ...Race.cases
]

/**
 * Builds the mandatory black-box suite every `EngineSubject` must pass.
 *
 * @category constructors
 * @since 0.0.0
 */
export const coreSuite = (options?: {
  readonly filter?: ((conformanceCase: ConformanceCase) => boolean) | undefined
}): ReadonlyArray<ConformanceCase> => options?.filter === undefined ? coreCases : coreCases.filter(options.filter)

/**
 * Builds the complete engine conformance suite.
 *
 * @category constructors
 * @since 0.0.0
 */
export const suite = (options?: {
  readonly filter?: ((conformanceCase: ConformanceCase) => boolean) | undefined
}): ReadonlyArray<ConformanceCase> => {
  return coreSuite(options)
}
