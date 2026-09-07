/**
 * The featured flows a project declares, read from its generated
 * `flows/catalog.json` and folded into the `ls` listing.
 *
 * The catalog is the projection `//:flowCatalog` writes from the root
 * `PACKAGE.ts` declarations over the discovered flows. `ls` never evaluates
 * `PACKAGE.ts`; it reads the file when it is checked in and lists the flows
 * unchanged when it is not. An unreadable or malformed catalog is treated as
 * absent here: `doctor` owns diagnostics, and a listing that refused to print
 * because a generated file drifted would hide the flows behind the drift.
 *
 * @since 1.0.0
 */
import * as FlowCatalog from "@smthrs/targets/FlowCatalog"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * One listed flow, with the presentation the catalog declares when it does.
 *
 * `featured` and `summary` are present only when the catalog says so, so a
 * project without a catalog lists exactly what it listed before.
 *
 * @category models
 * @since 1.0.0
 */
export interface Presented {
  readonly flowId: string
  readonly description: string
  readonly featured?: true
  readonly summary?: string
}

/**
 * Reads the project's catalog, or nothing when the project has none.
 *
 * @category constructors
 * @since 1.0.0
 */
export const read = (projectRoot: string): FlowCatalog.Document | undefined => {
  let text: string
  try {
    text = readFileSync(join(projectRoot, "flows", "catalog.json"), "utf8")
  } catch {
    return undefined
  }
  const parsed = FlowCatalog.parse(text)
  return typeof parsed === "string" ? undefined : parsed
}

/**
 * Folds the catalog's presentation into the listed flows: featured flows
 * first, in catalog order, each carrying `featured` and its summary; then
 * every other flow in listing order, with a summary where the catalog
 * declares one. A catalog row naming no listed flow contributes nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const present = (
  items: ReadonlyArray<{ readonly flowId: string; readonly description: string }>,
  catalog: FlowCatalog.Document | undefined
): ReadonlyArray<Presented> => {
  if (catalog === undefined) return items
  const rows = new Map(catalog.flows.map((row) => [row.id, row] as const))
  const decorate = (item: { readonly flowId: string; readonly description: string }): Presented => {
    const row = rows.get(item.flowId)
    return {
      flowId: item.flowId,
      description: item.description,
      ...(row?.featured === true ? { featured: true as const } : {}),
      ...(row?.summary === undefined || row.summary === null ? {} : { summary: row.summary })
    }
  }
  const listed = new Map(items.map((item) => [item.flowId, item] as const))
  const featured = catalog.flows
    .filter((row) => row.featured && listed.has(row.id))
    .map((row) => decorate(listed.get(row.id)!))
  const featuredIds = new Set(featured.map((item) => item.flowId))
  return [...featured, ...items.filter((item) => !featuredIds.has(item.flowId)).map(decorate)]
}

/**
 * Whether a rendered value is a flow page this module can present.
 *
 * @category guards
 * @since 1.0.0
 */
export const isFlowPage = (
  value: unknown
): value is { readonly _tag: "flows"; readonly items: ReadonlyArray<Presented> } =>
  typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === "flows" &&
  Array.isArray((value as { items?: unknown }).items) &&
  (value as { items: ReadonlyArray<unknown> }).items.every((item) =>
    typeof item === "object" && item !== null &&
    typeof (item as { flowId?: unknown }).flowId === "string" &&
    typeof (item as { description?: unknown }).description === "string"
  )

/**
 * The human listing: one line per flow, a leading `*` on featured rows, the
 * id, then the declared summary or the flow's own description.
 *
 * @category rendering
 * @since 1.0.0
 */
export const human = (items: ReadonlyArray<Presented>): string => {
  if (items.length === 0) return "No flows discovered under flows/.\n"
  const width = Math.max(...items.map((item) => item.flowId.length))
  return items
    .map((item) =>
      `${item.featured === true ? "* " : "  "}${item.flowId.padEnd(width)}  ${item.summary ?? item.description}`
    )
    .join("\n") + "\n"
}
