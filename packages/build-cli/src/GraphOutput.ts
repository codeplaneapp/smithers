/**
 * Human-readable target graph renderers.
 *
 * Every renderer takes an optional palette. With the default, {@link Ansi.none},
 * the text is exactly what the structured `graph` field carries, so a
 * terminal and a pipe see the same tree and only the terminal sees colour.
 *
 * @since 0.1.0
 */
import * as Ansi from "./Ansi.ts"
import type * as Planner from "./Planner.ts"

const targetMap = (plan: Planner.Plan): ReadonlyMap<string, Planner.PlannedTarget> =>
  new Map(plan.targets.map((target) => [target.label, target]))

/** The rule name, dim for a file group because it never runs anything. */
const rule = (name: string, style: Ansi.Palette): string =>
  name === "Filegroup" ? style.dim(`(${name})`) : style.cyan(`(${name})`)

const treeLines = (
  label: string,
  targets: ReadonlyMap<string, Planner.PlannedTarget>,
  prefix: string,
  last: boolean,
  seen: Set<string>,
  style: Ansi.Palette,
  root: boolean = false
): ReadonlyArray<string> => {
  const target = targets.get(label)
  const marker = style.dim(root ? "" : last ? "└─ " : "├─ ")
  if (target === undefined) return [`${style.dim(prefix)}${marker}${style.dim(`${label} [external]`)}`]
  const repeated = seen.has(label)
  const name = target.target === "Filegroup" ? style.dim(label) : root ? style.bold(label) : label
  const line = `${style.dim(prefix)}${marker}${name} ${rule(target.target, style)}${
    repeated ? style.dim(" [seen]") : ""
  }`
  if (repeated) return [line]
  seen.add(label)
  const childPrefix = root ? "" : `${prefix}${last ? "   " : "│  "}`
  return [
    line,
    ...target.dependencies.flatMap((dependency, index) =>
      treeLines(dependency, targets, childPrefix, index === target.dependencies.length - 1, seen, style)
    )
  ]
}

/**
 * Renders root-to-dependency text trees.
 *
 * @category formatting
 * @since 0.1.0
 * @slop
 */
export const text = (plan: Planner.Plan, style: Ansi.Palette = Ansi.none): string => {
  const targets = targetMap(plan)
  return plan.roots
    .flatMap((root, index) => [
      ...(index === 0 ? [] : [""]),
      ...treeLines(root, targets, "", true, new Set(), style, true)
    ])
    .join("\n")
}

/**
 * One package-mode node as {@link packageText} lists it.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageRow {
  readonly label: string
  readonly target: string
}

/**
 * One package-mode edge as {@link packageText} lists it.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageEdge {
  readonly from: string
  readonly to: string
  readonly kind: string
}

/**
 * Renders the package-mode graph: every selected label, each followed by its
 * outgoing edges as `-kind-> label` lines.
 *
 * @category formatting
 * @since 0.1.0
 */
export const packageText = (
  rows: ReadonlyArray<PackageRow>,
  edges: ReadonlyArray<PackageEdge>,
  style: Ansi.Palette = Ansi.none
): string =>
  rows.map((row) => {
    const own = edges.filter((edge) => edge.from === row.label)
    const name = row.target === "Filegroup" ? style.dim(row.label) : style.bold(row.label)
    return own.length === 0
      ? name
      : `${name}\n${own.map((edge) => `  ${style.dim(`-${edge.kind}->`)} ${edge.to}`).join("\n")}`
  }).join("\n")

const mermaidId = (label: string): string => `n_${Buffer.from(label).toString("hex")}`
const mermaidLabel = (label: string): string => label.replaceAll("\"", "&quot;")

/**
 * Renders a Mermaid target graph.
 *
 * @category formatting
 * @since 0.1.0
 * @slop
 */
export const mermaid = (plan: Planner.Plan): string => {
  const lines = ["flowchart LR"]
  for (const target of plan.targets) {
    lines.push(`  ${mermaidId(target.label)}["${mermaidLabel(`${target.label}\\n${target.target}`)}"]`)
  }
  for (const edge of plan.edges) lines.push(`  ${mermaidId(edge.from)} --> ${mermaidId(edge.to)}`)
  return lines.join("\n")
}
