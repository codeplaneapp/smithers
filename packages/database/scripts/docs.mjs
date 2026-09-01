#!/usr/bin/env node
/** Projects package-owned database documentation into the repository site. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Package } from "../Package.ts"

const check = process.argv.includes("--check")
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(packageRoot, "..", "..")
const read = (path) => readFileSync(path, "utf8")

const ungutter = (block) => block.split("\n").map((line) => line.replace(/^\s*\* ?/, "")).join("\n")

/**
 * The prose above the first block tag. The tags are enumerated rather than
 * matched as `@word`, because the barrel's comment opens on the scoped package
 * name and a generic pattern reads that as a tag and returns nothing.
 */
const blockTag =
  /^@(?:since|category|slop|private|internal|deprecated|example|param|returns|see|throws|typeParam|template|module)\b/
const description = (body) => {
  const lines = []
  for (const line of body.split("\n")) {
    if (blockTag.test(line)) break
    lines.push(line)
  }
  return lines.join("\n").trim()
}

const delink = (value) => value.replace(/\{@link\s+([^}]+)\}/g, "`$1`")

/**
 * Rewraps prose into paragraphs, leaving fenced code and list items intact: the
 * barrel's module comment carries an import example, and joining every line
 * would break the fence and collapse a list into one run-on paragraph.
 */
const paragraphs = (value) => {
  const blocks = []
  let current = []
  let fence = null
  const flush = () => {
    if (current.length > 0) blocks.push(current.join(fence === null ? " " : "\n"))
    current = []
  }
  for (const line of value.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (fence === null) {
        flush()
        fence = line
      } else {
        current.push(line.trim())
        flush()
        fence = null
        continue
      }
    }
    if (fence !== null) {
      current.push(fence === line ? line.trim() : line)
      continue
    }
    if (line.trim() === "") flush()
    else if (/^\s*[-*]\s/.test(line)) {
      // A bullet opens its own block so the list survives the rewrap; its
      // continuation lines join it below.
      flush()
      current.push(line.trim())
    } else current.push(line.trim())
  }
  flush()
  return blocks.join("\n\n")
}

const firstSentence = (value) => {
  const flat = delink(value).split("\n\n")[0].split("\n").join(" ")
  return (/^[\s\S]*?\.(?=\s|$)/.exec(flat)?.[0] ?? flat).trim()
}

const moduleDoc = (source, label) => {
  const match = /\/\*\*((?:[^*]|\*(?!\/))*)\*\//.exec(source)
  if (match === null) throw new Error(`database docs: ${label} has no module JSDoc block`)
  return delink(description(ungutter(match[1])))
}

/**
 * Exports carrying a `@category` tag, in declaration order. A namespace
 * re-export (`export * as X from`) is the barrel's own shape, so both forms are
 * recognized; an export with no category is deliberately absent from the table.
 */
const exportedDocs = (source) => {
  const entries = []
  const pattern =
    /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*\n(?:export (type|const|class|interface) (\w+)|export \* as (\w+) from)/g
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const body = ungutter(match[1])
    const category = /@category (\S+)/.exec(body)?.[1]
    if (category === undefined) continue
    entries.push({
      name: match[3] ?? match[4],
      declaration: match[2] ?? "namespace",
      category,
      summary: firstSentence(description(body))
    })
  }
  return entries
}

const manifest = JSON.parse(read(join(packageRoot, "package.json")))
if (manifest.name !== Package.name) {
  throw new Error("database docs: Package.ts and package.json names differ")
}

const failures = []

const sourceLink = (relative) =>
  `https://github.com/smithersai/smithers/blob/main/packages/database/${relative}`

for (const entry of [...Package.entries, ...Package.modules]) {
  if (!existsSync(join(packageRoot, entry.source))) {
    failures.push(`${entry.source}: declared in Package.ts but the file does not exist`)
  }
}

/**
 * The inventory assertion runs both ways: every entry names a file that exists
 * (above), and every module the `./*` export map publishes has an entries row
 * (here), so a new src module cannot ship as a supported import specifier
 * without appearing in the generated entry-point table. `src/internal/**` is
 * excluded because the export map maps `./internal/*` to `null`.
 */
const publishedSources = new Set(Package.entries.map((entry) => entry.source))
const walkSources = (relative) =>
  readdirSync(join(packageRoot, relative), { withFileTypes: true }).flatMap((dirent) =>
    dirent.isDirectory()
      ? dirent.name === "internal" ? [] : walkSources(`${relative}/${dirent.name}`)
      : dirent.name.endsWith(".ts")
      ? [`${relative}/${dirent.name}`]
      : []
  )
for (const source of walkSources("src")) {
  if (!publishedSources.has(source)) {
    failures.push(`${source}: published by the ./* export map but missing from Package.ts entries`)
  }
}

const entryTable = [
  "| Import | Source | Platform |",
  "| --- | --- | --- |",
  ...Package.entries.map((entry) =>
    `| \`${entry.specifier}\` | [${entry.source}](${sourceLink(entry.source)}) | ${entry.platform} |`
  )
].join("\n")

const moduleSection = (module) => {
  const source = read(join(packageRoot, module.source))
  const exports = exportedDocs(source)
  if (exports.length === 0) {
    failures.push(`${module.source}: no exports carry a @category tag`)
    return ""
  }
  const table = [
    "| Export | Kind | Summary |",
    "| --- | --- | --- |",
    ...exports.map((entry) => `| \`${entry.name}\` (${entry.declaration}) | ${entry.category} | ${entry.summary} |`)
  ].join("\n")
  // The module's opening sentence only. Its full comment argues the design at
  // length, and repeating that here is what let the hand-written page document
  // the package twice; the prose contract lives in `docs/api.md`.
  return `### ${module.title}

[${module.source}](${sourceLink(module.source)}). ${firstSentence(moduleDoc(source, module.source))}

${table}
`
}

const sections = Package.modules.map(moduleSection).join("\n")

const barrel = read(join(packageRoot, "src", "index.ts"))

/**
 * The barrel's comment opens with the package name as a title, which the page
 * already carries as its heading, so that opening block is dropped rather than
 * printed twice.
 */
const intro = paragraphs(moduleDoc(barrel, "src/index.ts"))
  .split("\n\n")
  .filter((block, index) => !(index === 0 && block.startsWith(Package.name)))
  .join("\n\n")

const apiPage = `---
description: "${manifest.description}."
---

{/* Generated by \`node packages/database/scripts/docs.mjs\` from packages/database. Edit package sources, never this file. */}

# @smthrs/database

${intro}

## Entry points

${entryTable}

${read(join(packageRoot, Package.api.source)).trim()}

## Exports

${sections.trim()}
`

const outputs = new Map([[Package.api.target, apiPage]])

for (const path of Package.references) {
  const content = read(join(repoRoot, path))
  if (!content.includes(Package.name) || !content.includes("/api/database")) {
    failures.push(`${path}: must reference ${Package.name} and /api/database`)
  }
}
for (const [path, content] of outputs) {
  if (content.includes("—")) failures.push(`${path}: generated content contains an em-dash`)
}

let drifted = false
for (const [path, content] of outputs) {
  const absolute = join(repoRoot, path)
  if (read(absolute) === content) continue
  drifted = true
  if (check) failures.push(`${path}: drifted; run node packages/database/scripts/docs.mjs`)
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
  check
    ? "✓ the database package documentation is current"
    : drifted
    ? "✓ database package documentation regenerated"
    : "✓ database package documentation already current"
)
