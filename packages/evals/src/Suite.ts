/**
 * Fixed evaluation suite declarations.
 *
 * A suite is the fixed input half of an evaluation: named cases, the scorer
 * bindings that grade them, and the concurrency the runner is allowed. It is
 * validated once and then never changes, because the run that produced a
 * committed baseline has to be reproducible from the suite value that was
 * validated.
 *
 * @since 0.1.0
 */
import type * as ScorerBinding from "@smthrs/scorers/Binding"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EvalError } from "./EvalError.ts"

/**
 * A scorer binding accepted from `/scorers`.
 *
 * The binding's `appliesTo` flow is matched against an execution's `target` by
 * reference identity, so a binding only ever grades the exact flow value it was
 * declared against.
 *
 * @category models
 * @since 0.1.0
 */
export type Binding = ScorerBinding.Binding

/**
 * One immutable fixed-suite case.
 *
 * `input` is handed to the executor and `expected` is offered to a bound scorer
 * as ground truth when the binding declares none of its own. Both are snapshots
 * taken by {@link make}: mutating the object a caller passed in never changes
 * the suite.
 *
 * @category models
 * @since 0.1.0
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
 */
export type SuiteCase = Case

/**
 * Options for constructing a suite.
 *
 * @category models
 * @since 0.1.0
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
 */
export type SuiteOptions = MakeOptions

/**
 * A validated, named collection of fixed cases and scorer bindings.
 *
 * `cases` and `bindings` are frozen, and every data field they carry is a copy
 * the caller cannot reach.
 *
 * @category models
 * @since 0.1.0
 */
export interface Suite {
  readonly name: string
  readonly cases: ReadonlyArray<Case>
  readonly bindings: ReadonlyArray<Binding>
  readonly concurrency: number
}

/**
 * The declared ceilings a suite is validated against.
 *
 * They exist so a mistake fails at construction with a sentence instead of
 * exhausting memory in a runner: `concurrency` bounds the fibers a run may hold
 * open, `cases` bounds one suite, and `fixtureLength` bounds one JSON Lines
 * fixture.
 *
 * @category models
 * @since 0.1.0
 */
export const limits = {
  concurrency: 1024,
  cases: 10_000,
  /** Longest JSON Lines fixture, in UTF-16 code units. */
  fixtureLength: 8 * 1024 * 1024
} as const

const invalid = (message: string, path: string, cause?: unknown): EvalError =>
  new EvalError({ code: "invalid_suite", message, path, ...(cause === undefined ? {} : { cause }) })

