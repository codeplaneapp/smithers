/**
 * The package manager and runtime a target resolves from the workspace.
 *
 * `WORKSPACE.ts` declares the workspace's package manager and runtime once.
 * Before this module every PACKAGE.ts restated them: the root declaration
 * exported `packageManager` and `runtime` values and ~75 package declarations
 * imported them back so they could pass them as attrs. That is the workspace's
 * business, not a package's, and the import direction is the wrong one anyway
 * — `PackageLoader` refuses a PACKAGE.ts that imports WORKSPACE.ts.
 *
 * A rule now names the attrs it resolves from the workspace
 * ({@link Target.Metadata.workspaceAttrs}) and leaves them optional. The
 * planner fills each named attr in here, before it keys the node and before it
 * runs the body, so the manager and the interpreter stay key material and the
 * rule bodies keep computing their own argv from one declaration. A
 * declaration that passes the attr explicitly always wins: that is how the Bun
 * compatibility matrix re-runs a package's suite under a second interpreter.
 *
 * @since 0.1.0
 */
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import type * as Target from "@smthrs/targets/Target"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"

/**
 * The workspace-declared tool identities legacy rules resolve against.
 *
 * Either may be undefined: a Cargo or Go workspace declares no JavaScript
 * package manager at all, and a rule that needs one then refuses by name
 * rather than spawning whatever is on PATH.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkspaceToolchain {
  readonly packageManager: PackageManager.PackageManager | undefined
  readonly runtime: Runtime.Runtime | undefined
}

/** The workspace toolchain of a workspace that declares neither. */
const none: WorkspaceToolchain = Object.freeze({ packageManager: undefined, runtime: undefined })

/**
 * The manager legacy rules run tools through.
 *
 * A workspace may declare the manager in either era's form. The legacy form is
 * already the record the rules take. The WORKSPACE.ts form pins the manager
 * through the repository's own manifest and lockfile instead, so it is lowered
 * to the record shape here; its `version` is a requirement string, and a
 * declaration that pins none accepts any installed manager, which is what the
 * executor's own default toolchain does.
 */
const managerOf = (
  workspace: WorkspaceDeclaration.WorkspaceDeclaration,
  runtime: Runtime.Runtime | undefined
): PackageManager.PackageManager | undefined => {
  const declared: unknown = workspace.packageManager
  if (declared === undefined) return undefined
  if (PackageManager.isPackageManager(declared)) return declared
  // Yarn has no legacy rule that speaks it, and lowering a manager the rules
  // cannot run would produce `yarn exec` argv from a `pnpm` code path.
  if (!PackageManager.isPnpmDeclaration(declared)) return undefined
  // The lowered record's `runtime` is the workspace's own; without one there
  // is nothing to lower to, because the record type requires it.
  if (runtime === undefined) return undefined
  return {
    name: "pnpm",
    version: declared.version ?? ">=0.0.0",
    executable: "pnpm",
    runtime
  } as PackageManager.PackageManager
}

/**
 * Reads the workspace declaration's package manager and runtime.
 *
 * @category constructors
 * @since 0.1.0
 */
export const of = (workspace: WorkspaceDeclaration.WorkspaceDeclaration): WorkspaceToolchain => {
  const declaredRuntime: unknown = workspace.runtime
  const runtime = Runtime.isRuntime(declaredRuntime) ? declaredRuntime : undefined
  const packageManager = managerOf(workspace, runtime)
  if (runtime === undefined && packageManager === undefined) return none
  return Object.freeze({ packageManager, runtime })
}

/**
 * Fills a target's workspace-resolved attrs from the workspace declaration.
 *
 * Only the attrs the rule named are considered, and only when the declaration
 * left them absent, so a target that never declared one is returned untouched
 * and a target that declared one keeps what it wrote.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fill = (
  workspaceAttrs: ReadonlyArray<Target.WorkspaceAttr>,
  attrs: unknown,
  toolchain: WorkspaceToolchain
): unknown => {
  if (
    workspaceAttrs.length === 0 || typeof attrs !== "object" || attrs === null ||
    (toolchain.packageManager === undefined && toolchain.runtime === undefined)
  ) return attrs
  const declared = attrs as Record<string, unknown>
  let filled: Record<string, unknown> | undefined
  for (const name of workspaceAttrs) {
    if (declared[name] !== undefined) continue
    const value = name === "packageManager" ? toolchain.packageManager : toolchain.runtime
    if (value === undefined) continue
    filled = filled ?? { ...declared }
    filled[name] = value
  }
  return filled === undefined ? attrs : Object.freeze(filled)
}
