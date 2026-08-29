/**
 * BUILD target queries.
 *
 * @since 0.1.0
 */
import * as Target from "@smthrs/targets/Target"
import * as Ansi from "./Ansi.ts"
import * as Planner from "./Planner.ts"
import type * as Workspace from "./Workspace.ts"

/**
 * Result of a bare label or pattern query.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Listing {
  readonly query: string
  readonly targets: ReadonlyArray<{
    readonly label: string
    readonly target: string
    readonly kinds: ReadonlyArray<Target.Kind>
  }>
}

/**
 * Result of a `deps(label)` query.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Dependencies {
  readonly query: string
  readonly root: string
  readonly dependencies: ReadonlyArray<string>
  readonly edges: ReadonlyArray<Planner.Edge>
}

/**
 * Evaluates a bare label/pattern listing or `deps(label)`.
 *
 * @category querying
 * @since 0.1.0
 * @slop
 */
export const run = async (
  workspace: Workspace.Workspace,
  expression: string
): Promise<Listing | Dependencies> => {
  const dependencyMatch = expression.match(/^deps\((.+)\)$/)
  if (dependencyMatch?.[1] !== undefined) {
    const pattern = dependencyMatch[1].trim()
    const plan = await Planner.make(workspace, "query", pattern)
    if (plan.roots.length !== 1) throw new Error("deps() requires one exact or default target")
    const root = plan.roots[0]!
    return {
      query: expression,
      root,
      dependencies: plan.targets.map((target) => target.label).filter((label) => label !== root),
      edges: plan.edges
    }
  }
  const targets = await workspace.targets(expression)
  return {
    query: expression,
    targets: await Promise.all(targets.map(async (target) => ({
      label: await workspace.label(target),
      target: Target.metadata(target).target,
      kinds: Target.metadata(target).kinds
    })))
  }
}

const kindColor: Record<string, keyof Ansi.Palette> = {
  build: "blue",
  test: "green",
  lint: "yellow",
  run: "magenta",
  docs: "cyan"
}

const kind = (name: string, style: Ansi.Palette): string => {
  const color = kindColor[name]
  return color === undefined ? name : (style[color] as (text: string) => string)(name)
}

/**
 * Renders a query result for a person: a listing as aligned `LABEL TARGET
 * KINDS` columns, and `deps(label)` as the root followed by what it depends
 * on. With the default palette the text carries no escape sequences.
 *
 * @category formatting
 * @since 0.1.0
 */
export const text = (result: Listing | Dependencies, style: Ansi.Palette = Ansi.none): string => {
  if ("root" in result) {
    const count = result.dependencies.length
    const head = `${style.bold(result.root)} ${style.dim(`depends on ${count} ${count === 1 ? "target" : "targets"}`)}`
    return [head, ...result.dependencies.map((label) => `  ${label}`)].join("\n")
  }
  if (result.targets.length === 0) return style.dim(`no targets match ${result.query}`)
  const labelWidth = Math.max("LABEL".length, ...result.targets.map((row) => row.label.length))
  const targetWidth = Math.max("TARGET".length, ...result.targets.map((row) => row.target.length))
  const header = style.dim(`${"LABEL".padEnd(labelWidth)}  ${"TARGET".padEnd(targetWidth)}  KINDS`)
  const rows = result.targets.map((row) => {
    const kinds = row.kinds.map((name) => kind(name, style)).join(" ")
    return `${row.label.padEnd(labelWidth)}  ${style.dim(row.target.padEnd(targetWidth))}  ${kinds}`
  })
  return [header, ...rows].join("\n")
}
