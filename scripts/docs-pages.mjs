/**
 * The vocs page tree, read as data.
 *
 * `docs/pages` is the site: every published route is a `.md` or `.mdx` file
 * under it, and its frontmatter carries the description the site and the llms
 * bundles both use. The generator, the bundle builder, and the docs gate all
 * read the tree through this module, so none of them keeps a second list of
 * pages.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { repoRoot } from "./docs-contract.mjs"

/** The directory vocs serves as the site. */
export const pagesRoot = join(repoRoot, "docs", "pages")

/**
 * The directory vocs serves as static assets, at the site root.
 *
 * vocs resolves it as `<rootDir>/public`, and `rootDir` is the repository root,
 * so the release images live at `public/images` rather than under `docs/`.
 */
export const publicRoot = join(repoRoot, "public")

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.mdx?$/.test(name)) out.push(path)
  }
  return out
}

/** Splits YAML frontmatter off a page, returning the keys and the body. */
export const parseFrontmatter = (source) => {
  if (!source.startsWith("---\n")) return { frontmatter: {}, body: source }
  const end = source.indexOf("\n---\n", 4)
  if (end < 0) return { frontmatter: {}, body: source }
  const frontmatter = {}
  for (const line of source.slice(4, end).split("\n")) {
    const match = /^(\w+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const raw = match[2].trim()
    frontmatter[match[1]] = raw.startsWith('"') && raw.endsWith('"') ? JSON.parse(raw) : raw
  }
  return { frontmatter, body: source.slice(end + 5).replace(/^\n+/, "") }
}

/** The route a page file answers on. */
export const routeOf = (path) => {
  const rel = relative(pagesRoot, path).replace(/\.mdx?$/, "")
  if (rel === "index") return "/"
  return `/${rel.replace(/\/index$/, "")}`
}

/** Every page in the tree, in route order, with its frontmatter and body. */
export const pages = () =>
  walk(pagesRoot)
    .map((path) => {
      const source = readFileSync(path, "utf8")
      const { frontmatter, body } = parseFrontmatter(source)
      const heading = /^#\s+(.+)$/m.exec(body)
      return {
        path: relative(repoRoot, path),
        route: routeOf(path),
        title: heading === null ? undefined : heading[1].trim(),
        description: frontmatter.description,
        frontmatter,
        body
      }
    })
    .sort((left, right) => left.route.localeCompare(right.route))

const walkAll = (dir, out = []) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walkAll(path, out)
    else out.push(path)
  }
  return out
}

/** Every static asset vocs serves, as the route it answers on. */
export const assets = () => walkAll(publicRoot).map((path) => `/${relative(publicRoot, path)}`)

/**
 * Pages that record Smithers 0.x rather than describe Smithers 1.0.
 *
 * The 44 changelogs are release history for a runtime this release removed.
 * They keep their 0.x commands, package names, and JSX examples on purpose: an
 * operator reads them while migrating, and rewriting them would falsify the
 * record. Every prose gate that forbids a 0.x spelling exempts them, and the
 * llms bundles leave them out entirely.
 */
export const isHistorical = (route) => /^\/changelogs\/0\./.test(route)
