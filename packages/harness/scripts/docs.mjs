#!/usr/bin/env node
/**
 * Projects package-owned harness documentation into the surfaces it owns.
 *
 * One output: `docs/reference.md`, derived from the barrel's module JSDoc, each
 * module's `@category`-tagged exports, the prose in `docs/api.md`, and the
 * `description` in `package.json`. It replaces the hand-maintained table that
 * used to sit in `README.md`, which had drifted by seven whole modules and more
 * than thirty exports.
 *
 * `dprint.json` excludes the output, because this generator owns its formatting.
 *
 * Run from the repository root. `--check` reports drift and exits 1.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Manifest } from "../docs/Manifest.ts"

const check = process.argv.includes("--check")
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(packageRoot, "..", "..")
const read = (path) => readFileSync(path, "utf8")

/** Strips the leading gutter from one JSDoc block's body. */
const ungutter = (block) => block.split("\n").map((line) => line.replace(/^\s*\* ?/, "")).join("\n")

/** The prose of a JSDoc body, stopping at the first block tag. */
const description = (body) => {
  const lines = []
  for (const line of body.split("\n")) {
    if (/^@\w+/.test(line)) break
    lines.push(line)
  }
  return lines.join("\n").trim()
}

const delink = (value) => value.replace(/\{@link\s+([^}]+)\}/g, (_, target) => `\`${target.split(".").pop()}\``)

const firstSentence = (value) => {
  const flat = delink(value).split("\n\n")[0].split("\n").join(" ").trim()
  return (/^[\s\S]*?[.:](?=\s|$)/.exec(flat)?.[0] ?? flat).trim()
}

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

/**
 * The module's own docblock: the first JSDoc block in the file, which by house
 * convention states what the module is.
 */
const moduleDoc = (source, module) => {
  // The inner alternation refuses a `*/`, so the match cannot span two blocks.
  const match = /\/\*\*((?:[^*]|\*(?!\/))*)\*\//.exec(source)
  if (match === null) throw new Error(`harness docs: ${module} has no module JSDoc block`)
  return delink(description(ungutter(match[1])))
}

/** Every `@category`-tagged export of one module, in source order, deduplicated by name. */
const exportedDocs = (source, module) => {
  const entries = new Map()
  const pattern =
    /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*\nexport (?:declare )?(type|const|class|interface|function) (\w+)/g
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const body = ungutter(match[1])
    if (/@category (\S+)/.exec(body) === null) continue
    const name = match[3]
    if (entries.has(name)) continue
    entries.set(name, {
      name,
      declaration: match[2],
      category: /@category (\S+)/.exec(body)[1],
      summary: firstSentence(description(body))
    })
  }
  if (entries.size === 0) throw new Error(`harness docs: ${module} declares no documented exports`)
  return [...entries.values()]
}

const manifest = JSON.parse(read(join(packageRoot, "package.json")))
if (manifest.name !== Manifest.name) throw new Error("harness docs: Manifest.ts and package.json names differ")

const barrelPath = join(packageRoot, "src", "index.ts")
const barrel = read(barrelPath)
const barrelModules = [...barrel.matchAll(/export \* as (\w+) from "\.\/(\w+)\.ts"/g)].map((match) => ({
  name: match[1],
  file: match[2],
  root: true
}))
if (barrelModules.length === 0) throw new Error("harness docs: the barrel re-exports no modules")

const modules = [
  ...barrelModules,
  ...Manifest.subpathModules.map((name) => ({ name, file: name, root: false }))
].map((module) => {
  const source = read(join(packageRoot, "src", `${module.file}.ts`))
  return { ...module, doc: moduleDoc(source, module.name), exports: exportedDocs(source, module.name) }
})

const cell = (value) => value.replaceAll("|", "\\|")

/** The index: every module, what it exports, and one sentence about it. */
const moduleTable = [
  "| Module | Public exports | Description |",
  "| --- | --- | --- |",
  ...modules.map((module) =>
    `| \`${module.name}\`${module.root ? "" : " *(subpath)*"} | ${
      cell(module.exports.map((entry) => `\`${entry.name}\``).join(", "))
    } | ${cell(firstSentence(module.doc))} |`
  )
].join("\n")

const referenceSections = modules.map((module) =>
  [
    `### ${module.name}`,
    "",
    module.root
      ? `\`import * as ${module.name} from "@smthrs/harness/${module.name}"\``
      : `\`import * as ${module.name} from "@smthrs/harness/${module.name}"\` (not re-exported from the root)`,
    "",
    paragraphs(module.doc),
    "",
    "| Export | Kind | Category | Summary |",
    "| --- | --- | --- | --- |",
    ...module.exports.map((entry) =>
      `| \`${entry.name}\` | ${entry.declaration} | ${entry.category} | ${cell(entry.summary)} |`
    )
  ].join("\n")
).join("\n\n")

const reference = `<!-- Generated by \`node packages/harness/scripts/docs.mjs\` from packages/harness. Edit package sources, never this file. -->

# ${Manifest.name}

${manifest.description}.

${read(join(packageRoot, Manifest.api.source)).trim()}

## Reference

${modules.length} public modules, ${modules.reduce((sum, module) => sum + module.exports.length, 0)} documented exports.

${moduleTable}

${referenceSections}
`

const outputs = new Map([[Manifest.api.target, reference]])

const failures = []
let drifted = false
for (const [path, content] of outputs) {
  const absolute = join(repoRoot, path)
  if (existsSync(absolute) && read(absolute) === content) continue
  drifted = true
  if (check) failures.push(`${path}: drifted; run node packages/harness/scripts/docs.mjs`)
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
    ? "✓ the harness package documentation is current"
    : drifted
    ? "✓ harness package documentation regenerated"
    : "✓ harness package documentation already current"
)
