#!/usr/bin/env node
/**
 * Projects package-owned migration-tool documentation into the repository
 * site.
 *
 * The reference page is the package's contract with an operator deciding
 * whether to run `apply`, so it is built from three sources the package owns:
 * the barrel's module JSDoc, the prose in `docs/api.md`, and an exports table
 * read from every public module's JSDoc. The scanner modules are the barrel's
 * namespaces; the flow modules are reached by subpath only (the barrel must
 * never load the runtime) and are listed from `src/flow/` directly, `bin.ts`
 * excepted because it is an executable, not an API.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Manifest } from "../docs/Manifest.ts"

const check = process.argv.includes("--check")
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(packageRoot, "..", "..")
const read = (path) => readFileSync(path, "utf8")

const ungutter = (block) => block.split("\n").map((line) => line.replace(/^\s*\* ?/, "")).join("\n")

const description = (body) => {
  const lines = []
  for (const line of body.split("\n")) {
    if (/^@\w+/.test(line)) break
    lines.push(line)
  }
  return lines.join("\n").trim()
}

const delink = (value) => value.replace(/\{@link\s+(?:module:)?([^}]+)\}/g, "`$1`")

const paragraphs = (value) => {
  const blocks = []
  let current = []
  let fence = []
  let fenced = false
  for (const line of value.split("\n")) {
    if (/^```/.test(line)) {
      if (fenced) {
        fence.push(line)
        blocks.push(fence.join("\n"))
        fence = []
      } else {
        if (current.length > 0) blocks.push(current.join(" "))
        current = []
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
      if (current.length > 0) blocks.push(current.join(" "))
      current = []
    } else current.push(line.trim())
  }
  if (current.length > 0) blocks.push(current.join(" "))
  return blocks.join("\n\n")
}

const firstSentence = (value) => {
  const flat = delink(value).split("\n\n")[0].split("\n").join(" ")
  const sentence = (/^[\s\S]*?\.(?=\s|$)/.exec(flat)?.[0] ?? flat).trim()
  return sentence.replace(/\s+—\s+[\s\S]*$/, ".").replace(/\|/g, "\\|")
}

const moduleDoc = (source) => {
  const match = /\/\*\*([\s\S]*?)\*\//.exec(source)
  if (match === null) throw new Error("migrate docs: no module JSDoc block")
  // The barrel header opens with its `@since` tag; the prose follows it.
  return delink(ungutter(match[1]).split("\n").filter((line) => !/^@\w+/.test(line)).join("\n").trim())
}

const exportedDocs = (source) => {
  const entries = []
  // Anchored to the start of a line. A JSDoc block for a top-level export
  // begins in column 0, while `${root}/**` inside `Layers.rules` does not, and
  // an unanchored `/**` matched that template literal and published the middle
  // of a function body as `Layers.layerSnapshotBoundary`'s summary.
  const pattern = /^\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*\nexport (type|const|class|interface|function) (\w+)/gm
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

const manifest = JSON.parse(read(join(packageRoot, "package.json")))
if (manifest.name !== Manifest.name) throw new Error("migrate docs: Manifest.ts and package.json names differ")

const barrel = read(join(packageRoot, "src", "index.ts"))
const scannerModules = [...barrel.matchAll(/export \* as (\w+) from "\.\/((?:flow\/)?\w+)\.ts"/g)].map((match) => ({
  namespace: match[1],
  file: match[2],
  reach: match[2].startsWith("flow/") ? "`@smthrs/migrate` or `@smthrs/migrate/" + match[2] + "`" : "`@smthrs/migrate`"
}))
if (scannerModules.length === 0) throw new Error("migrate docs: the barrel re-exports no namespaces")
const inBarrel = new Set(scannerModules.map((module) => module.file))
const flowModules = readdirSync(join(packageRoot, "src", "flow"))
  .filter((entry) => entry.endsWith(".ts") && entry !== "bin.ts" && !inBarrel.has(`flow/${entry.slice(0, -3)}`))
  .sort()
  .map((entry) => ({
    namespace: entry.slice(0, -3),
    file: `flow/${entry.slice(0, -3)}`,
    reach: "`@smthrs/migrate/flow/" + entry.slice(0, -3) + "`"
  }))

const rows = new Map()
for (const module of [...scannerModules, ...flowModules]) {
  const documented = exportedDocs(read(join(packageRoot, "src", `${module.file}.ts`)))
  if (documented.length === 0) throw new Error(`migrate docs: ${module.file}.ts documents no exports`)
  for (const entry of documented) {
    const name = `${module.namespace}.${entry.name}`
    const seen = rows.get(name)
    if (seen === undefined) rows.set(name, { ...entry, reach: module.reach, declarations: [entry.declaration] })
    else if (!seen.declarations.includes(entry.declaration)) seen.declarations.push(entry.declaration)
  }
}
if (rows.size === 0) throw new Error("migrate docs: no documented exports found")

const tableRows = [
  ["Export", "Kind", "Category", "Import from", "Summary"],
  ...[...rows].map(([name, entry]) => [
    `\`${name}\``,
    entry.declarations.join(" + "),
    entry.category,
    entry.reach,
    entry.summary
  ])
]
const tableWidths = tableRows[0].map((_, index) => Math.max(3, ...tableRows.map((row) => row[index].length)))
const tableRow = (row) => `| ${row.map((cell, index) => cell.padEnd(tableWidths[index])).join(" | ")} |`
const table = [
  tableRow(tableRows[0]),
  tableRow(tableWidths.map((width) => "-".repeat(width))),
  ...tableRows.slice(1).map(tableRow)
].join("\n")

const apiPage = `---
description: "${manifest.description}."
---

{/* Generated by \`node packages/migrate/scripts/docs.mjs\` from packages/migrate. Edit package sources, never this file. */}

# \`@smthrs/migrate\`

${paragraphs(moduleDoc(barrel))}

${read(join(packageRoot, Manifest.api.source)).trim()}

## Exports

Every scanner namespace is importable from \`@smthrs/migrate\`; the flow
modules are reached by subpath only, so importing the package never loads the
1.0 runtime.

${table}
`

const outputs = new Map([[Manifest.api.target, apiPage]])

const failures = []
for (const path of Manifest.references) {
  const content = read(join(repoRoot, path))
  if (!content.includes(Manifest.name) || !content.includes(Manifest.api.route)) {
    failures.push(`${path}: must reference ${Manifest.name} and ${Manifest.api.route}`)
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
  if (check) failures.push(`${path}: drifted; run node packages/migrate/scripts/docs.mjs`)
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
    ? "✓ the migrate package documentation is current"
    : drifted
    ? "✓ migrate package documentation regenerated"
    : "✓ migrate package documentation already current"
)
