#!/usr/bin/env node
/** Projects package-owned Kernel documentation into the repository site. */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Manifest } from "../docs/Manifest.ts"

const check = process.argv.includes("--check")
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(packageRoot, "..", "..")
const read = (path) => readFileSync(path, "utf8")
const tick = String.fromCharCode(96)

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

const delink = (value) =>
  value.replace(/\{@link\s+([^}]+)\}/g, (_match, target) => tick + target + tick)

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
  if (match === null) throw new Error("kernel docs: no module JSDoc block")
  return delink(description(ungutter(match[1])))
}

const exportedDocs = (source, moduleName) => {
  const entries = []
  const pattern = /^[ \t]*\/\*\*((?:[^*]|\*(?!\/))*)\*\/[ \t]*\n[ \t]*(export[^\n]*)/gm
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const body = ungutter(match[1])
    const category = /@category (\S+)/.exec(body)?.[1]
    if (category === undefined) continue
    const line = match[2].trim()
    const summary = firstSentence(description(body))
    const direct = /^export (type|const|class|interface|function) (\w+)/.exec(line)
    if (direct !== null) {
      entries.push({
        name: direct[2],
        declaration: direct[1],
        category,
        summary
      })
      continue
    }

    const reExport = /^export (type )?\{\s*(\w+)\s*\} from "[^"]+";?$/.exec(line)
    if (reExport !== null) {
      entries.push({
        name: reExport[2],
        declaration: reExport[1] === undefined ? "re-export" : "type",
        category,
        summary: summary.replaceAll(" — ", ": ")
      })
      continue
    }

    throw new Error(
      "kernel docs: documented module " + moduleName + " export matches no supported shape: " + line
    )
  }
  const documented = new Set(entries.map((entry) => entry.name))
  const exported = new Set()
  for (const match of source.matchAll(/^export (?:type|const|class|interface|function) (\w+)/gm)) {
    exported.add(match[1])
  }
  for (const match of source.matchAll(/^export (?:type )?\{\s*([^}]+)\s*\} from "[^"]+";?$/gm)) {
    for (const piece of match[1].split(",")) {
      const alias = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(piece.trim())
      if (alias !== null) exported.add(alias[2] ?? alias[1])
    }
  }
  const missing = [...exported].filter((name) => !documented.has(name))
  if (missing.length > 0) {
    throw new Error(
      "kernel docs: public exports missing documented table entries in " + moduleName + ": " + missing.join(", ")
    )
  }
  return entries
}

const table = (entries) => [
  "| Export | Kind | Summary |",
  "| --- | --- | --- |",
  ...entries.map((entry) =>
    "| " + tick + entry.name + tick + " (" + entry.declaration + ") | " +
    entry.category + " | " + entry.summary + " |"
  )
].join("\n")

const documentedBarrelEntries = (source) => {
  const leading = []
  const sections = []
  const pattern = /^[ \t]*\/\*\*((?:[^*]|\*(?!\/))*)\*\/[ \t]*\n(export[^\n]+)/gm
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const body = ungutter(match[1])
    const category = /@category (\S+)/.exec(body)?.[1]
    if (category === undefined) continue
    const line = match[2].trim()
    const summary = firstSentence(description(body))

    const localNamespace = /^export \* as (\w+) from "\.\/([^"]+)\.ts"$/.exec(line)
    if (localNamespace !== null) {
      const name = localNamespace[1]
      const moduleName = localNamespace[2]
      const exports = exportedDocs(read(join(packageRoot, "src", moduleName + ".ts")), moduleName)
      if (exports.length === 0) {
        throw new Error("kernel docs: documented module " + moduleName + " yields zero documented exports")
      }
      sections.push("### " + name + "\n\n" + summary + "\n\n" + table(exports))
      continue
    }

    const externalNamespace = /^export \* as (\w+) from "([^"]+)"$/.exec(line)
    if (externalNamespace !== null && externalNamespace[2].startsWith("@smthrs/capability/")) {
      const name = externalNamespace[1]
      sections.push(
        "### " + name + "\n\n" + summary + "\n\nSee [" + tick + "@smthrs/capability" +
        tick + "](/api/capability) for the canonical " + tick + name + tick + " API."
      )
      continue
    }

    const directType = /^export type \{\s*(\w+)\s*\} from "\.\/([^"]+)\.ts"$/.exec(line)
    if (directType !== null) {
      leading.push({
        name: directType[1],
        declaration: "type",
        category,
        summary
      })
      continue
    }

    throw new Error("kernel docs: documented barrel entry matches no supported shape: " + line)
  }
  return { leading, sections }
}

