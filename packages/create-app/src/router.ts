/**
 * The file router: a filesystem walk that turns an app directory into a route
 * table and renders the two generated files.
 *
 * Nothing here evaluates a module, so the same code runs under plain Node in
 * `bin/routes.mjs`, inside the Vite plugin, and inside a test. The rules are
 * the whole authoring contract, and file location is the only thing that names
 * anything:
 *
 * - `<app>/layout.tsx` is the shell layout, and it is optional.
 * - `<app>/**\/page.tsx` is the page at `/<dir>`; `<app>/page.tsx` is `/`.
 * - `<app>/panes/<name>.tsx` is the pane `<name>`.
 * - `<flows>/**\/flow.ts` or `flow.mdx` is the flow named by its directory, so
 *   `flows/build/plan/flow.ts` is the flow `build/plan`.
 * - `AGENT.ts`, `SANDBOX.ts`, and `TOOLS.ts` are layers for every flow in
 *   their directory and below. The nearest ancestor of each kind wins and
 *   nothing merges, so the app root must provide all three for resolution to
 *   terminate.
 *
 * @since 0.1.0
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, posix, relative, resolve, sep } from "node:path"
import type { AppDirs, AppRoutes, FlowRoute, PageRoute, PaneRoute } from "./app.ts"

/**
 * Where to walk and which directories carry the app, the flows, and the tools.
 *
 * @category models
 * @since 0.1.0
 */
export interface RouterOptions {
  readonly root: string
  readonly dirs: AppDirs
}

/**
 * Why the router refused a tree.
 *
 * `missing_layer` is a flow with no ancestor layer file of some kind,
 * `duplicate_name` is two files claiming one route, and `invalid_name` is a
 * pane or flow directory that is not lowercase kebab-case.
 *
 * @category models
 * @since 0.1.0
 */
export type RouterErrorCode = "missing_layer" | "duplicate_name" | "invalid_name"

/**
 * A refused tree, thrown rather than returned because every caller — the bin,
 * the Vite plugin, a test — wants the walk to stop.
 *
 * @category errors
 * @since 0.1.0
 */
