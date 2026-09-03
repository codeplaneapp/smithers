/**
 * JSR publication targets.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as NodePath from "node:path"
import { ExecIrreversible } from "./Changesets.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link JsrPublish}. `dryRun` defaults to true, so a real
 * publish is always an explicit opt-out in legacy declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: PackageManager.PackageManager,
  config: Input.File,
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  package: Schema.NonEmptyString,
  allowDirty: Schema.Boolean,
  dryRun: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true)))
})

/**
 * Attributes for {@link JsrPublish}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/** Resolves a JSR config from the same package base as its declared input. */
const publishDirectory = (path: string, context: Target.ImplementationContext): string =>
  path.startsWith("//")
    ? NodePath.dirname(path.slice(2))
    : NodePath.resolve(context.packageDirectory ?? ".", NodePath.dirname(path))

/**
 * Plans JSR publication after npm publication and shared release deps.
 *
 * The body plans one `pnpm dlx jsr publish` in the directory of the declared
 * JSR config, through {@link ExecIrreversible}: publication changes external
 * registry state, so it is irreversible tier and never cacheable. The
 * `package` attr is the published identity and stays key material; jsr reads
 * the name from the config file. `allowDirty` appends `--allow-dirty`.
 * `dryRun` defaults to true and appends `--dry-run`. Key material records
 * JSR config and source digests, dependency keys, package identity,
 * dirty-tree policy, and dry-run policy. This models tevm's dual npm and JSR
 * release and follows `jsr publish`. Its `run` verb gate rejects inclusion in
 * build, test, and lint graphs, including through dependencies. Executing the
 * plan requires {@link ExecIrreversibleLive} from the Changesets module.
 *
 * @category targets
 * @since 0.1.0
 */
export const JsrPublish = Target.make("JsrPublish", {
  attrs: Attrs,
  kinds: ["run"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  verbGate: ["run"],
  implementation: (attrs, context) => {
    const argv: Array<string> = PackageManager.dlx(attrs.packageManager, ["jsr", "publish"])
    if (attrs.allowDirty) argv.push("--allow-dirty")
    if (attrs.dryRun) argv.push("--dry-run")
    return ExecIrreversible.call({
      cwd: publishDirectory(attrs.config.path, context),
      argv
    })
  }
})
