#!/usr/bin/env node
/**
 * Projects package-owned sync documentation into the repository site.
 *
 * Every published sentence about this package has one source inside the
 * package: the JSDoc in `src/`, the prose in `docs/`, and `description` in
 * `package.json`. `docs/pages/api/sync.md` is generated whole, and the
 * protocol section of `docs/pages/concepts/sync.md` is injected between its
 * generated markers.
 *
 * Run: node packages/sync/scripts/docs.mjs [--check]
 */
import { readFileSync, writeFileSync } from "node:fs"
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

const delink = (value) => value.replace(/\{@link\s+([^}]+)\}/g, "`$1`")

/**
 * Renders a JSDoc description as page Markdown. Wrapped paragraph lines join
 * into one line; a fenced block passes through verbatim, because joining its
 * lines would destroy the example the module header teaches with.
 */
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
  return (/^[\s\S]*?\.(?=\s|$)/.exec(flat)?.[0] ?? flat).trim()
}

const moduleDoc = (source) => {
  const match = /\/\*\*([\s\S]*?)\*\//.exec(source)
  if (match === null) throw new Error("sync docs: no module JSDoc block")
  return delink(description(ungutter(match[1])))
}

/**
 * The comment pattern must not span two blocks, hence `(?:[^*]|\*(?!\/))*`: a
 * lazy `[\s\S]*?` still pairs one block's opening with a later block's close
 * when the first block carries no export, and the wrong summary lands on the
 * row.
 */
const exportedDocs = (source) => {
  const entries = []
  const pattern = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*\nexport (type|const|class|interface|function) (\w+)/g
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
if (manifest.name !== Manifest.name) throw new Error("sync docs: Manifest.ts and package.json names differ")

const barrel = read(join(packageRoot, "src", "index.ts"))
// The barrel re-exports namespaces, so a row addresses an export the way a
// consumer writes it. A bare `make` would name three different functions.
const modules = [...barrel.matchAll(/export \* as (\w+) from "\.\/(\w+)\.ts"/g)].map((match) => ({
  namespace: match[1],
  file: match[2]
}))
if (modules.length === 0) throw new Error("sync docs: no namespace re-exports found in src/index.ts")

const rows = new Map()
for (const module of modules) {
  for (const entry of exportedDocs(read(join(packageRoot, "src", `${module.file}.ts`)))) {
    // A schema and its inferred type share a name and a summary. One row
    // states both kinds rather than repeating the sentence.
    const key = `${module.namespace}.${entry.name}`
    const seen = rows.get(key)
    if (seen === undefined) rows.set(key, { ...entry, declarations: [entry.declaration] })
    else if (!seen.declarations.includes(entry.declaration)) seen.declarations.push(entry.declaration)
  }
}
if (rows.size === 0) throw new Error("sync docs: no documented exports found")

const table = [
  "| Export | Kind | Category | Summary |",
  "| --- | --- | --- | --- |",
  ...[...rows].map(([key, entry]) =>
    `| \`${key}\` | ${entry.declarations.join(" + ")} | ${entry.category} | ${entry.summary} |`
  )
].join("\n")

const apiPage = `---
description: "${manifest.description}."
---

{/* Generated by \`node packages/sync/scripts/docs.mjs\` from packages/sync. Edit package sources, never this file. */}

# @smthrs/sync

${paragraphs(moduleDoc(barrel))}

${read(join(packageRoot, Manifest.api.source)).trim()}

## Exports

${table}
`

const regionStart = (name) => `{/* generated:${name} start */}`
const regionEnd = (name) => `{/* generated:${name} end */}`
const replaceRegion = (source, name, body) => {
  const start = source.indexOf(regionStart(name))
  const end = source.indexOf(regionEnd(name))
  if (start < 0 || end < 0 || end < start) throw new Error(`sync docs: region ${name} is missing`)
  return `${source.slice(0, start)}${regionStart(name)}\n\n${body.trim()}\n\n${source.slice(end)}`
}

const outputs = new Map([[Manifest.api.target, apiPage]])
for (const snippet of Manifest.snippets) {
  const current = outputs.get(snippet.target) ?? read(join(repoRoot, snippet.target))
  outputs.set(snippet.target, replaceRegion(current, snippet.region, read(join(packageRoot, snippet.source))))
}

const failures = []
for (const path of Manifest.references) {
  const content = read(join(repoRoot, path))
  if (!content.includes(Manifest.name) || !content.includes("/api/sync")) {
    failures.push(`${path}: must reference ${Manifest.name} and /api/sync`)
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
  if (check) failures.push(`${path}: drifted; run node packages/sync/scripts/docs.mjs`)
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
    ? "✓ the sync package documentation is current"
    : drifted
    ? "✓ sync package documentation regenerated"
    : "✓ sync package documentation already current"
)
