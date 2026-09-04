/**
 * Configurable in-memory supervision runtime for tests.
 *
 * @since 0.1.0
 */
import { Effect, Layer } from "effect"
import * as SuperviseRuntime from "../SuperviseRuntime.ts"

/**
 * Configuration for a test supervision runtime.
 *
 * @since 0.1.0
 * @category models
 */
export interface TestSuperviseRuntimeOptions {
  readonly candidates?: ReadonlyArray<SuperviseRuntime.Candidate>
  readonly resumeError?: SuperviseRuntime.ResumeError | undefined
}

/**
 * Controllable supervision runtime with recorded resume leases.
 *
 * @since 0.1.0
 * @category models
 */
export interface TestSuperviseRuntime {
  readonly runtime: SuperviseRuntime.Service
  readonly resumes: ReadonlyArray<SuperviseRuntime.ResumeLease>
  readonly setCandidates: (candidates: ReadonlyArray<SuperviseRuntime.Candidate>) => Effect.Effect<void>
  readonly setResumeError: (error: SuperviseRuntime.ResumeError | undefined) => Effect.Effect<void>
}

/**
 * Constructs a configurable in-memory supervision runtime.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options: TestSuperviseRuntimeOptions = {}): TestSuperviseRuntime => {
  let candidates = options.candidates ?? []
  let resumeError = options.resumeError
  const resumes: Array<SuperviseRuntime.ResumeLease> = []
  const runtime = SuperviseRuntime.make({
    scan: Effect.fn("SuperviseRuntime.scan")(() => Effect.sync(() => candidates)),
    resume: Effect.fn("SuperviseRuntime.resume")((lease) =>
      Effect.sync(() => {
        resumes.push(lease)
      }).pipe(Effect.andThen(resumeError === undefined ? Effect.void : Effect.fail(resumeError)))
    )
  })
  return {
    runtime,
    resumes,
    setCandidates: (next) =>
      Effect.sync(() => {
        candidates = next
      }),
    setResumeError: (next) =>
      Effect.sync(() => {
        resumeError = next
      })
  }
}

/**
 * Provides a configurable in-memory supervision runtime and exposes controls.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  options: TestSuperviseRuntimeOptions = {},
  onReady: (testRuntime: TestSuperviseRuntime) => void = () => {}
): Layer.Layer<SuperviseRuntime.SuperviseRuntime> =>
  Layer.effect(
    SuperviseRuntime.SuperviseRuntime,
    Effect.sync(() => make(options)).pipe(
      Effect.tap((testRuntime) => Effect.sync(() => onReady(testRuntime))),
      Effect.map((testRuntime) => testRuntime.runtime)
    )
  )
