#!/usr/bin/env node
/**
 * sync-content.mjs
 *
 * Stitches one source package's colocated docs (<pkg>/docs/**) into the
 * Starlight content tree of its site at apps/docs/<slug>/src/content/docs/.
 * The colocated docs stay the source of truth; the committed synced copy is
 * the cache. `--check` reports drift instead of writing, so lint can fail
 * when a package's docs change without a re-sync.
 *
 * File mapping (docs/ relative -> site route):
 *
 *   docs/README.md      -> index.md          -> /
 *   docs/api.md         -> reference/api.md  -> /reference/api/
 *   docs/guides/x.md    -> guides/x.md       -> /guides/x/
 *   docs/testing.md     -> testing.md        -> /testing/
 *   docs/a/README.md    -> a/index.md        -> /a/
 *
 * Frontmatter: a source block is kept verbatim, with `title`, `description`,
 * and `editUrl` appended when absent (house style requires the first two;
 * editUrl pins the edit link to the exact source file). Without a source
 * block one is synthesized: the title from the file mapping (README -> the
 * package's npm name, api.md -> "API reference", else the Title-Cased file
 * or directory name) and the description from the source package.json.
 *
 * Link rewriting and the leading-H1 strip are documented in AUTHORING.md.
 *
 * Usage:
 *   node apps/docs/shared/sync-content.mjs <slug> [--check]
 *   node apps/docs/shared/sync-content.mjs --all [--check]
 *   node ../shared/sync-content.mjs [--check]   (from apps/docs/<slug>)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, posix, relative, resolve } from "node:path"
import { bySlug, docsRoot, repoRoot, sites } from "./manifest.mjs"
import { fileURLToPath } from "node:url"

const checkMode = process.argv.includes("--check")
const allMode = process.argv.includes("--all")
const slugArg = process.argv.slice(2).find((arg) => !arg.startsWith("-"))

const yamlQuote = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\s+/g, " ").trim()}"`

const titleCase = (name) =>
  name.split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")

/** The content-tree path a source docs file syncs to, relative to src/content/docs. */
export const outputRelFor = (srcRel) => {
  if (srcRel === "api.md") return "reference/api.md"
  if (basename(srcRel) === "README.md") {
    const dir = posix.dirname(srcRel)
    return dir === "." ? "index.md" : `${dir}/index.md`
  }
  return srcRel
}

/** The site route of a synced content path, with leading and trailing slash. */
export const routeFor = (outputRel) => {
  const noExt = outputRel.replace(/\.mdx?$/, "")
  if (noExt === "index") return "/"
  if (noExt.endsWith("/index")) return `/${noExt.slice(0, -"/index".length)}/`
  return `/${noExt}/`
}

/** The fallback page title for a source docs file missing frontmatter title. */
const titleFor = (srcRel, entry) => {
  if (srcRel === "README.md") return entry.name
  if (srcRel === "api.md") return "API reference"
  if (basename(srcRel) === "README.md") return titleCase(posix.basename(posix.dirname(srcRel)))
  return titleCase(basename(srcRel).replace(/\.md$/, ""))
}

/** Every Markdown file under the source package's docs directory, sorted, as docs-relative posix paths. */
const discoverSources = (srcDocs) => {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.name.endsWith(".md")) found.push(relative(srcDocs, abs).split("\\").join("/"))
    }
  }
  if (existsSync(srcDocs)) walk(srcDocs)
  return found.sort()
}

/**
 * Removes the first H1 when it leads the document, skipping blank lines and
 * whole comment blocks ahead of it. The frontmatter title owns the page
 * heading; a leading source H1 would duplicate it. H1s after other content
 * are the author's to fix, not the sync's to hide.
 */
