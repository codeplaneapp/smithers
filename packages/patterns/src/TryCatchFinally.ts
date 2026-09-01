/**
 * Scoped error boundary: a protected body, a filtered recovery arm, and a
 * finalizer that runs on every path.
 *
 * `Node.catch` alone recovers a typed failure. This pattern adds the third
 * arm: cleanup that runs after success, after recovery, and after a failure no
 * handler claimed. The declaration shows the finalizer on both arms, so a
 * reader sees that nothing leaves the boundary without it.
 *
 * @see docs/pages/concepts/failure-and-retry.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { PatternError } from "./PatternError.ts"

/**
 * Configuration for {@link make}.
 *
 * `catch` receives `{ error, input }`; `finally` receives `{ input }`.
 * `catchErrors` selects which typed failures reach `catch`; without it the
 * whole error channel does. Supplying `catchErrors` requires `catch`.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly try: Flow.Any
  readonly catch?: Flow.Any | undefined
  readonly catchErrors?: Schema.Top | undefined
  readonly finally?: Flow.Any | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * `catchErrors` is a predicate rather than a schema, because the runtime form
 * already holds the decoded typed error. Supplying it requires `catch`.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, E, R, B = A, E2 = never, R2 = never, E3 = never, R3 = never> {
  readonly try: (input: I) => Effect.Effect<A, E, R>
  readonly catch?: ((error: E, input: I) => Effect.Effect<B, E2, R2>) | undefined
  readonly catchErrors?: ((error: E) => boolean) | undefined
  readonly finally?: ((input: I) => Effect.Effect<unknown, E3, R3>) | undefined
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

/**
 * Declares the boundary: the protected call, the filtered recovery arm, and a
 * finalizer call on the settled arm and on the unhandled-failure arm.
 *
 * The unhandled arm ends in `Node.fail`, so the plan states that the finalizer
 * cleans up and hands the failure back rather than absorbing it. That boundary
 * protects the body alone; the settled arm's finalizer is sequenced after it,
 * so a finalizer that fails on the success path is not re-run by the arm meant
 * for the body's failures.
 *
 * Both recovery arms are wrapped in `Node.capture`, so every node this
 * declaration builds keys the same way on every build. An uncaptured arm would
 * take process-local identity and re-key the boundary on each build, which
 * content-addressed step identity cannot tolerate.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  if (options.catchErrors !== undefined && options.catch === undefined) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "TryCatchFinally catchErrors requires catch"
    })
  }
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [
      options.try,
      ...(options.catch === undefined ? [] : [options.catch]),
      ...(options.finally === undefined ? [] : [options.finally])
    ],
    body: Node.capture(
      { catch: options.catch !== undefined, finally: options.finally !== undefined },
      (input) => {
        const finalize = options.finally
        const settle = (value: unknown): Node.Node<unknown, unknown> =>
          finalize === undefined
            ? Node.succeed(value)
            : Node.map(call(finalize, { input }), Node.capture({ settled: true }, () => value))
        const attempt = call(options.try, input)
        const handler = options.catch
        const recover = (handled: Flow.Any) => {
          const onFailure = Node.capture(
            { handled: true },
            (error: unknown): Node.Node<unknown, unknown> => call(handled, { error, input })
          )
          const filter = options.catchErrors as Schema.Schema<unknown> | undefined
          return filter === undefined
            ? Node.catch(attempt, { onFailure })
            : Node.catch(attempt, { error: filter, onFailure })
        }
        const recovered = handler === undefined ? attempt : recover(handler)
        // The unhandled-failure boundary wraps the BODY alone. Sequencing the
        // success-arm finalizer after it, rather than inside it, keeps the
        // declaration honest: a finalizer that fails on the success path is
        // not caught here and re-run, which is exactly what `run` does.
        const guarded = finalize === undefined ? recovered : Node.catch(recovered, {
          onFailure: Node.capture(
            { rethrow: true },
            (error: unknown) =>
              Node.andThen(
                call(finalize, { input }),
                Node.capture({ rethrow: true }, () => Node.fail(error))
              )
          )
        })
        return Node.andThen(guarded, Node.capture({ settled: true }, (value) => settle(value)))
      }
    )
  })
}

/**
 * Runs the boundary.
 *
 * The finalizer runs after success, after recovery, after an unclaimed
 * failure, and after interruption. A finalizer that fails on its own becomes
 * `PatternError { code: "finalizer_failed" }`; a body failure outranks it, so
 * cleanup trouble never hides the reason the body failed.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, A, E, R, B = A, E2 = never, R2 = never, E3 = never, R3 = never>(
  input: I,
  options: RuntimeOptions<I, A, E, R, B, E2, R2, E3, R3>
): Effect.Effect<A | B, E | E2 | PatternError, R | R2 | R3> => {
  if (options.catchErrors !== undefined && options.catch === undefined) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "TryCatchFinally catchErrors requires catch"
      })
    )
  }
  const handler = options.catch
  const guarded: Effect.Effect<A | B, E | E2, R | R2> = handler === undefined
    ? options.try(input)
    : Effect.catchIf(
      options.try(input),
      (error): error is E => options.catchErrors === undefined || options.catchErrors(error),
      (error) => handler(error, input)
    )
  const finalize = options.finally
  if (finalize === undefined) return guarded
  return Effect.onExit(guarded, (exit) =>
    Effect.matchEffect(finalize(input), {
      onFailure: (error) =>
        Exit.isSuccess(exit)
          ? Effect.fail(
            new PatternError({
              code: "finalizer_failed",
              message: "The TryCatchFinally finalizer failed after the protected body succeeded",
              cause: error
            })
          )
          : Effect.void,
      onSuccess: () => Effect.void
    }))
}
