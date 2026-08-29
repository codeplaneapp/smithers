/**
 * JavaScript distribution builds for TypeScript packages.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"
import { BuildError, captureOutputs, Outputs } from "./ToolBuild.ts"

/**
 * Schema for a distribution built by the TypeScript compiler.
 *
 * The tsconfig owns every emit option, so this variant carries no flags of its
 * own. It carries no `external` in particular: `tsc` resolves imports through
 * the tsconfig and has no bundle to exclude a package from, so an external list
 * declared beside it would be text that changes the key and nothing else.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TscTool = Schema.Struct({
  name: Schema.Literal("tsc")
})

/**
 * A distribution built by the TypeScript compiler.
 *
 * @category models
 * @since 0.1.0
 */
export type TscTool = typeof TscTool.Type

/**
 * Schema for a distribution built by tsup.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TsupTool = Schema.Struct({
  name: Schema.Literal("tsup"),
  /** Packages the bundle must not inline, forwarded as `--external`. */
  external: Schema.Array(Schema.NonEmptyString)
})

/**
 * A distribution built by tsup.
 *
 * @category models
 * @since 0.1.0
 */
export type TsupTool = typeof TsupTool.Type

/**
 * Schema for the tool one distribution build runs.
 *
 * A discriminated union rather than one name and a flat bag of flags, so a
 * declaration cannot carry a flag the selected tool never reads.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Tool = Schema.Union([TscTool, TsupTool])

/**
 * The tool one distribution build runs.
 *
 * @category models
 * @since 0.1.0
 */
export type Tool = typeof Tool.Type

/**
 * Attributes for {@link TsBuild}.
 *
 * `cwd` is the workspace-relative package directory the tool runs in and
 * defaults to the workspace root, so `tsconfig`, `entries`, and `outDir`
 * stay package-relative. `tsconfig` and `entries` are declared input files;
 * `outDir` stays a string because it declares an output path rather than
 * referencing a file the target reads.
 *
 * `entries` and `format` sit beside `tool` rather than inside its `tsup`
 * variant because `PackageJson` derives a published package's `exports` from
 * them whichever tool built the distribution.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: PackageManager.PackageManager,
  srcs: Schema.Array(Input.Declared),
  entries: Schema.Array(Input.File),
  deps: Schema.Array(Target.Target),
  tsconfig: Input.File,
  tool: Tool,
  format: Schema.Literals(["esm", "cjs", "dual"]),
  outDir: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link TsBuild}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Builds the distribution argv from decoded attrs at plan time.
 *
 * Tools resolve through `pnpm exec`, matching the pnpm workspace install
 * target. For `tsc` the tsconfig owns every emit option, so `format`,
 * `entries`, and `outDir` stay declared key material. For `tsup` those attrs
 * map to their CLI flags.
 */
const buildArgv = (attrs: Attrs): ReadonlyArray<string> =>
  attrs.tool.name === "tsc"
    ? PackageManager.exec(attrs.packageManager, ["tsc", "-p", attrs.tsconfig.path])
    : PackageManager.exec(attrs.packageManager, [
      "tsup",
      ...attrs.entries.map((entry) => entry.path),
      "--format",
      attrs.format === "dual" ? "esm,cjs" : attrs.format,
      "--out-dir",
      attrs.outDir,
      ...attrs.tool.external.flatMap((name) => ["--external", name])
    ])

/**
 * Builds a JavaScript distribution with `tsc -p <tsconfig>` or `tsup`.
 *
 * The plan runs the selected tool in `cwd` through the shared
 * {@link Target.runTool}, then the shared output-capture step that digests
 * `outDir` into the {@link Outputs} success payload. Source and tsconfig
 * digests are declared through the attrs, and dependency target keys, entries,
 * output format, external packages, and tool identity complete the key
 * material. This models tevm's `build:dist` target and follows tsup and
 * TypeScript project build conventions.
 *
 * @category targets
 * @since 0.1.0
 */
export const TsBuild = Target.make("TsBuild", {
  attrs: Attrs,
  kinds: ["build"],
  success: Outputs,
  error: BuildError,
  outputs: (attrs) => ({ cwd: attrs.cwd, paths: [attrs.outDir] }),
  implementation: (attrs) =>
    captureOutputs(
      Target.runTool({ cwd: attrs.cwd, argv: buildArgv(attrs) }),
      attrs.cwd,
      [attrs.outDir]
    )
})
