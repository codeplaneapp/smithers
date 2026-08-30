/**
 * `smithers gc`: the retention pass, over this project's databases.
 *
 * `@smthrs/engine-store`'s `Retention` owns what a pass deletes; this module
 * owns which files it runs against and how an operator spells the threshold.
 * A project has two databases — the control plane's and the engine's — and a
 * sweep of one without the other leaves half of a deleted run behind.
 *
 * @since 1.0.0
 */
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Retention from "@smthrs/engine-store/Retention"
import { Cause, Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import * as CliError from "./CliError.ts"
import * as Project from "./Project.ts"

/**
 * How long history is kept when `--older-than` is omitted.
 *
 * Thirty days, because the question a retained run answers is "what did the
 * agent do to this repository", and that question is asked in the weeks after
 * a change lands, not the hours.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultRetention = "30d"

const units: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000
}

/**
 * Parses a duration such as `30d`, `12h`, or `90m` into milliseconds.
 *
 * @category constructors
 * @since 1.0.0
 */
export const duration = (value: string): number | undefined => {
  const match = /^(\d+)\s*(s|m|h|d|w)$/.exec(value.trim())
  if (match === null) return undefined
  const scale = units[match[2]!]
  return scale === undefined ? undefined : Number.parseInt(match[1]!, 10) * scale
}

/**
 * The databases a sweep runs against, in the order it runs them.
 *
 * @category getters
 * @since 1.0.0
 */
export const databases = (root: string): ReadonlyArray<string> =>
  ["control.db", "engine.db"]
    .map((name) => join(Project.stateDirectory(root), name))
    .filter((file) => existsSync(file))

/**
 * One database the sweep could not open, and why.
 *
 * @category models
 * @since 1.0.0
 */
export interface Failure {
  readonly database: string
  readonly reason: string
}

/**
 * What one sweep did, and what it could not do.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sweep {
  readonly olderThan: string
  readonly dryRun: boolean
  readonly reports: ReadonlyArray<Retention.Report>
  /** Databases the pass could not open. Empty on a clean sweep. */
  readonly failures: ReadonlyArray<Failure>
}

/**
 * Runs the retention pass over every database this project has.
 *
 * A project with no `.flows/` reports an empty sweep rather than failing: `gc`
 * on a project that has never run anything is a no-op, not an error. That is
 * the only empty sweep this function reports. A database it could not open is
 * a {@link Failure}, never a report of zero runs: `gc --dry-run` is trusted to
 * name exactly what a real pass would delete, and a locked or corrupt file
 * rendered as `{ runs: [] }` reads as "there is nothing to collect".
 *
 * The other databases are still swept, so one unreadable file does not stop
 * the command. The caller decides the exit status from `failures`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const sweep = (
  root: string,
  options: { readonly olderThan: string; readonly dryRun: boolean; readonly now?: number | undefined }
): Effect.Effect<Sweep, CliError.UsageError> =>
  Effect.gen(function*() {
    const window = duration(options.olderThan)
    if (window === undefined) {
      return yield* Effect.fail(
        new CliError.UsageError({
          message: `--older-than must be a duration such as 30d, 12h, or 90m; got ${options.olderThan}`
        })
      )
    }
    const olderThanMs = (options.now ?? Date.now()) - window
    const swept = yield* Effect.forEach(databases(root), (file) =>
      Retention.collect({ olderThanMs, dryRun: options.dryRun, database: file }).pipe(
        Effect.provide(NodeDatabase.layer({ filename: file })),
        Effect.map((report): Retention.Report | Failure =>
          report
        ),
        Effect.catchCause((cause) => Effect.succeed<Failure>({ database: file, reason: reasonOf(cause) })),
        Effect.provide(Layer.empty)
      ))
    return {
      olderThan: options.olderThan,
      dryRun: options.dryRun,
      reports: swept.filter((entry): entry is Retention.Report => !isFailure(entry)),
      failures: swept.filter(isFailure)
    }
  })

const isFailure = (entry: Retention.Report | Failure): entry is Failure =>
  (entry as { readonly reason?: unknown }).reason !== undefined

/** The one sentence a reader can act on, out of whatever the open threw. */
const reasonOf = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause)
  if (squashed instanceof Error) return squashed.message
  if (typeof squashed === "object" && squashed !== null && "message" in squashed) {
    return String((squashed as { readonly message: unknown }).message)
  }
  return String(squashed)
}

/**
 * The stderr paragraph a sweep with failures owes its operator.
 *
 * @category constructors
 * @since 1.0.0
 */
export const failureMessage = (failures: ReadonlyArray<Failure>): string =>
  `gc could not open ${failures.length} database${failures.length === 1 ? "" : "s"}, so nothing was collected ` +
  `from ${failures.length === 1 ? "it" : "them"}:\n` +
  failures.map((failure) => `  ${failure.database}: ${failure.reason}`).join("\n")