export class RouterError extends Error {
  /**
   * @category models
   * @since 0.1.0
   */
  override readonly name = "RouterError"
  /**
   * @category models
   * @since 0.1.0
   */
  readonly code: RouterErrorCode
  constructor(code: RouterErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

const IGNORED = new Set(["node_modules", ".git", "dist", ".flows", ".wrangler", ".smithers"])
type LayerKind = "AGENT.ts" | "SANDBOX.ts" | "TOOLS.ts"
const NAME = /^[a-z][a-z0-9-]*$/

const toPosix = (path: string): string => path.split(sep).join(posix.sep)

const walk = (dir: string, visit: (file: string) => void): void => {
  for (const entry of readdirSync(dir).sort()) {
    if (IGNORED.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, visit)
    else visit(full)
  }
}

/**
 * Resolves one layer kind for one directory: the nearest `<kind>` at `dir` or
 * any ancestor up to and including `root`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolveLayer = (root: string, dir: string, kind: LayerKind, files: ReadonlySet<string>): string => {
  let current = dir
  for (;;) {
    const candidate = toPosix(relative(root, join(current, kind)))
    if (files.has(candidate)) return candidate
    if (current === root) break
    current = dirname(current)
  }
  throw new RouterError(
    "missing_layer",
    `no ${kind} found for ${toPosix(relative(root, dir))} or any ancestor; add one at the app root`
  )
}

/**
 * Walks an app root and returns everything the two generated files are
 * rendered from.
 *
 * @example
 * ```ts
 * import { defaultDirs } from "@smthrs/create-app/app"
 * import { discover } from "@smthrs/create-app/router"
 *
 * const routes = discover({ root: process.cwd(), dirs: defaultDirs })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const discover = (options: RouterOptions): AppRoutes => {
  const { dirs, root } = options
  const files = new Set<string>()
  walk(root, (file) => files.add(toPosix(relative(root, file))))

  const appPrefix = `${dirs.app}/`
  const flowsPrefix = `${dirs.flows}/`
  const layout = files.has(`${dirs.app}/layout.tsx`) ? `${dirs.app}/layout.tsx` : undefined

  const pages: Array<PageRoute> = []
  const panes: Array<PaneRoute> = []
  const flows: Array<FlowRoute> = []
  const seen = new Map<string, string>()
  const claim = (key: string, file: string): void => {
    const previous = seen.get(key)
    if (previous !== undefined) {
      throw new RouterError("duplicate_name", `${file} and ${previous} both resolve to ${key}`)
    }
    seen.set(key, file)
  }

  for (const file of [...files].sort()) {
    if (file.startsWith(`${dirs.app}/panes/`) && file.endsWith(".tsx")) {
      const name = posix.basename(file, ".tsx")
      if (!NAME.test(name)) throw new RouterError("invalid_name", `pane file name must match ${NAME}: ${file}`)
      claim(`pane:${name}`, file)
      panes.push({ name, file })
      continue
    }
    if (file.startsWith(appPrefix) && posix.basename(file) === "page.tsx") {
      const dir = posix.dirname(file).slice(appPrefix.length - 1)
      const route = dir === "" ? "/" : `/${dir.replace(/^\//, "")}`
      claim(`page:${route}`, file)
      pages.push({ route, file })
      continue
    }
    if (file.startsWith(flowsPrefix) && (posix.basename(file) === "flow.ts" || posix.basename(file) === "flow.mdx")) {
      const id = posix.dirname(file).slice(flowsPrefix.length)
      if (!id.split("/").every((segment) => NAME.test(segment))) {
        throw new RouterError("invalid_name", `flow directory segments must match ${NAME}: ${file}`)
      }
      claim(`flow:${id}`, file)
      const dir = join(root, posix.dirname(file))
      flows.push({
        id,
        file,
        agent: resolveLayer(root, dir, "AGENT.ts", files),
        sandbox: resolveLayer(root, dir, "SANDBOX.ts", files),
        tools: resolveLayer(root, dir, "TOOLS.ts", files)
      })
    }
  }
  return { layout, pages, panes, flows }
}

const identifier = (prefix: string, key: string): string => `${prefix}_${key.replace(/[^A-Za-z0-9]/g, "_")}`

const header = (what: string): ReadonlyArray<string> => [
  `// Generated by @smthrs/create-app from ${what}. Do not edit.`,
  "// Regenerate with `pnpm routes`; `smthrs '//:routes'` checks for drift.",
  "/* eslint-disable */",
  ""
]

/**
 * Renders `routes.gen.ts`: every flow with its resolved layers, plus the pane
 * names.
 *
 * The file imports no React and no virtual module, so the Worker bundle and a
 * plain vitest run can both load it without Vite.
 *
 * @category constructors
 * @since 0.1.0
 */
export const render = (routes: AppRoutes): string => {
  const lines: Array<string> = [...header("the flows and layer files")]
  const layerFiles = new Set<string>()
  for (const flow of routes.flows) for (const file of [flow.agent, flow.sandbox, flow.tools]) layerFiles.add(file)
  const layerIds = new Map<string, string>()
  let index = 0
  for (const file of [...layerFiles].sort()) {
    const id = `layer${index++}`
    layerIds.set(file, id)
    lines.push(`import * as ${id} from "./${file}"`)
  }
  for (const flow of routes.flows) lines.push(`import * as ${identifier("flow", flow.id)} from "./${flow.file}"`)
  lines.push("")
  lines.push(`export const paneNames = ${JSON.stringify(routes.panes.map((pane) => pane.name))} as const`)
  lines.push("")
  lines.push("export const flows = [")
  for (const flow of routes.flows) {
    lines.push(
      `  { id: ${JSON.stringify(flow.id)}, file: ${JSON.stringify(flow.file)}, spec: ${
        identifier("flow", flow.id)
      }.Flow, ` +
        `agent: ${layerIds.get(flow.agent)}.Agent, sandbox: ${layerIds.get(flow.sandbox)}.Sandbox, tools: ${
          layerIds.get(flow.tools)
        }.Tools },`
    )
  }
  lines.push("] as const")
  lines.push("")
  return lines.join("\n")
}

/**
 * Renders `routes.ui.gen.ts`: the shell layout, the pages, and the pane
 * components the browser bundle needs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const renderUi = (routes: AppRoutes): string => {
  const lines: Array<string> = [...header("the app directory")]
  for (const pane of routes.panes) lines.push(`import * as ${identifier("pane", pane.name)} from "./${pane.file}"`)
  if (routes.layout !== undefined) lines.push(`import * as layoutModule from "./${routes.layout}"`)
  for (const page of routes.pages) lines.push(`import * as ${identifier("page", page.route)} from "./${page.file}"`)
  lines.push("")
  lines.push(`export const layout = ${routes.layout === undefined ? "undefined" : "layoutModule.default"}`)
  lines.push("")
  lines.push("export const pages = [")
  for (const page of routes.pages) {
    lines.push(
      `  { route: ${JSON.stringify(page.route)}, file: ${JSON.stringify(page.file)}, component: ${
        identifier("page", page.route)
      }.default },`
    )
  }
  lines.push("] as const")
  lines.push("")
  lines.push("export const panes = {")
  for (const pane of routes.panes) lines.push(`  ${JSON.stringify(pane.name)}: ${identifier("pane", pane.name)}.Pane,`)
  lines.push("} as const")
  lines.push("")
  return lines.join("\n")
}

/**
 * Both generated files, keyed by their app-root relative path.
 *
 * @category constructors
 * @since 0.1.0
 */
export const renderAll = (routes: AppRoutes): Readonly<Record<string, string>> => ({
  "routes.gen.ts": render(routes),
  "routes.ui.gen.ts": renderUi(routes)
})

/**
 * What one generated file was found to be.
 *
 * `written` and `clean` are the two outcomes of a successful run; `stale` is
 * only reported in check mode, where nothing is written.
 *
 * @category models
 * @since 0.1.0
 */
export type RoutesFileStatus = "written" | "clean" | "stale"

/**
 * What {@link writeRoutes} did, one entry per generated file plus the counts
 * a caller prints.
 *
 * @category models
 * @since 0.1.0
 */
export interface RoutesReport {
  readonly files: Readonly<Record<string, RoutesFileStatus>>
  readonly stale: ReadonlyArray<string>
  readonly counts: { readonly pages: number; readonly panes: number; readonly flows: number }
}

/**
 * Discovers an app root and writes the two generated files, or reports their
 * drift when `check` is set.
 *
 * This is the whole body of the `smthrs-routes` bin and of the Vite plugin's
 * regeneration step, so drift checking and writing cannot diverge.
 *
 * @category constructors
 * @since 0.1.0
 */
export const writeRoutes = (
  options: RouterOptions & { readonly check?: boolean }
): RoutesReport => {
  const routes = discover(options)
  const files: Record<string, RoutesFileStatus> = {}
  const stale: Array<string> = []
  for (const [file, next] of Object.entries(renderAll(routes))) {
    const target = resolve(options.root, file)
    const current = existsSync(target) ? readFileSync(target, "utf8") : ""
    if (current === next) {
      files[file] = "clean"
      continue
    }
    if (options.check === true) {
      files[file] = "stale"
      stale.push(file)
      continue
    }
    writeFileSync(target, next)
    files[file] = "written"
  }
  return {
    files,
    stale,
    counts: { pages: routes.pages.length, panes: routes.panes.length, flows: routes.flows.length }
  }
}
