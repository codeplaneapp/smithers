/**
 * Generated-output cleanup targets.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as NodePath from "node:path"
import * as Exec from "./Exec.ts"
import * as Runtime from "./Runtime.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link Clean}.
 *
 * `cwd` is the workspace-relative directory the declared paths resolve from
 * and defaults to the workspace root. Every `paths` entry must stay inside
 * `cwd`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  runtime: Runtime.Runtime,
  paths: Schema.Array(Schema.NonEmptyString),
  deps: Schema.Array(Target.Target),
  includeNodeModules: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  )
})

/**
 * Attributes for {@link Clean}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/** The one static script the exec node runs. It removes exactly the paths it
 * receives as arguments, resolved against the exec cwd. */
const removeScript = "const fs = require('node:fs');" +
  "for (const target of process.argv.slice(1))" +
  " fs.rmSync(target, { recursive: true, force: true });"

/** Normalizes one declared path and refuses anything outside the directory. */
const scoped = (path: string): string => {
  const normalized = NodePath.posix.normalize(path.split(NodePath.sep).join("/"))
  if (
    NodePath.isAbsolute(path) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Clean only removes paths inside its directory: ${path}`)
  }
  return normalized
}

/**
 * Plans deletion of explicitly declared generated paths.
 *
 * The body records one {@link Exec.Exec} node that runs a static Node script
 * removing exactly the declared paths, plus `node_modules` when
 * `includeNodeModules` is set, resolved from `cwd`. Absolute paths, `.`, and
 * paths escaping `cwd` are refused at plan time, so nothing outside the
 * declared list is ever deleted. Cleanup is never cacheable because deletion
 * changes local state and has no reusable result. This follows common
 * monorepo clean targets. Executing the plan requires {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const Clean = Target.make("Clean", {
  attrs: Attrs,
  kinds: ["run"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  implementation: (attrs) => {
    const targets = [
      ...attrs.paths,
      ...(attrs.includeNodeModules ? ["node_modules"] : [])
    ].map(scoped)
    return Target.runTool({
      cwd: attrs.cwd === "." ? "." : scoped(attrs.cwd),
      argv: Runtime.evaluate(attrs.runtime, removeScript, [...targets])
    })
  }
})
