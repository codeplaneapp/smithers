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
import { Effect, Layer } from "effect"
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
 * Runs the retention pass over every database this project has.
 *
 * A project with no `.flows/` reports an empty sweep rather than failing: `gc`
 * on a project that has never run anything is a no-op, not an error.
 *
 * @category constructors
 * @since 1.0.0
 */
export const sweep = (
  root: string,
  options: { readonly olderThan: string; readonly dryRun: boolean; readonly now?: number | undefined }
): Effect.Effect<
  { readonly olderThan: string; readonly dryRun: boolean; readonly reports: ReadonlyArray<Retention.Report> },
  CliError.UsageError
> =>
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
    const reports = yield* Effect.forEach(databases(root), (file) =>
      Retention.collect({ olderThanMs, dryRun: options.dryRun, database: file }).pipe(
        Effect.provide(NodeDatabase.layer({ filename: file })),
        // A database this pass cannot open is reported as an empty sweep of
        // that file rather than failing the whole command: the other database
        // still has work to do, and `gc` must not be the command that cannot
        // run because something else holds a lock.
        Effect.catchCause(() =>
          Effect.succeed<Retention.Report>({
            database: file,
            olderThanMs,
            runs: [],
            deleted: {},
            dryRun: options.dryRun
          })
        ),
        Effect.provide(Layer.empty)
      ))
    return { olderThan: options.olderThan, dryRun: options.dryRun, reports }
  })
