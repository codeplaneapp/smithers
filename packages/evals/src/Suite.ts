/**
 * Fixed evaluation suite declarations.
 *
 * @see docs/specs/Concepts/Scoring.md
 * @since 0.1.0
 */
import type * as ScorerBinding from "@smthrs/scorers/Binding"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EvalError } from "./EvalError.ts"

/**
 * A scorer binding accepted from `/scorers`.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Binding = ScorerBinding.Binding

/**
 * One immutable fixed-suite case.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Case {
  readonly name: string
  readonly input: unknown
  readonly expected?: unknown | undefined
}

/**
 * Alias for a fixed-suite case.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SuiteCase = Case

/**
 * Options for constructing a suite.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MakeOptions {
  readonly name: string
  readonly cases: ReadonlyArray<Case>
  readonly bindings?: ReadonlyArray<Binding> | undefined
  readonly concurrency: number
}

/**
 * Alias for suite construction options.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SuiteOptions = MakeOptions

/**
 * A validated, named collection of fixed cases and scorer bindings.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Suite {
  readonly name: string
  readonly cases: ReadonlyArray<Case>
  readonly bindings: ReadonlyArray<Binding>
  readonly concurrency: number
}

const invalid = (message: string, cause?: unknown): EvalError =>
  new EvalError({ code: "invalid_suite", message, ...(cause === undefined ? {} : { cause }) })

const validate = (options: MakeOptions): EvalError | undefined => {
  if (options.name.trim().length === 0) return invalid("Suite name must not be empty")
  if (options.cases.length === 0) return invalid("Suite must contain at least one case")
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    return invalid("Suite concurrency must be a positive safe integer")
  }
  const names = new Set<string>()
  for (const suiteCase of options.cases) {
    if (suiteCase.name.trim().length === 0) return invalid("Suite case name must not be empty")
    if (names.has(suiteCase.name)) return invalid(`Duplicate suite case: ${suiteCase.name}`)
    names.add(suiteCase.name)
  }
  return undefined
}

/**
 * Builds and validates a fixed suite.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: MakeOptions): Effect.Effect<Suite, EvalError> => {
  const error = validate(options)
  return error === undefined
    ? Effect.succeed({
      name: options.name,
      cases: options.cases.map((suiteCase) => ({ ...suiteCase })),
      bindings: [...(options.bindings ?? [])],
      concurrency: options.concurrency
    })
    : Effect.fail(error)
}

/**
 * Options used when decoding JSON Lines.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface JsonLinesOptions {
  readonly name: string
  readonly bindings?: ReadonlyArray<Binding> | undefined
  readonly concurrency: number
}

const jsonCase = Schema.Struct({
  name: Schema.String,
  input: Schema.Unknown,
  expected: Schema.optional(Schema.Unknown)
})

/**
 * Loads the `{ name, input, expected? }` JSON Lines fixture format.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const fromJsonLines = (text: string, options: JsonLinesOptions): Effect.Effect<Suite, EvalError> =>
  Effect.gen(function*() {
    const cases: Array<Case> = []
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const decoded = yield* Effect.try({
        try: () => JSON.parse(trimmed) as unknown,
        catch: (cause) => invalid(`Invalid JSON on line ${index + 1}`, cause)
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(jsonCase)),
        Effect.mapError((cause) =>
          cause instanceof EvalError ? cause : invalid(`Invalid suite case on line ${index + 1}`, cause)
        )
      )
      cases.push(decoded)
    }
    return yield* make({ ...options, cases })
  })
