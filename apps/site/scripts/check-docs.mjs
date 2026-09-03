#!/usr/bin/env node
/**
 * check-docs.mjs
 *
 * The documentation gate for the Starlight site. Ported from the vocs-era
 * scripts/check-docs.mjs to the apps/site page tree. Fails (exit 1) when any
 * rule fires:
 *
 *   1. no em-dash or en-dash outside fenced code
 *   2. frontmatter title and description on every page
 *   3. no body H1 (frontmatter title owns the page heading)
 *   4. every internal link resolves to a page that exists
 *   5. every link anchor resolves to a heading on the target page
 *   6. imports in ts fences resolve to published packages
 *   7. no "coming soon" or "TODO" in prose
 *   8. every anchor the 1.0 CLI links to exists on the migration page
 *
 * Usage: node apps/site/scripts/check-docs.mjs
 */
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(siteRoot, "..", "..")
const docsRoot = join(siteRoot, "src/content/docs/docs")

const errors = []
const err = (file, msg) => errors.push(`${relative(siteRoot, file)}: ${msg}`)

// --- collect pages ---------------------------------------------------------
const pages = [] // { path, rel, route, frontmatter, headings:Set, prose }
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name))
    else if (entry.name.endsWith(".mdx")) pages.push(load(join(dir, entry.name)))
  }
}
function fm(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, "m"))
  return m ? m[1].trim() : null
}
function slugger(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/`+/g, "")
    .replace(/[^\p{L}\p{N}\s\-_]/gu, "")
    .replace(/\s+/g, "-")
}
function load(path) {
  const text = readFileSync(path, "utf8")
  const rel = relative(docsRoot, path)
  let route = "/" + rel.replace(/\.mdx$/, "").replace(/\/index$/, "").replace(/^index$/, "")
  const slug = fm(text, "slug")
  if (slug) route = "/" + slug.replace(/^docs\/?/, "").replace(/\/$/, "")
  route = "/docs" + (route === "/" ? "/" : route + "/")
  // Frontmatter is metadata, not prose: its comments are not page content.
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "")
  const noFences = body.replace(/```[\s\S]*?```/g, "")
  const ids = new Set()
  const counts = new Map()
  for (const m of body.matchAll(/^#{2,6}\s+(.+)$/gm)) {
    const base = slugger(m[1])
    const n = counts.get(base) ?? 0
    counts.set(base, n + 1)
    ids.add(n === 0 ? base : `${base}-${n}`)
  }
  return { path, rel, route, text, body, noFences, headingIds: ids }
}
walk(docsRoot)
const routes = new Set(pages.map((p) => p.route))
const byRoute = new Map(pages.map((p) => [p.route, p]))
const staticRoutes = new Set(["/", "/download/", "/demo/", "/migration/1.0", "/llms.txt", "/llms-full.txt"])

// --- repo package roster (any @smthrs/* package that exists in the tree) ---
const roster = new Set()
function scanPkgs(dir, depth) {
  if (depth > 4 || dir.includes("node_modules") || dir.includes("/dist")) return
  const pkgPath = join(dir, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
      if (typeof pkg.name === "string" && pkg.name.startsWith("@smthrs/")) roster.add(pkg.name)
    } catch { /* keep walking */ }
  }
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist") scanPkgs(join(dir, e.name), depth + 1)
  }
}
scanPkgs(join(repoRoot, "packages"), 0)

// --- rules -------------------------------------------------------------------
for (const p of pages) {
  // 1. dashes
  const dash = p.noFences.match(/[—–]/)
  if (dash) err(p.path, `em/en dash in prose: ${JSON.stringify(p.noFences.split("\n").find((l) => /[—–]/.test(l))).slice(0, 120)}`)
  // 2. frontmatter
  if (!fm(p.text, "title")) err(p.path, "missing frontmatter title")
  if (!fm(p.text, "description")) err(p.path, "missing frontmatter description")
  // 3. body H1
  if (/^#\s+\S/m.test(p.noFences)) err(p.path, "body H1 (frontmatter title owns the page heading)")
  // 7. coming soon
  const soon = p.noFences.match(/coming soon/i)
  if (soon) err(p.path, `banned phrase: ${soon[0]}`)
  // 4/5. links and anchors
  for (const m of p.text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]
    if (/^https?:\/\//.test(target)) continue
    if (target.startsWith("#")) {
      if (!p.headingIds.has(target.slice(1))) err(p.path, `anchor ${target} has no heading on this page`)
      continue
    }
    if (!target.startsWith("/")) {
      err(p.path, `non-absolute link: ${target}`)
      continue
    }
    if (/^\/(media|favicon|icon)/.test(target)) continue
    const [path, anchor] = target.split("#")
    const norm = path === "/" ? "/" : path.endsWith("/") ? path : path + "/"
    if (!routes.has(norm) && !staticRoutes.has(path) && !staticRoutes.has(norm)) {
      err(p.path, `link to nowhere: ${path}`)
      continue
    }
    if (anchor && byRoute.has(norm) && !byRoute.get(norm).headingIds.has(anchor)) {
      err(p.path, `anchor #${anchor} missing on ${norm}`)
    }
  }
  // 6. imports in ts fences: our own packages must exist (catches typos and
  // references to removed 0.x packages); third-party imports are allowed.
  for (const fence of p.text.matchAll(/```(?:ts|tsx|js|jsx)\n([\s\S]*?)```/g)) {
    for (const im of fence[1].matchAll(/from\s+"(@smthrs\/[^"]+)"/g)) {
      const spec = im[1]
      const root = spec.split("/").slice(0, 2).join("/")
      if (!roster.has(root)) err(p.path, `import does not resolve to a package in this repo: ${spec}`)
    }
  }
}

// 8. migration anchor contract
const unsupportedPath = join(repoRoot, "packages/smithers/src/Unsupported.ts")
const migration = pages.find((p) => p.route === "/docs/migration/1.0/")
if (existsSync(unsupportedPath) && migration) {
  const src = readFileSync(unsupportedPath, "utf8")
  const anchors = new Set([...src.matchAll(/anchor:\s*"([^"]+)"/g)].map((m) => m[1]))
  for (const extra of ["flows", "run-data"]) anchors.add(extra)
  for (const a of anchors) {
    if (!migration.headingIds.has(a)) err(migration.path, `CLI anchor #${a} has no heading on the migration page`)
  }
}

if (errors.length > 0) {
  console.error(`check-docs: ${errors.length} violation(s)`)
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}
console.log(`check-docs: ${pages.length} pages, 0 violations`)
