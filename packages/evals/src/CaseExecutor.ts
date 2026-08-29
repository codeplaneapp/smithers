/**
 * Injectable target-flow execution boundary.
 *
 * @see docs/specs/Concepts/Scoring.md
 * @since 0.1.0
 */
import type { Flow } from "@smthrs/core"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { EvalError } from "./EvalError.ts"
import type { Case } from "./Suite.ts"

/**
 * The result of executing one target-flow case.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Execution {
  readonly output: unknown
  readonly stepKey: string
  readonly latencyMs: number
  readonly target: Flow.Any
}

/**
 * Input accepted by a case executor.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type CaseInput = Case

/**
 * Runtime shape for an injectable target-flow executor.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly run: (suiteCase: CaseInput) => Effect.Effect<Execution, EvalError>
  readonly execute: (suiteCase: CaseInput) => Effect.Effect<Execution, EvalError>
}

/**
 * Implementation accepted by {@link make}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Implementation {
  readonly run?: ((suiteCase: CaseInput) => Effect.Effect<Execution, EvalError>) | undefined
  readonly execute?: ((suiteCase: CaseInput) => Effect.Effect<Execution, EvalError>) | undefined
}

/**
 * Injectable execution boundary for a target flow.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class CaseExecutor extends Context.Service<CaseExecutor, Service>()("flows/evals/CaseExecutor") {}

/**
 * Builds an executor; `run` and `execute` are aliases by design.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  implementation: Implementation | ((suiteCase: CaseInput) => Effect.Effect<Execution, EvalError>)
): Service => {
  const run = typeof implementation === "function" ? implementation : implementation.run ?? implementation.execute
  if (run === undefined) return makeNoop()
  return CaseExecutor.of({
    run,
    execute: implementation instanceof Function ? implementation : implementation.execute ?? run
  })
}

const unavailable = (suiteCase: CaseInput): Effect.Effect<Execution, EvalError> =>
  Effect.fail(new EvalError({ code: "executor", message: `No executor is available for case '${suiteCase.name}'` }))

/**
 * Builds an executor that fails with a typed executor error.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const run = unavailable
  return CaseExecutor.of({ run, execute: run, ...overrides })
}

/**
 * Provides the unavailable executor.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop: Layer.Layer<CaseExecutor> = Layer.succeed(CaseExecutor)(makeNoop())
