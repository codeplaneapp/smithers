/**
 * Non-watch Vitest runs.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link Vitest}.
 *
 * `cwd` is the workspace-relative directory the runner starts in and defaults
 * to the workspace root. The `config` path resolves from `cwd` when the tool
 * runs.
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
  environment: Schema.NonEmptyString,
  passWithNoTests: Schema.Boolean,
  /**
   * Whether the run may compute coverage. `false` renders
   * `--coverage.enabled=false`, which a config with coverage enabled needs on a
   * host whose engine has no V8 inspector — Bun runs JavaScriptCore, and
   * `@vitest/coverage-v8` cannot attach there.
   *
   * @default true
   */
  coverage: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true))),
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  )
})

/**
 * Attributes for {@link Vitest}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Plans a non-watch `vitest run` test target.
 *
 * The body records one {@link Exec.Exec} node that runs
 * `pnpm exec vitest run` from `cwd` with the declared config, environment,
 * and empty-suite policy. Test, source, and config declarations are the
 * target's inputs, so key material contains their digests plus dependency
 * target keys. This models tevm's `test:run` target and Vitest's
 * deterministic run mode. Executing the plan requires {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const Vitest = Target.make("Vitest", {
  attrs: Attrs,
  kinds: ["test"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) =>
    Target.runTool({
      cwd: attrs.cwd,
      argv: PackageManager.exec(attrs.packageManager, [
        "vitest",
        "run",
        ...(attrs.config === null ? [] : ["--config", attrs.config.path]),
        "--environment",
        attrs.environment,
        ...(attrs.coverage ? [] : ["--coverage.enabled=false"]),
        ...(attrs.passWithNoTests ? ["--passWithNoTests"] : [])
      ])
    })
})
