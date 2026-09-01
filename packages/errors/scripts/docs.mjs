#!/usr/bin/env node
/** Projects package-owned error documentation into the repository site. */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Package } from "../Package.ts"
import { knownSmithersErrorCodes, smithersErrorDefinitions } from "../src/ErrorCode.ts"

const check = process.argv.includes("--check")
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(packageRoot, "..", "..")
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

const moduleDoc = (source) => {
  const match = /\/\*\*([\s\S]*?)\*\//.exec(source)
  if (match === null) throw new Error("errors docs: no module JSDoc block")
  return delink(description(ungutter(match[1])))
}

const exportedDocs = (source) => {
  const entries = []
  const pattern = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*\nexport (type|const|class|interface) (\w+)/g
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

const escapeCell = (value) => value.replaceAll("|", "\\|").replaceAll("\n", " ")
const displayWidth = (value) => [...value.replaceAll("\\|", "|")].length
const padCell = (value, width) => `${value}${" ".repeat(width - displayWidth(value))}`
const markdownTable = (header, rows) => {
  const escapedHeader = header.map(escapeCell)
  const escapedRows = rows.map((row) => row.map(escapeCell))
  const widths = escapedHeader.map((cell, index) =>
    Math.max(3, displayWidth(cell), ...escapedRows.map((row) => displayWidth(row[index])))
  )
  const render = (row) => `| ${row.map((cell, index) => padCell(cell, widths[index])).join(" | ")} |`
  return [
    render(escapedHeader),
    render(widths.map((width) => "-".repeat(width))),
    ...escapedRows.map(render)
  ].join("\n")
}

const manifest = JSON.parse(read(join(packageRoot, "package.json")))
if (manifest.name !== Package.name) throw new Error("errors docs: Package.ts and package.json names differ")

const codeRows = knownSmithersErrorCodes.map((code) => {
  const definition = smithersErrorDefinitions[code]
  if (definition.when.trim() === "") throw new Error(`errors docs: ${code} has an empty when definition`)
  const details = "details" in definition
    ? definition.details.includes("`") ? definition.details : `\`${definition.details}\``
    : "none"
  return [`\`${code}\``, definition.when, details]
})
const codesTable = markdownTable(["Code", "Raised when", "`details`"], codeRows)

const barrel = read(join(packageRoot, "src", "index.ts"))
const modules = [...new Set([...barrel.matchAll(/from "\.\/(\w+)\.ts"/g)].map((match) => match[1]))]
if (paragraphs(moduleDoc(barrel)) === "") throw new Error("errors docs: empty module JSDoc block")
const exports = modules.flatMap((name) => exportedDocs(read(join(packageRoot, "src", `${name}.ts`))))
if (exports.length === 0) throw new Error("errors docs: no documented exports found")
const exportsTable = markdownTable(
  ["Export", "Kind", "Summary"],
  exports.map((entry) => [
    `\`${entry.name}\` (${entry.declaration})`,
    entry.category,
    entry.summary
  ])
)

const usesMdxMarkers = (path) => path.startsWith("docs/pages/")
const regionStart = (path, name) => usesMdxMarkers(path)
  ? `{/* generated:${name} start */}`
  : `<!-- generated:${name} start -->`
const regionEnd = (path, name) => usesMdxMarkers(path)
  ? `{/* generated:${name} end */}`
  : `<!-- generated:${name} end -->`
const replaceRegion = (source, name, body, path) => {
  const startMarker = regionStart(path, name)
  const endMarker = regionEnd(path, name)
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`errors docs: region ${name} is missing from ${path}`)
  }
  return `${source.slice(0, start)}${startMarker}\n\n${body.trim()}\n\n${source.slice(end)}`
}

let reference = read(join(packageRoot, Package.api.source)).trim()
reference = replaceRegion(reference, "error-codes", codesTable, Package.api.target)
reference = replaceRegion(reference, "error-exports", exportsTable, Package.api.target)
reference = reference.replace(/^<!-- dprint-ignore-(?:start|end) -->\n?/gm, "")
const apiPage = `---
description: "${manifest.description}."
---

{/* Generated by \`node packages/errors/scripts/docs.mjs\` from packages/errors. Edit package sources, never this file. */}

# Error codes

${reference.trim()}
`

const outputs = new Map([[Package.api.target, apiPage]])
for (const snippet of Package.snippets) {
  const path = snippet.target.startsWith("docs/pages/") ? snippet.target : `packages/errors/${snippet.target}`
  const current = outputs.get(path) ?? read(join(repoRoot, path))
  const body = snippet.region === "error-codes" ? codesTable : snippet.region === "error-exports" ? exportsTable : undefined
  if (body === undefined) throw new Error(`errors docs: no generated body for region ${snippet.region}`)
  outputs.set(path, replaceRegion(current, snippet.region, body, path))
}

const failures = []
for (const path of Package.references) {
  const content = read(join(repoRoot, path))
  if (!content.includes("/reference/errors")) failures.push(`${path}: must reference /reference/errors`)
}
for (const [path, content] of outputs) {
  if (content.includes("—")) failures.push(`${path}: generated content contains an em-dash`)
}

let drifted = false
for (const [path, content] of outputs) {
  const absolute = join(repoRoot, path)
  if (read(absolute) === content) continue
  drifted = true
  if (check) failures.push(`${path}: drifted; run node packages/errors/scripts/docs.mjs`)
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
    ? "✓ the errors package documentation is current"
    : drifted
    ? "✓ errors package documentation regenerated"
    : "✓ errors package documentation already current"
)
