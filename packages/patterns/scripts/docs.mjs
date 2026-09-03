#!/usr/bin/env node
/** Projects package-owned Patterns documentation into the repository site. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { Manifest } from "../docs/Manifest.ts"

const check = process.argv.includes("--check")
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(packageRoot, "..", "..")
const sourceRoot = join(packageRoot, "src")
const read = (path) => readFileSync(path, "utf8")

const ungutter = (block) =>
  block.split("\n").map((line) => line.replace(/^\s*\* ?/, "")).join("\n")

const description = (body) => {
  const lines = []
  for (const line of body.split("\n")) {
    if (/^@\w+/.test(line)) break
    lines.push(line)
  }
  return lines.join("\n").trim()
}

const delink = (value) => value.replace(/\{@link\s+([^}]+)\}/g, "`$1`")

const paragraphs = (value) => {
  const blocks = []
  let current = []
  for (const line of value.split("\n")) {
    if (line.trim() === "") {
      if (current.length > 0) blocks.push(current.join(" "))
      current = []
    } else current.push(line.trim())
  }
  if (current.length > 0) blocks.push(current.join(" "))
  return blocks.join("\n\n")
}

const firstSentence = (value) => {
  const flat = delink(value).split("\n\n")[0].split("\n").join(" ")
  return (/^[\s\S]*?\.(?=\s|$)/.exec(flat)?.[0] ?? flat).trim()
}

const moduleDoc = (source, name) => {
  const match = /\/\*\*([\s\S]*?)\*\//.exec(source)
  if (match === null) throw new Error(`patterns docs: ${name} has no module JSDoc block`)
  return delink(description(ungutter(match[1])))
}

const exportedDocs = (source) => {
  const entries = []
  const pattern = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*\nexport (type|interface|const|class) (\w+)/g
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const body = ungutter(match[1])
    if (/@category (\S+)/.exec(body)?.[1] === undefined) continue
    entries.push(match[3])
  }
  return [...new Set(entries)]
}

const publicSources = (directory) => {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== "internal") found.push(...publicSources(path))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === "index.ts") continue
    found.push(relative(sourceRoot, path).split(sep).join("/").slice(0, -3))
  }
  return found.sort()
}

const manifest = JSON.parse(read(join(packageRoot, "package.json")))
if (manifest.name !== Manifest.name) throw new Error("patterns docs: Manifest.ts and package.json names differ")

const barrel = read(join(sourceRoot, "index.ts"))
const modules = [...barrel.matchAll(/export \* as (\w+) from "\.\/([^"]+)\.ts"/g)].map((match) => ({
  name: match[1],
  source: match[2]
}))
const discovered = publicSources(sourceRoot)
const declared = modules.map((entry) => entry.source)
const missing = discovered.filter((name) => !declared.includes(name))
const extra = declared.filter((name) => !discovered.includes(name))
const duplicateNames = modules.filter((entry, index) => modules.findIndex((other) => other.name === entry.name) !== index)
const duplicateSources = modules.filter(
  (entry, index) => modules.findIndex((other) => other.source === entry.source) !== index
)
const mismatched = modules.filter((entry) => entry.name !== basename(entry.source))
if (missing.length > 0 || extra.length > 0 || duplicateNames.length > 0 || duplicateSources.length > 0 || mismatched.length > 0) {
  const details = [
    missing.length === 0 ? undefined : `missing ${missing.join(", ")}`,
    extra.length === 0 ? undefined : `unknown ${extra.join(", ")}`,
    duplicateNames.length === 0 ? undefined : `duplicate namespaces ${duplicateNames.map((entry) => entry.name).join(", ")}`,
    duplicateSources.length === 0
      ? undefined
      : `duplicate sources ${duplicateSources.map((entry) => entry.source).join(", ")}`,
    mismatched.length === 0
      ? undefined
      : `namespace/source mismatches ${mismatched.map((entry) => `${entry.name}:${entry.source}`).join(", ")}`
  ].filter(Boolean)
  throw new Error(`patterns docs: barrel and public modules differ: ${details.join("; ")}`)
}

const moduleEntries = modules.map((entry) => {
  const source = read(join(sourceRoot, `${entry.source}.ts`))
  const exports = exportedDocs(source)
  if (exports.length === 0) throw new Error(`patterns docs: ${entry.name} has no @category-carrying exports`)
  return {
    ...entry,
    summary: firstSentence(moduleDoc(source, entry.name)),
    exports
  }
})

const cell = (value) => value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ")
const tableRows = moduleEntries.map((entry) => [
  `\`${entry.name}\``,
  `\`${Manifest.name}/${entry.source}\``,
  cell(entry.summary),
  entry.exports.map((name) => `\`${name}\``).join(", ")
])
const tableHeaders = ["Module", "Import specifier", "Summary", "Public exports"]
const tableWidths = tableHeaders.map((header, index) =>
  Math.max(header.length, 3, ...tableRows.map((row) => row[index].length))
)
const tableLine = (row) => `| ${row.map((value, index) => value.padEnd(tableWidths[index])).join(" | ")} |`
const table = [
  tableLine(tableHeaders),
  tableLine(tableWidths.map((width) => "-".repeat(width))),
  ...tableRows.map(tableLine)
].join("\n")

const banner =
  "{/* Generated by `node packages/patterns/scripts/docs.mjs` from packages/patterns. Edit package sources, never this file. */}"
