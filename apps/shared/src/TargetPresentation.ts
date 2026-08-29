import type { Target } from "./LocalApp"

/** The deterministic transcript message emitted after a repository's targets load. */
export const defaultTargetsMessage = (count: number, repoName: string): string =>
  `Loaded ${count} ${count === 1 ? "target" : "targets"} for ${repoName}.`

/** Targets grouped by package, preserving the loader's first-seen package order. */
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

/** Targets grouped by workspace, then package, preserving first-seen order. */
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
