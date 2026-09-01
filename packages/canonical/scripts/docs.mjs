#!/usr/bin/env node
/**
 * The colocated documentation generator for `@smthrs/canonical`.
 *
 * Every published sentence about this package has one source inside the
 * package: the JSDoc in `src/`, the prose fragments in `docs/`, and the
 * `description` field of `package.json`. This script projects those sources
 * into the vocs tree:
 *
 *   docs/pages/api/canonical.md          written whole
 *   docs/pages/data-structures.md        the `canonical-serialization` region
 *
 * It also verifies that every page quoting the package description still
 * carries it verbatim, so the one-line summary cannot fork.
 *
 * The `//packages/canonical:docsPages` target runs this script: the `build`
 * verb writes, the `lint` verb drift-checks. `scripts/check-docs.mjs` runs
 * the `--check` form so the docs gate stays self-contained.
 *
 * Run: node packages/canonical/scripts/docs.mjs [--check]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const CHECK = process.argv.includes("--check")

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(packageRoot, "..", "..")

const read = (path) => readFileSync(path, "utf8")

/** The pages that quote the package description verbatim in a package table. */
const descriptionHolders = [
  "docs/pages/index.mdx",
  "docs/pages/architecture/package-map.md",
  "docs/pages/architecture/browser-support.md"
]

// -----------------------------------------------------------------------------
// JSDoc extraction
// -----------------------------------------------------------------------------

/** Strips the leading ` * ` gutter from the body of one JSDoc block. */
const ungutter = (block) =>
  block
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n")

/** The description of a JSDoc body: everything before the first `@` tag line. */
const description = (body) => {
  const kept = []
  for (const line of body.split("\n")) {
    if (/^@\w+/.test(line)) break
    kept.push(line)
  }
  return kept.join("\n").trim()
}

/** Replaces `{@link X}` with a code span so prose renders outside TypeScript. */
const delink = (text) => text.replace(/\{@link\s+([^}]+)\}/g, "`$1`")

/**
 * Renders a JSDoc description as page Markdown: wrapped paragraph lines join
 * into one line, fenced code blocks pass through verbatim.
 */
const paragraphs = (text) => {
  const blocks = []
  let paragraph = []
  let fence = []
  let fenced = false
  for (const line of text.split("\n")) {
    if (/^```/.test(line)) {
      if (fenced) {
        fence.push(line)
        blocks.push(fence.join("\n"))
        fence = []
      } else {
        if (paragraph.length > 0) blocks.push(paragraph.join(" "))
        paragraph = []
        fence = [line]
      }
      fenced = !fenced
      continue
    }
    if (fenced) {
      fence.push(line)
      continue
    }
    if (line.trim() === "") {
      if (paragraph.length > 0) blocks.push(paragraph.join(" "))
      paragraph = []
      continue
    }
    paragraph.push(line.trim())
  }
  if (paragraph.length > 0) blocks.push(paragraph.join(" "))
  return blocks.join("\n\n")
}

/** The first sentence of a JSDoc description, for a summary table cell. */
const firstSentence = (text) => {
  const flat = delink(text).split("\n\n")[0].split("\n").join(" ")
  const match = /^[\s\S]*?\.(?=\s|$)/.exec(flat)
  return (match ? match[0] : flat).trim()
}

/** The module JSDoc of one source file: the first block in it. */
const moduleDoc = (source) => {
  const match = /\/\*\*([\s\S]*?)\*\//.exec(source)
  if (match === null) throw new Error("canonical docs: no module JSDoc block")
  return delink(description(ungutter(match[1])))
}

/**
 * Every documented `export type` / `export const` of one source file, with
 * its `@category` and first-sentence summary, in declaration order.
 */
const exportedDocs = (source) => {
  const entries = []
  const pattern = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*\nexport (type|const) (\w+)/g
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const body = ungutter(match[1])
    const category = /@category (\S+)/.exec(body)?.[1]
    if (category === undefined) continue
    entries.push({
      name: match[3],
      declaration: match[2],
      category,
      summary: firstSentence(description(body))
    })
  }
  return entries
}

// -----------------------------------------------------------------------------
// Page assembly
// -----------------------------------------------------------------------------

const manifest = JSON.parse(read(join(packageRoot, "package.json")))
const summary = manifest.description
const intro = moduleDoc(read(join(packageRoot, "src", "index.ts")))

const barrel = read(join(packageRoot, "src", "index.ts"))
const modules = [...barrel.matchAll(/export \* from "\.\/(\w+)\.ts"/g)].map((match) => match[1])
const exports = modules.flatMap((name) => exportedDocs(read(join(packageRoot, "src", `${name}.ts`))))
if (exports.length === 0) throw new Error("canonical docs: no documented exports found")

const table = [
  "| Export | Kind | Summary |",
  "| --- | --- | --- |",
  ...exports.map((entry) => `| \`${entry.name}\` (${entry.declaration}) | ${entry.category} | ${entry.summary} |`)
].join("\n")

const apiFragment = read(join(packageRoot, "docs", "api.md")).trim()

const apiPage = `---
description: "${summary}."
---

{/* Generated by \`node packages/canonical/scripts/docs.mjs\` from the JSDoc and docs/ of packages/canonical. Edit those sources, never this file. */}

# @smthrs/canonical

${paragraphs(intro)}

## Public API

${apiFragment}

## Exports

${table}
`

// -----------------------------------------------------------------------------
// Region injection
// -----------------------------------------------------------------------------

const regionStart = (name) => `{/* generated:${name} start */}`
const regionEnd = (name) => `{/* generated:${name} end */}`

const replaceRegion = (source, name, body) => {
  const start = source.indexOf(regionStart(name))
  const end = source.indexOf(regionEnd(name))
  if (start < 0 || end < 0) throw new Error(`canonical docs: region ${name} is missing`)
  return `${source.slice(0, start)}${regionStart(name)}\n\n${body.trim()}\n\n${source.slice(end)}`
}

const serialization = read(join(packageRoot, "docs", "serialization.md")).trim()

// -----------------------------------------------------------------------------
// Verification and writes
// -----------------------------------------------------------------------------

const failures = []

const outputs = new Map([["docs/pages/api/canonical.md", apiPage]])
{
  const path = "docs/pages/data-structures.md"
  outputs.set(path, replaceRegion(read(join(repoRoot, path)), "canonical-serialization", serialization))
}

for (const [path, content] of outputs) {
  if (content.includes("—")) failures.push(`${path}: generated content contains an em-dash`)
}

for (const path of descriptionHolders) {
  if (!read(join(repoRoot, path)).includes(summary)) {
    failures.push(`${path}: does not quote the package description "${summary}"`)
  }
}

let drifted = false
for (const [path, content] of outputs) {
  const absolute = join(repoRoot, path)
  if (read(absolute) === content) continue
  drifted = true
  if (CHECK) failures.push(`${path}: drifted from its generated form; run node packages/canonical/scripts/docs.mjs`)
  else {
    writeFileSync(absolute, content)
    console.log(`wrote ${path}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}

console.log(
  CHECK
    ? "✓ the canonical package documentation is current"
    : drifted
    ? "✓ canonical package documentation regenerated"
    : "✓ canonical package documentation already current"
)