// A NUL in a name silently collides with the delimiter every tuple key used to
// be joined on. The keys are injective now, but a control character in a name
// still corrupts a Markdown report and a CI log line, so it is rejected here,
// once, where the name enters the system.
const controlCharacter = (value: string): string | undefined => {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`
  }
  return undefined
}

const clone = (value: unknown, path: string): Effect.Effect<unknown, EvalError> =>
  Effect.try({
    try: () => structuredClone(value),
    catch: (cause) =>
      invalid(
        "Suite data must be structured-cloneable so the suite cannot change after it is validated",
        path,
        cause
      )
  })

const validate = (options: MakeOptions): EvalError | undefined => {
  if (options.name.trim().length === 0) return invalid("Suite name must not be empty", "name")
  const nameControl = controlCharacter(options.name)
  if (nameControl !== undefined) {
    return invalid(`Suite name must not contain the control character ${nameControl}`, "name")
  }
  if (options.cases.length === 0) return invalid("Suite must contain at least one case", "cases")
  if (options.cases.length > limits.cases) {
    return invalid(`Suite must contain at most ${limits.cases} cases, got ${options.cases.length}`, "cases")
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    return invalid(
      `Suite concurrency must be a positive safe integer, got ${String(options.concurrency)}`,
      "concurrency"
    )
  }
  if (options.concurrency > limits.concurrency) {
    return invalid(
      `Suite concurrency must be at most ${limits.concurrency}, got ${options.concurrency}`,
      "concurrency"
    )
  }
  const names = new Set<string>()
  for (const [index, suiteCase] of options.cases.entries()) {
    if (suiteCase.name.trim().length === 0) {
      return invalid("Suite case name must not be empty", `cases[${index}].name`)
    }
    const caseControl = controlCharacter(suiteCase.name)
    if (caseControl !== undefined) {
      return invalid(
        `Suite case name must not contain the control character ${caseControl}`,
        `cases[${index}].name`
      )
    }
    if (names.has(suiteCase.name)) {
      return invalid(`Duplicate suite case: ${suiteCase.name}`, `cases[${index}].name`)
    }
    names.add(suiteCase.name)
  }
  return undefined
}

const copyCase = (suiteCase: Case, index: number): Effect.Effect<Case, EvalError> =>
  Effect.gen(function*() {
    const input = yield* clone(suiteCase.input, `cases[${index}].input`)
    if (suiteCase.expected === undefined) return { name: suiteCase.name, input }
    const expected = yield* clone(suiteCase.expected, `cases[${index}].expected`)
    return { name: suiteCase.name, input, expected }
  })

const copyBinding = (binding: Binding, index: number): Effect.Effect<Binding, EvalError> =>
  Effect.gen(function*() {
    // `scorer` and `appliesTo` are executable identities matched by reference,
    // so they are carried over unchanged; only the inert data is snapshotted.
    const copied: { -readonly [K in keyof Binding]: Binding[K] } = {
      scorer: binding.scorer,
      appliesTo: binding.appliesTo,
      sampling: binding.sampling
    }
    if (binding.groundTruth !== undefined) {
      copied.groundTruth = yield* clone(binding.groundTruth, `bindings[${index}].groundTruth`)
    }
    if (binding.context !== undefined) {
      copied.context = yield* clone(binding.context, `bindings[${index}].context`)
    }
    return copied
  })

/**
 * Builds and validates a fixed suite.
 *
 * Every case and binding is copied, so the suite is a snapshot the caller can
 * no longer reach: mutating the array or the input object that was passed in
 * leaves the validated suite unchanged. The copy is a `structuredClone`, which
 * is also the check that the data is inert; a case carrying a function or a
 * class instance fails with `invalid_suite` naming the offending path.
 *
 * Fails with `invalid_suite` for an empty or control-character name, no cases,
 * more than `limits.cases` cases, a duplicate case name, or a concurrency that
 * is not a safe integer in `[1, limits.concurrency]`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Effect.Effect<Suite, EvalError> => {
  const error = validate(options)
  if (error !== undefined) return Effect.fail(error)
  return Effect.gen(function*() {
    const cases = yield* Effect.forEach(options.cases, copyCase)
    const bindings = yield* Effect.forEach(options.bindings ?? [], copyBinding)
    return {
      name: options.name,
      cases: Object.freeze(cases),
      bindings: Object.freeze(bindings),
      concurrency: options.concurrency
    }
  })
}

/**
 * Options used when decoding JSON Lines.
 *
 * @category models
 * @since 0.1.0
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
 * Blank lines are skipped, a leading byte-order mark is stripped, and both LF
 * and CRLF terminate a line. A malformed line fails with `invalid_suite`
 * carrying the 1-based line number in both the message and the path; a fixture
 * larger than `limits.fixtureLength` is rejected before any of it is parsed.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromJsonLines = (text: string, options: JsonLinesOptions): Effect.Effect<Suite, EvalError> =>
  Effect.gen(function*() {
    if (text.length > limits.fixtureLength) {
      return yield* Effect.fail(
        invalid(
          `JSON Lines fixture must be at most ${limits.fixtureLength} characters, got ${text.length}`,
          "text"
        )
      )
    }
    const cases: Array<Case> = []
    const body = text.startsWith("\uFEFF") ? text.slice(1) : text
    for (const [index, line] of body.split(/\r?\n/).entries()) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const decoded = yield* Effect.try({
        try: () => JSON.parse(trimmed) as unknown,
        catch: (cause) => invalid(`Invalid JSON on line ${index + 1}`, `line[${index + 1}]`, cause)
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(jsonCase)),
        Effect.mapError((cause) =>
          cause instanceof EvalError
            ? cause
            : invalid(`Invalid suite case on line ${index + 1}`, `line[${index + 1}]`, cause)
        )
      )
      cases.push(decoded)
    }
    return yield* make({ ...options, cases })
  })
