/**
 * Vitest coverage runs.
 *
 * @since 0.1.0
 */
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"
import * as ToolBuild from "./ToolBuild.ts"

/**
 * Attributes for {@link VitestCoverage}.
 *
 * `cwd` is the workspace-relative directory the runner starts in and defaults
 * to the workspace root. The `config` path and `reportsDirectory` resolve
 * from `cwd` when the tool runs. `config`, `tests`, and `sources` are declared
 * inputs; `reportsDirectory` stays a string because it declares an output
 * path rather than referencing a file the target reads.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: PackageManager.PackageManager,
  tests: Schema.Array(Input.Declared),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  config: Schema.NullOr(Input.File),
  provider: Schema.Literals(["v8", "istanbul"]),
  reportsDirectory: Schema.NonEmptyString,
  thresholds: Schema.Struct({
    branches: Schema.Number,
    functions: Schema.Number,
    lines: Schema.Number,
    statements: Schema.Number
  }),
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  )
})

/**
 * Attributes for {@link VitestCoverage}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Result of one coverage run: the exec result plus the directory the run
 * wrote its coverage reports into, relative to `cwd`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CoverageReport = Schema.Struct({
  run: Exec.Result,
  reportsDirectory: Schema.NonEmptyString,
  /** The digested manifest of the written report tree. */
  outputs: Schema.Array(ToolBuild.Output)
})

/**
 * Result of one coverage run.
 *
 * @category models
 * @since 0.1.0
 */
export type CoverageReport = typeof CoverageReport.Type

/**
 * Plans `vitest run` with coverage and declares the coverage directory
 * output.
 *
 * The body records one {@link Exec.Exec} node that runs
 * `pnpm exec vitest run` from `cwd` with coverage enabled for the declared
 * provider, report directory, and thresholds, then the shared output-capture
 * step that digests the report tree into the CAS. A zero-exit run that wrote
 * no report fails the target rather than reporting success, and the captured
 * manifest is what lets a downstream target — or a cache replay — materialize
 * the reports. Key material contains test, source, and config digests,
 * dependency keys, coverage provider, report path, and thresholds. This models
 * tevm's `test:coverage` target and Vitest coverage. Executing the plan
 * requires {@link Exec.ExecLive} and {@link ToolBuild.CaptureOutputsLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const VitestCoverage = Target.make("VitestCoverage", {
  attrs: Attrs,
  kinds: ["test"],
  success: CoverageReport,
  error: ToolBuild.BuildError,
  outputs: (attrs) => ({ cwd: attrs.cwd, paths: [attrs.reportsDirectory] }),
  implementation: (attrs) =>
    Target.runTool({
      cwd: attrs.cwd,
      argv: PackageManager.exec(attrs.packageManager, [
        "vitest",
        "run",
        ...(attrs.config === null ? [] : ["--config", attrs.config.path]),
        "--coverage.enabled=true",
        `--coverage.provider=${attrs.provider}`,
        `--coverage.reportsDirectory=${attrs.reportsDirectory}`,
        `--coverage.thresholds.branches=${attrs.thresholds.branches}`,
        `--coverage.thresholds.functions=${attrs.thresholds.functions}`,
        `--coverage.thresholds.lines=${attrs.thresholds.lines}`,
        `--coverage.thresholds.statements=${attrs.thresholds.statements}`
      ])
    }).pipe(
      Node.andThen((run) =>
        ToolBuild.CaptureOutputs.call({ cwd: attrs.cwd, paths: [attrs.reportsDirectory] }).pipe(
          Node.map((captured) => ({
            run,
            reportsDirectory: attrs.reportsDirectory,
            outputs: captured.outputs
          }))
        )
      )
    )
})
