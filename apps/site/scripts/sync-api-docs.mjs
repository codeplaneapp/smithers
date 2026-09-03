#!/usr/bin/env node
/**
 * sync-api-docs.mjs
 *
 * Stitches each published package's colocated docs/api.md into a Starlight
 * reference page at src/content/docs/docs/reference/api/<short-name>.mdx.
 *
 * The colocated api.md stays the source of truth; this script rewrites the
 * links that targeted the old vocs routes, strips the stale generator
 * sentence, and prepends frontmatter. `--check` reports drift instead of
 * writing, so CI can fail when a package's docs change without a re-sync.
 *
 * Usage: node apps/site/scripts/sync-api-docs.mjs [--check]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, relative, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(siteRoot, "..", "..")
const outDir = join(siteRoot, "src/content/docs/docs/reference/api")
const checkMode = process.argv.includes("--check")

/**
 * reference/api/ is shared with scripts/ingest-reference.mjs, which owns the
 * pages for packages that carry agent-written docs/reference/*.md (wired into
 * //apps/site:referenceIngest). Those slugs are skipped here so a re-run can
 * never clobber their pages. As their coverage grows, add the slugs below.
 */
const foreignOwned = new Set(["flow", "engine", "targets"])

/** Discover published packages carrying a colocated docs/api.md. */
function discover() {
  const roots = [join(repoRoot, "packages")]
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    if (dir.includes("node_modules") || dir.includes("/dist")) return
    const pkgPath = join(dir, "package.json")
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
        const apiPath = join(dir, "docs", "api.md")
        if (pkg.publishConfig?.access === "public" && pkg.name?.startsWith("@smthrs/") && existsSync(apiPath)) {
          found.push({ name: pkg.name, description: pkg.description ?? "", dir, apiPath })
        }
      } catch {
        /* not a parseable package.json; keep walking */
      }
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist") {
        walk(join(dir, entry.name), depth + 1)
      }
    }
  }
  for (const root of roots) walk(root, 0)
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

const yamlQuote = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\s+/g, " ").trim()}"`

/** Rewrite old vocs-era links to Starlight routes. Returns [text, warnings]. */
function rewriteLinks(text, pkg) {
  const warnings = []
  let out = text
  // /api/<pkg> and https://smithers.sh/api/<pkg> -> /docs/reference/api/<pkg>/
  out = out.replace(/\]\((?:https:\/\/smithers\.sh)?\/api\/([a-z0-9-]+)(#[^)]+)?\)/gi, (_m, seg, frag) => `](/docs/reference/api/${seg.toLowerCase()}/${frag ?? ""})`)
  // Bare /api -> the API overview
  out = out.replace(/\]\((?:https:\/\/smithers\.sh)?\/api\)/gi, "]()/docs/reference/api/)")
  // /cli and /cli/<verb> -> /docs/reference/cli/...
  out = out.replace(/\]\((?:https:\/\/smithers\.sh)?\/cli\/([a-z0-9-]+)(#[^)]+)?\)/gi, (_m, seg, frag) => `](/docs/reference/cli/${seg.toLowerCase()}/${frag ?? ""})`)
  out = out.replace(/\]\((?:https:\/\/smithers\.sh)?\/cli\)/gi, "]()/docs/reference/cli/)")
  // smithers.sh/migration/1.0 -> site-relative
  out = out.replace(/\]\(https:\/\/smithers\.sh\/migration\/1\.0(#[^)]+)?\)/gi, (_m, frag) => `](/docs/migration/1.0/${frag ?? ""})`)
  // Colocated sibling files (testing.md, concepts.md, ...) have no site page;
  // point at the source on GitHub where the file always exists.
  const repoRel = relative(repoRoot, pkg.apiPath).split("\\").join("/")
  const docsDirUrl = `https://github.com/smithersai/smithers/blob/main/${dirname(repoRel)}`
  out = out.replace(/\]\(\.\/([a-z0-9-]+\.md)(#[^)]+)?\)/gi, (_m, f, frag) => `](${docsDirUrl}/${f}${frag ?? ""})`)
  out = out.replace(/\]\(([a-z0-9-]+\.md)(#[^)]+)?\)/gi, (_m, f, frag) => `](${docsDirUrl}/${f}${frag ?? ""})`)
  // Anything still pointing at smithers.sh is suspect: report it.
  for (const m of out.matchAll(/\]\(https:\/\/smithers\.sh([^)]*)\)/g)) {
    warnings.push(`unrewritten smithers.sh link: ${m[1]}`)
  }
  return [out, warnings]
}

function transform(pkg) {
  const warnings = []
  let body = readFileSync(pkg.apiPath, "utf8").trimStart()
  // Strip a leading H1: frontmatter title owns the page heading.
  body = body.replace(/^#\s+[^\n]+\n+/, "")
  // The old generator appended export tables; the line is stale here.
  const stale = /The export tables at the end of the page are generated[^\n]*\n?/g
  if (stale.test(body)) {
    body = body.replace(stale, "")
  }
  const [rewritten, linkWarnings] = rewriteLinks(body, pkg)
  warnings.push(...linkWarnings)
  // Em/en dash scan outside fences: warn so the gate owner can fix upstream.
  const prose = rewritten.replace(/```[\s\S]*?```/g, "")
  const dashes = (prose.match(/[—–]/g) ?? []).length
  if (dashes > 0) warnings.push(`${dashes} em/en dash(es) outside code fences`)
  const short = pkg.name.replace("@smthrs/", "")
  if (foreignOwned.has(short)) return { short, page: null, warnings: [] }
  // MDX has no HTML comments; the colocated READMEs mark generated regions with them.
  const mdxBody = rewritten.trimStart().replace(/<!--([\s\S]*?)-->/g, "{/*$1*/}")
  const page = `---
title: ${yamlQuote(pkg.name)}
description: ${yamlQuote(pkg.description)}
---

{/* Generated by apps/site/scripts/sync-api-docs.mjs from ${relative(repoRoot, pkg.apiPath).split("\\").join("/")}. Edit the source file, then re-run the script. */}

${mdxBody}
`
  return { short, page, warnings }
}

const packages = discover()
if (packages.length === 0) {
  console.error("sync-api-docs: no published packages with docs/api.md found")
  process.exit(1)
}

let drift = 0
let written = 0
const allWarnings = []
for (const pkg of packages) {
  const { short, page, warnings } = transform(pkg)
  if (page === null) continue
  written++
  const outPath = join(outDir, `${short}.mdx`)
  for (const w of warnings) allWarnings.push(`${pkg.name}: ${w}`)
  if (checkMode) {
    if (!existsSync(outPath) || readFileSync(outPath, "utf8") !== page) {
      console.error(`drift: ${relative(siteRoot, outPath)}`)
      drift++
    }
  } else {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(outPath, page)
  }
}

console.log(`${checkMode ? "checked" : "wrote"} ${written} API pages (${packages.length - written} skipped, owned by ingest-reference.mjs):`)
for (const p of packages) console.log(`  ${p.name}`)
if (allWarnings.length > 0) {
  console.log("warnings:")
  for (const w of allWarnings) console.log(`  ${w}`)
}
if (checkMode && drift > 0) {
  console.error(`sync-api-docs: ${drift} page(s) out of date; run node apps/site/scripts/sync-api-docs.mjs`)
  process.exit(1)
}