const manifest = JSON.parse(read(join(packageRoot, "package.json")))
if (manifest.name !== Manifest.name) throw new Error("kernel docs: Manifest.ts and package.json names differ")

const barrel = read(join(packageRoot, "src", "index.ts"))
const intro = moduleDoc(barrel)
const entries = documentedBarrelEntries(barrel)
if (entries.leading.length === 0 && entries.sections.length === 0) {
  throw new Error("kernel docs: no documented barrel entries found")
}

const exportReference = [
  entries.leading.length === 0 ? "" : table(entries.leading),
  ...entries.sections
].filter((value) => value !== "").join("\n\n")

const regionStart = (name) => `{/* generated:${name} start */}`
const regionEnd = (name) => `{/* generated:${name} end */}`
const replaceRegion = (source, name, body) => {
  const start = source.indexOf(regionStart(name))
  const end = source.indexOf(regionEnd(name))
  if (start < 0 || end < 0 || end < start) throw new Error("kernel docs: region " + name + " is missing")
  return source.slice(0, start) + regionStart(name) + "\n\n" + body.trim() + "\n\n" + source.slice(end)
}

const apiPage = [
  "---",
  "description: \"" + manifest.description + ".\"",
  "---",
  "",
  "{/* Generated by " + tick + "node packages/kernel/scripts/docs.mjs" + tick +
    " from packages/kernel. Edit package sources, never this file. */}",
  "",
  "# @smthrs/kernel",
  "",
  paragraphs(intro),
  "",
  read(join(packageRoot, Manifest.api.source)).trim(),
  "",
  "## Exports",
  "",
  exportReference,
  ""
].join("\n")

const outputs = new Map([[Manifest.api.target, apiPage]])
for (const snippet of Manifest.snippets) {
  const current = outputs.get(snippet.target) ?? read(join(repoRoot, snippet.target))
  outputs.set(snippet.target, replaceRegion(current, snippet.region, read(join(packageRoot, snippet.source))))
}

const failures = []
for (const path of Manifest.references) {
  const content = read(join(repoRoot, path))
  if (!content.includes(Manifest.name) || !content.includes("/api/kernel")) {
    failures.push(path + ": must reference " + Manifest.name + " and /api/kernel")
  }
}
for (const [path, content] of outputs) {
  if (content.includes("—")) failures.push(path + ": generated content contains an em-dash")
}
if (apiPage.includes("formatPattern")) {
  failures.push(Manifest.api.target + ": generated content contains removed export formatPattern")
}

const requiredSpecifiers = []
for (const [key, mapping] of Object.entries(manifest.exports)) {
  if (key === "." || key === "./package.json" || key.includes("*") || mapping === null) continue
  requiredSpecifiers.push(Manifest.name + key.slice(1))
}
requiredSpecifiers.push(
  "@smthrs/kernel/test/TestGrantStore",
  "@smthrs/kernel/test/TestHost"
)
for (const specifier of requiredSpecifiers) {
  if (!apiPage.includes(specifier)) {
    failures.push(Manifest.api.target + ": missing public import specifier " + specifier)
  }
}

let drifted = false
for (const [path, content] of outputs) {
  const absolute = join(repoRoot, path)
  if (read(absolute) !== content) {
    drifted = true
    if (check) failures.push(path + ": drifted; run node packages/kernel/scripts/docs.mjs")
    else {
      writeFileSync(absolute, content)
      console.log("wrote " + path)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error("✗ " + failure)
  process.exit(1)
}

console.log(
  check
    ? "✓ the kernel package documentation is current"
    : drifted
    ? "✓ kernel package documentation regenerated"
    : "✓ kernel package documentation already current"
)
