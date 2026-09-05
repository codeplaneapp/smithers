/** Conservative changed-file selection, including reverse target dependencies.
 * @since 0.1.0
 */
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import { minimatch } from "minimatch"
import * as Path from "node:path"
import * as ContainedProcess from "./internal/ContainedProcess.ts"
import type { PackageIndex } from "./PackageIndex.ts"
import { productionSourceRoots } from "./Planner.ts"

/** Affected discovery refused a git result or could not finish within its bound.
 * @category errors
 * @since 1.0.0-rc.0
 */
export class AffectedGitError extends Error {
  readonly _tag = "AffectedGitError"
  readonly code: ContainedProcess.ProcessError["code"] | "nonzero_exit" | "invalid_timeout"
  readonly args: ReadonlyArray<string>

  constructor(code: AffectedGitError["code"], args: ReadonlyArray<string>, message: string, cause?: unknown) {
    super(message, { cause })
    this.code = code
    this.args = [...args]
  }
}

/** Collects changed paths from explicit inputs or a verified Git comparison.
 * @category querying
 * @since 0.1.0
 */
export const changedPaths = async (root: string, options: {
  readonly base: string
  readonly head?: string | undefined
  readonly files?: ReadonlyArray<string> | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
}): Promise<ReadonlyArray<string>> => {
  if (options.signal?.aborted) {
    throw new AffectedGitError("cancelled", [], "affected discovery cancelled", options.signal.reason)
  }
  if (options.files !== undefined) return [...new Set(options.files)].sort()
  const timeoutMs = options.timeoutMs ?? 60_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new AffectedGitError("invalid_timeout", [], "git timeout must be an integer from 1 to 86400000ms")
  }
  const git = async (args: ReadonlyArray<string>): Promise<string> => {
    let stdout = ""
    let stderr = ""
    let code: number
    try {
      code = await ContainedProcess.run({
        command: "git",
        args,
        cwd: root,
        signal: options.signal,
        environment: options.environment,
        timeoutMs,
        maxOutputBytes: 16 * 1024 * 1024,
        fatalUtf8: true,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        }
      })
    } catch (cause) {
      throw new AffectedGitError(
        cause instanceof ContainedProcess.ProcessError ? cause.code : "process_failed",
        args,
        `git ${args[0]} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause
      )
    }
    if (code !== 0) {
      throw new AffectedGitError("nonzero_exit", args, `git ${args[0]} exited ${code}: ${stderr.trim()}`, {
        exitCode: code,
        stderr
      })
    }
    return stdout
  }
  const gitPaths = async (args: ReadonlyArray<string>) => (await git(args)).split("\0").filter(Boolean)
  // Resolve user revisions before passing them to diff; a leading dash cannot become an option.
  const revision = async (ref: string) =>
    (await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim()
  const base = await revision(options.base)
  const paths = options.head === undefined
    ? [
      ...await gitPaths(["diff", "--name-only", "--no-renames", "-z", base, "--"]),
      ...await gitPaths(["ls-files", "--others", "--exclude-standard", "-z"])
    ]
    : await gitPaths(["diff", "--name-only", "--no-renames", "-z", base, await revision(options.head), "--"])
  return [...new Set(paths)].sort()
}

const globalPath = (path: string): boolean =>
  !path.includes("/") || path.startsWith(".smithers/") || Path.posix.basename(path) === "PACKAGE.ts" ||
  /(^|\/)(?:[^/]*lock[^/]*|package\.json|tsconfig[^/]*\.json|\.npmrc|\.yarnrc[^/]*|\.gitignore)$/.test(path)

const matches = (input: Input.Declared, packagePath: string, path: string): boolean => {
  switch (input._tag) {
    case "File":
      return Input.resolvePath(packagePath, input.path) === path
    case "Glob": {
      const pattern = Input.resolvePath(packagePath, input.pattern)
      return minimatch(path, pattern, { dot: true }) &&
        !input.exclude.some((exclude) => minimatch(path, Input.resolvePath(packagePath, exclude), { dot: true }))
    }
    // These input forms include ambient repository state and workspace membership.
    case "GitDiff":
    case "PnpmWorkspace":
      return true
  }
}

/** Selects roots whose declarations, package inputs or dependencies may have changed.
 * @category querying
 * @since 0.1.0
 */
export const select = (index: PackageIndex, pattern: string, paths: ReadonlyArray<string>) => {
  const normalized = [
    ...new Set(paths.map((path) => {
      const value = path.replaceAll("\\", "/").replace(/^\.\//, "")
      if (value === "" || Path.posix.isAbsolute(value) || value.split("/").includes("..")) {
        throw new Error(`invalid workspace-relative changed path: ${path}`)
      }
      return value
    }))
  ].sort()
  const rows = index.targets()
  const selected = index.resolve(pattern)
  const reasons = new Map<string, Set<string>>()
  const visit = (target: Target.AnyTarget, path: string, seen: Set<Target.AnyTarget>): boolean => {
    if (seen.has(target)) return false
    seen.add(target)
    const metadata = Target.metadata(target)
    const packagePath = index.ownerOf(target) ?? ""
    // Package membership also catches new files, implicit compiler inputs and config lookups.
    if (packagePath !== "" && path.startsWith(`${packagePath}/`)) return true
    const views = metadata.kinds.map((kind) => metadata.forKind(kind))
    const inputs = [...metadata.inputs, ...views.flatMap((view) => view.inputs)]
    if (inputs.some((input) => matches(input, packagePath, path))) return true
    // Subtree dependencies and verb-specific edges may select roots without direct imports.
    const selectors = [...metadata.dependencySelectors, ...views.flatMap((view) => view.dependencySelectors)]
    const dependencies = [
      ...metadata.dependencies,
      ...views.flatMap((view) => view.dependencies),
      ...selectors.flatMap((selector) =>
        index.resolve(`${selector.pattern}:${selector.target}`).map((row) => row.target)
      )
    ]
    if (metadata.inputs.length === 0 && metadata.dependencies.length === 0) return true
    return dependencies.some((dependency) => visit(dependency, path, seen))
  }
  const implementationRoots = productionSourceRoots().map((source) =>
    Path.relative(index.root, source.directory).replaceAll("\\", "/")
  )
    .filter((path) => path !== ".." && !path.startsWith("../") && !Path.isAbsolute(path))
  const global = normalized.filter((path) =>
    globalPath(path) || implementationRoots.some((directory) => path === directory || path.startsWith(`${directory}/`))
  )
  // An unowned file may be an ambient input; conservatively invalidate the graph.
  const unknown = normalized.filter((path) =>
    !rows.some((row) =>
      row.packagePath !== "" && path.startsWith(`${row.packagePath}/`) ||
      Target.metadata(row.target).inputs.some((input) => matches(input, row.packagePath, path))
    )
  )
  for (const row of selected) {
    const causes = global.length + unknown.length > 0 ?
      [...global, ...unknown] :
      normalized.filter((path) => visit(row.target, path, new Set()))
    if (causes.length > 0) reasons.set(row.label, new Set(causes))
  }
  return {
    pattern,
    files: normalized,
    conservative: global.length + unknown.length > 0,
    globalInputs: [...new Set([...global, ...unknown])].sort(),
    targets: selected.filter((row) => reasons.has(row.label)).map((row) => ({
      label: row.label,
      reasons: [...reasons.get(row.label)!].sort()
    }))
  }
}