const renderPage = (page, body, intro = "") => `---
description: ${JSON.stringify(page.description)}
---

${banner}

# ${page.title}

${intro === "" ? "" : `${intro.trim()}\n\n`}${body.trim()}
`

const modulesMarker = "<!-- generated:modules -->"
const apiSource = read(join(packageRoot, Manifest.api.source))
if (apiSource.split(modulesMarker).length !== 2) {
  throw new Error(`patterns docs: ${Manifest.api.source} must contain one ${modulesMarker} marker`)
}
const apiBody = apiSource.replace(modulesMarker, `## Modules\n\n${table}`)

const outputs = new Map([
  [
    Manifest.api.target,
    renderPage(Manifest.api, apiBody, paragraphs(moduleDoc(barrel, "index.ts")))
  ],
  ...Manifest.pages.map((page) => [page.target, renderPage(page, read(join(packageRoot, page.source)))])
])

const outputPath = (target) => target === "README.md" ? `packages/patterns/${target}` : target
const regionMarkers = (target, name) =>
  target.endsWith("README.md")
    ? [`<!-- generated:${name} start -->`, `<!-- generated:${name} end -->`]
    : [`{/* generated:${name} start */}`, `{/* generated:${name} end */}`]
const replaceRegion = (source, target, name, body) => {
  const [startMarker, endMarker] = regionMarkers(target, name)
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  if (start < 0 || end < 0 || end < start) throw new Error(`patterns docs: region ${name} is missing from ${target}`)
  return `${source.slice(0, start)}${startMarker}\n\n${body.trim()}\n\n${source.slice(end)}`
}

for (const snippet of Manifest.snippets) {
  const target = outputPath(snippet.target)
  const current = outputs.get(target) ?? read(join(repoRoot, target))
  const body = `${read(join(packageRoot, snippet.source)).trim()}\n\n${table}`
  outputs.set(target, replaceRegion(current, target, snippet.region, body))
}

const failures = []
for (const path of Manifest.references) {
  if (!read(join(repoRoot, path)).includes(Manifest.name)) failures.push(`${path}: must reference ${Manifest.name}`)
}
for (const [path, content] of outputs) {
  if (content.includes("—")) failures.push(`${path}: generated content contains an em-dash`)
}

let drifted = false
for (const [path, content] of outputs) {
  const absolute = join(repoRoot, path)
  if (read(absolute) === content) continue
  drifted = true
  if (check) failures.push(`${path}: drifted; run node packages/patterns/scripts/docs.mjs`)
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
    ? "✓ the patterns package documentation is current"
    : drifted
    ? "✓ patterns package documentation regenerated"
    : "✓ patterns package documentation already current"
)
