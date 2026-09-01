#!/usr/bin/env node
/**
 * Projects package-owned time-travel documentation into the repository site.
 *
 * Every published sentence about this package has one source inside the
 * package: the JSDoc in `src/`, the prose in `docs/`, and `description` in
 * `package.json`. `docs/pages/api/time-travel.md` is a generated output, and
 * `docs/pages/concepts/time-travel.md` carries a generated region.
 *
 * Run: node packages/time-travel/scripts/docs.mjs [--check]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Package } from "../Package.ts"

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

/**
 * Rewrites JSDoc into page prose. `{@link X}` becomes code, and the em-dashes
 * this package's source comments use become the punctuation the site's house
 * style allows, so a source comment never has to be written for the generator.
 */
const delink = (value) =>
  value
    .replace(/\{@link\s+([^}]+)\}/g, "`$1`")
    .replaceAll(" — ", ", ")
    // A wrapped comment can end a line on the dash, so the spaced form above
    // never matches it. Rewriting it to the same comma keeps the joined
    // paragraph reading as one sentence instead of stranding a hyphen.
    .replace(/ —\n/g, ",\n")
    .replaceAll("—", "-")

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
  if (match === null) throw new Error("time-travel docs: no module JSDoc block")
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
if (manifest.name !== Package.name) {
  throw new Error("time-travel docs: Package.ts and package.json names differ")
}

const barrel = read(join(packageRoot, "src", "index.ts"))
/**
 * A row is addressed the way a consumer writes it. The barrel re-exports one
 * service key by name and everything else as a namespace, and the package
 * `exports` map publishes every module at `@smthrs/time-travel/<Module>`, so
 * the module file name is the prefix in both cases. A bare `make` would name
 * five different functions.
 */
const modules = [
  ...barrel.matchAll(/export \* as \w+ from "\.\/([^"]+)\.ts"/g),
  ...barrel.matchAll(/export \{ \w+ \} from "\.\/([^"]+)\.ts"/g)
].map((match) => match[1])
if (modules.length === 0) {
  throw new Error("time-travel docs: no module re-exports found in src/index.ts")
}

const rows = new Map()
for (const module of [...new Set(modules)].sort()) {
  for (const entry of exportedDocs(read(join(packageRoot, "src", `${module}.ts`)))) {
    // A schema and its inferred type share a name and a summary. One row states
    // both kinds rather than repeating the sentence.
    const key = `${module}.${entry.name}`
    const seen = rows.get(key)
    if (seen === undefined) rows.set(key, { ...entry, declarations: [entry.declaration] })
    else if (!seen.declarations.includes(entry.declaration)) seen.declarations.push(entry.declaration)
  }
}
if (rows.size === 0) throw new Error("time-travel docs: no documented exports found")

const table = [
  "| Export | Kind | Category | Summary |",
  "| --- | --- | --- | --- |",
  ...[...rows].map(
    ([key, entry]) => `| \`${key}\` | ${entry.declarations.join(" + ")} | ${entry.category} | ${entry.summary} |`
  )
].join("\n")

const apiBody = read(join(packageRoot, Package.api.source)).trim()

/**
 * The closed error-code list is the one thing on this page a reader branches
 * on, and it drifted from the code twice. The generator reads the literals out
 * of the schema and refuses to write a page whose failure table does not name
 * exactly them.
 */
const codeSource = read(join(packageRoot, "src", "TimeTravelError.ts"))
const codeBlock = /export const TimeTravelErrorCode = Schema\.Literals\(\[([\s\S]*?)\]\)/.exec(codeSource)
if (codeBlock === null) throw new Error("time-travel docs: could not read TimeTravelErrorCode")
const codes = [...codeBlock[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1])
// The prose is dprint-formatted, so a table cell is padded to the column
// width. The row matcher tolerates that padding rather than depending on it.
const documentedCodes = [...apiBody.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((match) => match[1])

const apiPage = `---
description: ${JSON.stringify(manifest.description)}
---

{/* Generated by \`node packages/time-travel/scripts/docs.mjs\` from packages/time-travel. Edit package sources, never this file. */}

# @smthrs/time-travel

${paragraphs(moduleDoc(barrel))}

${apiBody}

## Exports

Each row names the export as a consumer writes it: the module prefix is the
\`@smthrs/time-travel/<Module>\` subpath, and \`TimeTravel.TimeTravel\` is the
one export the barrel also re-exports flat.

${table}
`

const regionStart = (name) => `{/* generated:${name} start */}`
const regionEnd = (name) => `{/* generated:${name} end */}`
const replaceRegion = (source, name, body) => {
  const start = source.indexOf(regionStart(name))
  const end = source.indexOf(regionEnd(name))
  if (start < 0 || end < 0 || end < start) throw new Error(`time-travel docs: region ${name} is missing`)
  return `${source.slice(0, start)}${regionStart(name)}\n\n${body.trim()}\n\n${source.slice(end)}`
}

const outputs = new Map([[Package.api.target, apiPage]])
for (const snippet of Package.snippets) {
  const current = outputs.get(snippet.target) ?? read(join(repoRoot, snippet.target))
  outputs.set(snippet.target, replaceRegion(current, snippet.region, read(join(packageRoot, snippet.source))))
}

const failures = []
for (const code of codes) {
  if (!documentedCodes.includes(code)) {
    failures.push(`docs/api.md: the failure-behaviour table does not name the \`${code}\` error code`)
  }
}
for (const code of documentedCodes) {
  if (!codes.includes(code)) {
    failures.push(`docs/api.md: the failure-behaviour table names \`${code}\`, which TimeTravelErrorCode does not define`)
  }
}
for (const path of Package.references) {
  const content = outputs.get(path) ?? read(join(repoRoot, path))
  if (!content.includes(Package.name) || !content.includes("/api/time-travel")) {
    failures.push(`${path}: must reference ${Package.name} and /api/time-travel`)
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
  if (check) failures.push(`${path}: drifted; run node packages/time-travel/scripts/docs.mjs`)
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
    ? "✓ the time-travel package documentation is current"
    : drifted
    ? "✓ time-travel package documentation regenerated"
    : "✓ time-travel package documentation already current"
)
