/**
 * The vocs sidebar, read as data.
 *
 * `vocs.config.ts` is hand written, because sidebar order is editorial and no
 * generator can infer it. That makes it the one part of the documentation a new
 * page does not reach on its own: a generated CLI or control page can exist,
 * build, and ship while being navigable only by guessing its URL. This module
 * flattens the sidebar into the routes it offers so `check-docs.mjs` can compare
 * that set against the page tree in both directions.
 *
 * The 0.x changelogs are the one group left out on purpose. They are 44
 * historical entries reached from the changelog index, and listing them
 * individually would bury the 1.0 sections under release history for a runtime
 * this release removed. `isHistorical` in `docs-pages.mjs` is that rule, and it
 * is the only exemption.
 */
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { repoRoot } from "./docs-shared.mjs"

/** The site configuration, imported for its sidebar. */
export const configPath = join(repoRoot, "vocs.config.ts")

/** Collects every `link` in a sidebar tree, at any depth. */
export const linksOf = (items, out = new Set()) => {
  for (const item of items) {
    if (typeof item.link === "string") out.add(item.link)
    if (Array.isArray(item.items)) linksOf(item.items, out)
  }
  return out
}

/** Every route the sidebar offers, read from `vocs.config.ts`. */
export const sidebarRoutes = async () => linksOf((await import(pathToFileURL(configPath).href)).default.sidebar)
