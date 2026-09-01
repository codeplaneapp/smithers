#!/usr/bin/env node
/** Projects package-owned Kernel documentation into the repository site. */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Package } from "../Package.ts"

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

const exportedDocs = (source) => {
  const entries = []
  const pattern = /^[ \t]*\/\*\*((?:[^*]|\*(?!\/))*)\*\/[ \t]*\nexport (type|const|class|interface|function) (\w+)/gm
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
      const exports = exportedDocs(read(join(packageRoot, "src", moduleName + ".ts")))
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
if (manifest.name !== Package.name) throw new Error("kernel docs: Package.ts and package.json names differ")

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
  read(join(packageRoot, Package.api.source)).trim(),
  "",
  "## Exports",
  "",
  exportReference,
  ""
].join("\n")

const failures = []
for (const path of Package.references) {
  const content = read(join(repoRoot, path))
  if (!content.includes(Package.name) || !content.includes("/api/kernel")) {
    failures.push(path + ": must reference " + Package.name + " and /api/kernel")
  }
}
if (apiPage.includes("—")) {
  failures.push(Package.api.target + ": generated content contains an em-dash")
}
if (apiPage.includes("formatPattern")) {
  failures.push(Package.api.target + ": generated content contains removed export formatPattern")
}

const requiredSpecifiers = []
for (const [key, mapping] of Object.entries(manifest.exports)) {
  if (key === "." || key === "./package.json" || key.includes("*") || mapping === null) continue
  requiredSpecifiers.push(Package.name + key.slice(1))
}
requiredSpecifiers.push(
  "@smthrs/kernel/test/TestGrantStore",
  "@smthrs/kernel/test/TestHost"
)
for (const specifier of requiredSpecifiers) {
  if (!apiPage.includes(specifier)) {
    failures.push(Package.api.target + ": missing public import specifier " + specifier)
  }
}

let drifted = false
const absolute = join(repoRoot, Package.api.target)
if (read(absolute) !== apiPage) {
  drifted = true
  if (check) failures.push(Package.api.target + ": drifted; run node packages/kernel/scripts/docs.mjs")
  else {
    writeFileSync(absolute, apiPage)
    console.log("wrote " + Package.api.target)
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
