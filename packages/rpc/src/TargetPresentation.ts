/**
 * Grouping of target records for package and workspace presentation.
 *
 * @since 1.0.0
 */
import type { Target } from "./LocalApp.ts"

/** Targets grouped by package, preserving the loader's first-seen package order.
 * @since 1.0.0
 * @category conversions
 */
export const groupTargets = (
  targets: ReadonlyArray<Target>
): ReadonlyArray<{ readonly package: string; readonly targets: ReadonlyArray<Target> }> => {
  const groups = new Map<string, Array<Target>>()
  for (const target of targets) {
    const group = groups.get(target.package) ?? []
    group.push(target)
    groups.set(target.package, group)
  }
  return [...groups.entries()].map(([pkg, rows]) => ({ package: pkg, targets: rows }))
}

/** Targets grouped by workspace, then package, preserving first-seen order.
 * @since 1.0.0
 * @category conversions
 */
export const groupTargetsByWorkspace = (
  targets: ReadonlyArray<Target>
): ReadonlyArray<{
  readonly workspace: string
  readonly packages: ReadonlyArray<{ readonly package: string; readonly targets: ReadonlyArray<Target> }>
}> => {
  const groups = new Map<string, Array<Target>>()
  for (const target of targets) {
    const group = groups.get(target.workspace) ?? []
    group.push(target)
    groups.set(target.workspace, group)
  }
  return [...groups.entries()].map(([workspace, rows]) => ({
    workspace,
    packages: groupTargets(rows)
  }))
}
