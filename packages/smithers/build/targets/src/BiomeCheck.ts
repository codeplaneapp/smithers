/**
 * Biome lint and formatting checks.
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

/**
 * Attributes for {@link BiomeCheck}.
 *
 * `cwd` is the workspace-relative directory the tool runs in and defaults to
 * the workspace root. The `config` path and every source path resolve from
 * `cwd` when the tool runs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  config: Input.File,
  lint: Schema.Boolean,
  format: Schema.Boolean,
  unsafe: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link BiomeCheck}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Result of one Biome target: the exec result of each enabled check family,
 * `null` for a family the attrs disabled.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BiomeReport = Schema.Struct({
  check: Schema.NullOr(Exec.Result),
  format: Schema.NullOr(Exec.Result)
})

/**
 * Result of one Biome target.
 *
 * @category models
 * @since 0.1.0
 */
export type BiomeReport = typeof BiomeReport.Type

const globMagic = /[*?[\]{}!()|@+]/

/**
 * Reduces declared sources to the path arguments Biome accepts.
 *
 * Biome walks paths itself and does not expand glob patterns, so a glob
 * contributes its static directory prefix, a file contributes its path, and
 * a git diff contributes nothing. With no usable source Biome checks `cwd`.
 */
const biomePaths = (sources: ReadonlyArray<Input.Declared>): ReadonlyArray<string> => {
  const paths: Array<string> = []
  for (const source of sources) {
    if (source._tag === "File") paths.push(source.path)
    if (source._tag !== "Glob") continue
    const segments: Array<string> = []
    for (const segment of source.pattern.split("/")) {
      if (globMagic.test(segment)) break
      segments.push(segment)
    }
    const prefix = segments.join("/")
    paths.push(prefix === "" ? "." : prefix)
  }
  const unique = [...new Set(paths)]
  return unique.length === 0 ? ["."] : unique
}

/**
 * Plans Biome lint and format checks without writing files.
 *
 * The body records one `biome check` run when `lint` is enabled and one
 * `biome format` run in its default check mode when `format` is enabled,
 * both from `cwd` through the shared {@link Exec.Exec} action with the
 * declared configuration passed as `--config-path`. When `unsafe` is true
 * the check run forwards `--unsafe`. Tools resolve through `pnpm exec`,
 * matching the pnpm workspace install target. Key material contains source
 * and configuration digests, dependency keys, enabled check families, and
 * unsafe-target policy. This combines tevm's `lint:check` and `format:check`
 * targets using Biome prior art. Executing the plan requires
 * {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const BiomeCheck = Target.make("BiomeCheck", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["lint"],
  success: BiomeReport,
  error: Exec.ExecError,
  implementation: (attrs) => {
    const shared = [`--config-path=${attrs.config.path}`, ...biomePaths(attrs.sources)]
    if (!attrs.lint) {
      return attrs.format
        ? Target.runTool({
          cwd: attrs.cwd,
          argv: PackageManager.exec(attrs.packageManager, ["biome", "format", ...shared])
        }).pipe(Node.map((format) => ({ check: null, format })))
        : Node.succeed({ check: null, format: null })
    }
    const checked = Target.runTool({
      cwd: attrs.cwd,
      argv: PackageManager.exec(attrs.packageManager, [
        "biome",
        "check",
        ...(attrs.unsafe ? ["--unsafe"] : []),
        ...shared
      ])
    })
    if (!attrs.format) {
      return checked.pipe(Node.map((check) => ({ check, format: null })))
    }
    return checked.pipe(
      Node.bindPlanned((check) =>
        Target.runTool({
          cwd: attrs.cwd,
          argv: PackageManager.exec(attrs.packageManager, ["biome", "format", ...shared]),
          after: check
        }).pipe(Node.map((format) => ({ check, format })))
      )
    )
  }
})
