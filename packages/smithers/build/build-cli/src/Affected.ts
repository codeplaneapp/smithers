/** Conservative changed-file selection, including reverse target dependencies.
 * @since 0.1.0
 */
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import { minimatch } from "minimatch"
import { execFile } from "node:child_process"
import * as Path from "node:path"
import { promisify } from "node:util"
import type { PackageIndex } from "./PackageIndex.ts"
import { productionSourceRoots } from "./Planner.ts"

const exec = promisify(execFile)
const gitPaths = async (root: string, args: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const { stdout } = await exec("git", [...args], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
  return stdout.split("\0").filter(Boolean)
}

/** Collects changed paths from explicit inputs or a verified Git comparison.
 * @category querying
 * @since 0.1.0
 */
export const changedPaths = async (root: string, options: {
  readonly base: string
  readonly head?: string | undefined
  readonly files?: ReadonlyArray<string> | undefined
}): Promise<ReadonlyArray<string>> => {
  if (options.files !== undefined) return [...new Set(options.files)].sort()
  // Resolve user revisions before passing them to diff; a leading dash cannot become an option.
  const revision = async (ref: string) =>
    (await exec("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: root })).stdout.trim()
  const base = await revision(options.base)
  const paths = options.head === undefined
    ? [
      ...await gitPaths(root, ["diff", "--name-only", "--no-renames", "-z", base, "--"]),
      ...await gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    ]
    : await gitPaths(root, ["diff", "--name-only", "--no-renames", "-z", base, await revision(options.head), "--"])
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
