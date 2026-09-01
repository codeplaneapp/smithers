#!/usr/bin/env node
/** Projects package-owned Plan documentation into the repository site. */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DocsManifest } from "../DocsManifest.ts"

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
  if (match === null) throw new Error("plan docs: no module JSDoc block")
  return delink(description(ungutter(match[1])))
}

const entry = (namespace, publicName, declaration, body) => {
  const category = /@category (\S+)/.exec(body)?.[1]
  if (category === undefined) return undefined
  return {
    name: `${namespace}.${publicName}`,
    declaration,
    category,
    summary: firstSentence(description(body))
  }
}

const exportedDocs = (namespace, source) => {
  const entries = []
  const pattern = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*\nexport (type|const|class|interface) (\w+)/g
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const made = entry(namespace, match[3], match[2], ungutter(match[1]))
    if (made !== undefined) entries.push(made)
  }
  // An alias re-export (`export { catch_ as catch }`) publishes a declaration
  // whose JSDoc sits on the internal const, so resolve the internal name.
  for (const match of source.matchAll(/^export \{ ([^}]+) \}$/gm)) {
    for (const piece of match[1].split(",")) {
      const alias = /^(\w+)(?: as (\w+))?$/.exec(piece.trim())
      if (alias === null) continue
      const declaration = new RegExp(
        `\\/\\*\\*((?:[^*]|\\*(?!\\/))*)\\*\\/\\s*\\nconst ${alias[1]}\\b`
      ).exec(source)
      if (declaration === null) continue
      const made = entry(namespace, alias[2] ?? alias[1], "const", ungutter(declaration[1]))
      if (made !== undefined) entries.push(made)
    }
  }
  return entries
}

/** Every name the module exports, so no public export can silently vanish. */
const exportedNames = (source) => {
  const names = new Set()
  for (const match of source.matchAll(/^export (?:type|const|class|interface|function) (\w+)/gm)) {
    names.add(match[1])
  }
  for (const match of source.matchAll(/^export \{ ([^}]+) \}$/gm)) {
    for (const piece of match[1].split(",")) {
      const alias = /^(\w+)(?: as (\w+))?$/.exec(piece.trim())
      if (alias !== null) names.add(alias[2] ?? alias[1])
    }
  }
  return names
}

const manifest = JSON.parse(read(join(packageRoot, "package.json")))
if (manifest.name !== DocsManifest.name) throw new Error("plan docs: DocsManifest.ts and package.json names differ")

const barrel = read(join(packageRoot, "src", "index.ts"))
// The barrel re-exports namespaces, so every documented export is addressed as
// `Namespace.member` and the module name is the namespace it is published under.
const modules = [...barrel.matchAll(/export \* as (\w+) from "\.\/(\w+)\.ts"/g)].map((match) => [match[1], match[2]])
const undocumented = []
const exports = modules.flatMap(([namespace, file]) => {
  const source = read(join(packageRoot, "src", `${file}.ts`))
  const entries = exportedDocs(namespace, source)
  const documented = new Set(entries.map((made) => made.name.slice(namespace.length + 1)))
  for (const name of exportedNames(source)) {
    if (!documented.has(name)) undocumented.push(`src/${file}.ts: export ${name} is missing from the API table`)
  }
  return entries
})
if (exports.length === 0) throw new Error("plan docs: no documented exports found")
if (undocumented.length > 0) {
  throw new Error(`plan docs: every public export needs JSDoc with @category\n${undocumented.join("\n")}`)
}

const table = [
  "| Export | Kind | Summary |",
  "| --- | --- | --- |",
  ...exports.map((entry) => `| \`${entry.name}\` (${entry.declaration}) | ${entry.category} | ${entry.summary} |`)
].join("\n")

const apiPage = `---
description: "${manifest.description}."
---

{/* Generated by \`node packages/plan/scripts/docs.mjs\` from packages/plan. Edit package sources, never this file. */}

# @smthrs/plan

${paragraphs(moduleDoc(barrel))}

${read(join(packageRoot, DocsManifest.api.source)).trim()}

## Exports

${table}
`

const regionStart = (name) => `{/* generated:${name} start */}`
const regionEnd = (name) => `{/* generated:${name} end */}`
const replaceRegion = (source, name, body) => {
  const start = source.indexOf(regionStart(name))
  const end = source.indexOf(regionEnd(name))
  if (start < 0 || end < 0 || end < start) throw new Error(`plan docs: region ${name} is missing`)
  return `${source.slice(0, start)}${regionStart(name)}\n\n${body.trim()}\n\n${source.slice(end)}`
}

const outputs = new Map([[DocsManifest.api.target, apiPage]])
for (const snippet of DocsManifest.snippets) {
  const current = outputs.get(snippet.target) ?? read(join(repoRoot, snippet.target))
  outputs.set(snippet.target, replaceRegion(current, snippet.region, read(join(packageRoot, snippet.source))))
}

const failures = []
for (const path of DocsManifest.references) {
  const content = read(join(repoRoot, path))
  if (!content.includes(DocsManifest.name) || !content.includes("/api/plan")) {
    failures.push(`${path}: must reference ${DocsManifest.name} and /api/plan`)
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
  if (check) failures.push(`${path}: drifted; run node packages/plan/scripts/docs.mjs`)
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
    ? "✓ the plan package documentation is current"
    : drifted
    ? "✓ plan package documentation regenerated"
    : "✓ plan package documentation already current"
)