const stripLeadingH1 = (body) => {
  const lines = body.split("\n")
  let commentEnd = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    if (commentEnd !== null) {
      if (line.includes(commentEnd)) commentEnd = null
      i++
      continue
    }
    if (line === "") { i++; continue }
    if (line.startsWith("{/*")) {
      if (!line.includes("*/}")) commentEnd = "*/}"
      i++
      continue
    }
    if (line.startsWith("<!--")) {
      if (!line.includes("-->")) commentEnd = "-->"
      i++
      continue
    }
    break
  }
  if (i < lines.length && /^#\s+/.test(lines[i])) lines.splice(i, 1)
  return lines.join("\n")
}

/** One link-target rewrite, in the order the rules are documented in AUTHORING.md. */
const rewriteTarget = (target, ctx) => {
  const { entry, ownRoutes, srcRel, warnings } = ctx
  // 1. Same-page anchors pass through.
  if (target.startsWith("#")) return target
  // 2. Absolute URLs: only smithers.sh forms are rewritten.
  if (/^https?:\/\//i.test(target)) {
    let m = target.match(/^https:\/\/smithers\.sh\/api\/([a-z0-9-]+)\/?(#[\s\S]*)?$/i)
    if (m) return siblingApi(m[1], m[2], ctx)
    m = target.match(/^https:\/\/smithers\.sh\/cli(?:\/([a-z0-9-]+))?\/?(#[\s\S]*)?$/i)
    if (m) return cliRef(m[1], m[2])
    m = target.match(/^https:\/\/smithers\.sh\/migration\/([a-z0-9.-]+)\/?(#[\s\S]*)?$/i)
    if (m) return `https://smithers.sh/docs/migration/${m[1]}/${m[2] ?? ""}`
    if (/^https:\/\/smithers\.sh\/docs(\/|$)/.test(target)) return target
    if (/^https:\/\/smithers\.sh/.test(target)) warnings.push(`unrewritten smithers.sh link: ${target}`)
    return target
  }
  // 3. /api/<slug>: a package API page. Own slug stays on this site.
  let m = target.match(/^\/api\/([a-z0-9-]+)\/?(#[\s\S]*)?$/i)
  if (m) return siblingApi(m[1], m[2], ctx)
  if (/^\/api\/?$/i.test(target)) return "https://smithers.sh/docs/reference/api/"
  // 3b. /pkg/<slug>/<path>: any page of a package's site.
  m = target.match(/^\/pkg\/([a-z0-9-]+)((?:\/[^#]*)?)(#[\s\S]*)?$/i)
  if (m) return siblingPage(m[1], m[2], m[3], ctx)
  // 4. /cli verbs live on smithers.sh.
  m = target.match(/^\/cli\/([a-z0-9-]+)\/?(#[\s\S]*)?$/i)
  if (m) return cliRef(m[1], m[2])
  if (/^\/cli\/?$/i.test(target)) return "https://smithers.sh/docs/reference/cli/"
  // 5. /docs/<rest>: smithers.sh docs pages.
  m = target.match(/^\/docs(\/[\s\S]*)?$/i)
  if (m) {
    const rest = (m[1] ?? "/").replace(/^\/+|\/+$/g, "")
    if (rest === "") return "https://smithers.sh/docs/"
    const [path, ...frag] = rest.split("#")
    return `https://smithers.sh/docs/${path.replace(/\/+$/, "")}/${frag.length > 0 ? `#${frag.join("#")}` : ""}`
  }
  // 6. /migration/<rest>: migration pages live under /docs on smithers.sh.
  m = target.match(/^\/migration\/([a-z0-9.-]+)\/?(#[\s\S]*)?$/i)
  if (m) return `https://smithers.sh/docs/migration/${m[1]}/${m[2] ?? ""}`
  // 7. Other root-absolute paths: this site's own route when one exists.
  if (target.startsWith("/")) {
    const [path, ...fragParts] = target.split("#")
    const frag = fragParts.length > 0 ? `#${fragParts.join("#")}` : ""
    const normalized = `${path.replace(/\/+$/, "")}/`
    if (ownRoutes.has(normalized)) return `${normalized}${frag}`
    // Static assets are not docs routes; leave them to the site's public tree.
    if (/^\/(media|favicon|icon|llms)/.test(path) || /\.[a-z0-9]+$/i.test(path)) return target
    warnings.push(`root link has no page on this site; sent to smithers.sh docs: ${target}`)
    return `https://smithers.sh/docs${normalized}${frag}`
  }
  // 8. Relative links.
  return rewriteRelative(target, ctx, srcRel, warnings)
}

/**
 * /api/<slug> -> the sibling package's site, or this site's own API page.
 *
 * An unknown slug is warned about rather than rewritten silently. The rewrite
 * mints a hostname, so a typo (`/api/step_cache`, `/api/build`) would produce
 * a link to a subdomain that does not exist and would never 404 at build time.
 * Checking against the manifest is the only thing standing between a misspelt
 * slug and a dead link on a published page.
 */
const siblingApi = (seg, frag, ctx) => {
  const slug = seg.toLowerCase()
  if (slug === ctx.entry.slug) return `/reference/api/${frag ?? ""}`
  if (!bySlug.has(slug)) {
    ctx.warnings.push(`/api/ link names no package site: /api/${seg}`)
  }
  return `https://${slug}.smithers.sh/reference/api/${frag ?? ""}`
}

/**
 * /pkg/<slug>/<path> -> any page of a sibling package's site, the general
 * form that /api/<slug> is the common shortcut for. It exists because the
 * fleet cross-links guides and concepts, not only API pages: without it an
 * author reaching for another package's delegation guide either drops to its
 * API page or hand-writes a hostname, and a hand-written hostname is the one
 * link form a domain change cannot fix.
 *
 * A link to this site's own slug stays a local route, so a page moving
 * between packages keeps working.
 */
const siblingPage = (seg, rest, frag, ctx) => {
  const slug = seg.toLowerCase()
  const path = (rest ?? "").replace(/^\/+|\/+$/g, "")
  const route = path === "" ? "/" : `/${path}/`
  if (!bySlug.has(slug)) {
    ctx.warnings.push(`/pkg/ link names no package site: /pkg/${seg}`)
  }
  if (slug === ctx.entry.slug) return `${route}${frag ?? ""}`
  return `https://${slug}.smithers.sh${route}${frag ?? ""}`
}

/** /cli/<verb> -> the CLI reference on smithers.sh. */
const cliRef = (verb, frag) =>
  verb === undefined
    ? `https://smithers.sh/docs/reference/cli/${frag ?? ""}`
    : `https://smithers.sh/docs/reference/cli/${verb.toLowerCase()}/${frag ?? ""}`

/** Relative link forms: sibling docs pages, escapes, and repo-file references. */
const rewriteRelative = (target, ctx, srcRel, warnings) => {
  const { entry } = ctx
  const [path, ...fragParts] = target.split("#")
  const frag = fragParts.length > 0 ? `#${fragParts.join("#")}` : ""
  // Media is the author's to host: AUTHORING.md says assets are not synced, so
  // a relative image keeps whatever the author wrote rather than becoming a
  // GitHub blob page, which would not render as an image.
  if (/\.(png|jpe?g|gif|svg|webp|avif|mp4|webm|ico)$/i.test(path)) return target
  // Any other relative non-Markdown link names a repository file: prose about
  // `./PACKAGE.ts`, or a pointer into `../src`. Left alone it would ship as a
  // site-relative URL to a route that does not exist, which is a broken link on
  // a published page rather than a visible build failure. Send it to GitHub,
  // where the file actually is, and warn when it does not exist at all.
  if (!/\.md$/i.test(path)) {
    const fromDirRaw = posix.dirname(srcRel)
    const repoRel = posix.normalize(
      posix.join(entry.dir, "docs", fromDirRaw === "." ? "" : fromDirRaw, path)
    )
    if (repoRel.startsWith("../")) {
      warnings.push(`relative link escapes the repository: ${target}`)
      return target
    }
    if (!existsSync(join(repoRoot, repoRel))) {
      warnings.push(`link target does not exist: ${target} -> ${repoRel}`)
    }
    return `https://github.com/smithersai/smithers/blob/main/${repoRel}${frag}`
  }
  const fromDir = posix.dirname(srcRel)
  // "./docs/x.md" names a file in the package's docs directory as a file on
  // GitHub: prose about the docs files themselves, never a site route.
  const asDocsFile = path.match(/^\.\/docs\/(.+\.md)$/i)
  if (asDocsFile) {
    return `https://github.com/smithersai/smithers/blob/main/${entry.dir}/docs/${asDocsFile[1]}${frag}`
  }
  const resolved = posix.normalize(posix.join(fromDir, path))
  if (resolved === ".." || resolved.startsWith("../")) {
    // Escapes the docs tree: a repo file (package README, a source file).
    const repoRel = posix.normalize(posix.join(entry.dir, "docs", fromDir === "." ? "" : fromDir, path))
    if (!existsSync(join(repoRoot, repoRel))) warnings.push(`link target does not exist: ${target} -> ${repoRel}`)
    return `https://github.com/smithersai/smithers/blob/main/${repoRel}${frag}`
  }
  if (ctx.sourceSet.has(resolved)) return `${routeFor(outputRelFor(resolved))}${frag}`
  warnings.push(`link target is not a page of this site; sent to GitHub: ${target}`)
  return `https://github.com/smithersai/smithers/blob/main/${entry.dir}/docs/${resolved}${frag}`
}

/** Rewrites every markdown link target in a page body. */
const rewriteLinks = (body, ctx) =>
  body.replace(/\]\(([^)\s]+)\)/g, (_match, target) => `](${rewriteTarget(target, ctx)})`)

/**
 * The normalized page for one source docs file: frontmatter completed, the
 * leading H1 stripped, links rewritten, MDX comments made HTML comments.
 */
const transform = (entry, srcRel, text, ctx) => {
  let frontmatter = null
  let body = text
  const fm = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (fm) {
    frontmatter = fm[1]
    body = text.slice(fm[0].length)
  }
  body = stripLeadingH1(body)
  body = rewriteLinks(body, ctx)
  // Starlight serves plain markdown; MDX comments would render as text.
  body = body.replace(/\{\/\*([\s\S]*?)\*\/\}/g, "<!--$1-->")
  const appended = []
  if (frontmatter === null || !/^title:/m.test(frontmatter)) appended.push(`title: ${yamlQuote(titleFor(srcRel, entry))}`)
  if (frontmatter === null || !/^description:/m.test(frontmatter)) {
    appended.push(`description: ${yamlQuote(entry.description || `Documentation for ${entry.name}.`)}`)
  }
  if (frontmatter === null || !/^editUrl:/m.test(frontmatter)) {
    appended.push(`editUrl: ${yamlQuote(`https://github.com/smithersai/smithers/edit/main/${entry.dir}/docs/${srcRel}`)}`)
  }
  const block = frontmatter === null
    ? `${appended.join("\n")}\n`
    : `${frontmatter.replace(/\n+$/, "")}\n${appended.length > 0 ? `${appended.join("\n")}\n` : ""}`
  return `---\n${block}---\n\n${body.replace(/^\s*\n+/, "").replace(/\s*$/, "")}\n`
}

/** The full expected content tree of one site: output relative path -> bytes. */
const planSite = (entry) => {
  const warnings = []
  const srcDocs = join(repoRoot, entry.dir, "docs")
  const sources = discoverSources(srcDocs)
  const sourceSet = new Set(sources)
  const files = new Map()
  for (const srcRel of sources) {
    const ctx = { entry, ownRoutes: new Set(sources.map((rel) => routeFor(outputRelFor(rel)))), sourceSet, srcRel, warnings }
    const text = readFileSync(join(srcDocs, srcRel), "utf8")
    files.set(outputRelFor(srcRel), transform(entry, srcRel, text, ctx))
  }
  return { files, warnings }
}

/** Applies or checks one site's content tree. Returns the drift count. */
const syncSite = (entry) => {
  const { files, warnings } = planSite(entry)
  const outRoot = join(entry.siteDir, "src/content/docs")
  let drift = 0
  const existing = []
  const walkOut = (dir) => {
    if (!existsSync(dir)) return
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, item.name)
      if (item.isDirectory()) walkOut(abs)
      else if (item.name.endsWith(".md")) existing.push(abs)
    }
  }
  walkOut(outRoot)
  for (const abs of existing) {
    const rel = relative(outRoot, abs).split("\\").join("/")
    if (!files.has(rel)) {
      drift++
      if (checkMode) console.error(`stale: ${entry.slug}/${rel}`)
      else rmSync(abs)
    }
  }
  for (const [rel, content] of [...files.entries()].sort()) {
    const abs = join(outRoot, rel)
    if (checkMode) {
      if (!existsSync(abs) || readFileSync(abs, "utf8") !== content) {
        console.error(`drift: ${entry.slug}/src/content/docs/${rel}`)
        drift++
      }
    } else {
      if (existsSync(abs) && readFileSync(abs, "utf8") === content) continue
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
  }
  // Prune directories a deletion left empty so the tree mirrors the sources.
  if (!checkMode && existsSync(outRoot)) {
    const prune = (dir) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (item.isDirectory()) {
          const abs = join(dir, item.name)
          prune(abs)
          if (readdirSync(abs).length === 0) rmSync(abs)
        }
      }
    }
    prune(outRoot)
  }
  for (const warning of warnings) console.log(`  warning: ${entry.slug}: ${warning}`)
  return drift
}

/** The slug to sync: the argument, then SMITHERS_DOCS_SLUG (how the
 * contentSync Generate targets pass it: a Generate script spawns from the
 * workspace root with no argv), then the site directory this runs from. */
const inferSlug = () => {
  if (slugArg) {
    if (!bySlug.has(slugArg)) {
      console.error(`sync-content: unknown slug "${slugArg}" (see apps/docs/shared/manifest.mjs)`)
      process.exit(1)
    }
    return slugArg
  }
  const fromEnv = process.env.SMITHERS_DOCS_SLUG
  if (fromEnv && bySlug.has(fromEnv)) return fromEnv
  const cwd = process.cwd()
  const base = basename(cwd)
  if (bySlug.has(base) && join(docsRoot, base) === cwd) return base
  console.error("sync-content: pass a slug or --all (or run from apps/docs/<slug>)")
  process.exit(1)
}

/**
 * The CLI runs only when this file is the process entry point. It is also
 * imported as a module: apps/site/scripts/sync-api-docs.mjs reuses
 * `outputRelFor` and `routeFor` so an api.md link that names a sibling page
 * resolves to the same route on smithers.sh that it does on the package's own
 * site. Without this guard that import would run the whole sync and exit.
 */
const isEntryPoint = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  const selected = allMode ? sites.map((site) => site.slug) : [inferSlug()]
  let totalDrift = 0
  for (const slug of selected) {
    const drift = syncSite(bySlug.get(slug))
    totalDrift += drift
    console.log(`${checkMode ? "checked" : "synced"} ${slug}: ${drift === 0 ? "clean" : `${drift} drifted`}`)
  }
  if (checkMode && totalDrift > 0) {
    console.error(`sync-content: ${totalDrift} file(s) out of date; run node apps/docs/shared/sync-content.mjs${allMode ? " --all" : ""}`)
    process.exit(1)
  }
}
