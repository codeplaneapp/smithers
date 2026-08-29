/**
 * Scoped restart harness for the reference in-memory engine.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import {
  type EngineSubject as EngineSubjectService,
  EngineSubject as EngineSubjectTag,
  type ExecutionResult
} from "./EngineSubject.ts"
import { type EngineStore, make as makeMemoryEngine, makeStore } from "./MemoryEngine.ts"
import type { EngineSubjectError, EngineUnavailableError } from "./TestingError.ts"

interface EngineInstance {
  readonly engine: EngineSubjectService
  readonly scope: Scope.Closeable
}

/**
 * A stable engine facade and controls for replacing its live in-memory
 * instance while retaining the persistent execution store.
 *
 * @category models
 * @since 0.0.0
 */
export interface Restartable {
  readonly engine: EngineSubjectService
  readonly restart: Effect.Effect<void, EngineUnavailableError>
  readonly killAndResume: (
    executionId: string
  ) => Effect.Effect<ExecutionResult, EngineSubjectError>
}

const buildInstance = (
  store: EngineStore
): Effect.Effect<EngineInstance> =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const engine = yield* makeMemoryEngine(store).pipe(Scope.provide(scope))
    return { engine, scope }
  })

/**
 * Constructs a restartable engine over one persistent `MemoryEngine` store.
 *
 * `restart` closes the current instance scope, interrupting all of its live
 * execution fibers, and then constructs a fresh engine over the same store.
 * The exposed engine is a stable facade that always delegates to the current
 * instance.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (): Effect.Effect<
  Restartable,
  EngineUnavailableError,
  Scope.Scope
> =>
  Effect.gen(function*() {
    const store = yield* makeStore()
    const initial = yield* buildInstance(store)
    const current = yield* Ref.make(initial)

    yield* Effect.addFinalizer((exit) =>
      Ref.get(current).pipe(
        Effect.flatMap((instance) => Scope.close(instance.scope, exit))
      )
    )

    const restart: Effect.Effect<void, EngineUnavailableError> = Effect.gen(function*() {
      const previous = yield* Ref.get(current)
      yield* Scope.close(previous.scope, Exit.void)
      const next = yield* buildInstance(store)
      yield* Ref.set(current, next)
    })

    const withEngine = <A>(
      f: (engine: EngineSubjectService) => Effect.Effect<A, EngineSubjectError>
    ): Effect.Effect<A, EngineSubjectError> =>
      Ref.get(current).pipe(
        Effect.flatMap((instance) => f(instance.engine))
      )

    const engine = EngineSubjectTag.of({
      name: "RestartableEngine",
      run: (options) => withEngine((subject) => subject.run(options)),
      result: (executionId) => withEngine((subject) => subject.result(executionId)),
      interrupt: (executionId) => withEngine((subject) => subject.interrupt(executionId)),
      resume: (executionId) => withEngine((subject) => subject.resume(executionId)),
      journal: (executionId) => withEngine((subject) => subject.journal(executionId))
    })

    return {
      engine,
      restart,
      killAndResume: (executionId) =>
        restart.pipe(
          Effect.andThen(withEngine((subject) => subject.resume(executionId)))
        )
    }
  })
