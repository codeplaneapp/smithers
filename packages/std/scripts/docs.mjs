#!/usr/bin/env node
/**
 * Projects package-owned standard-library documentation into the surfaces it
 * owns.
 *
 * One output. `docs/reference.md` is derived from the barrel's module JSDoc,
 * each module's `@category`-tagged exports, the prose in `docs/api.md`, and the
 * `description` in `package.json`. The hand-maintained table it replaces had
 * drifted: it named 21 of the 30 exported namespaces and omitted three registry
 * flows a model can call, and nothing checked it, because this package's only
 * docs target asks for a title and a prose floor.
 *
 * The generator is a peer of `packages/mcp/scripts/docs.mjs` and stays one
 * shape with it deliberately, so the two read the same way while the shared
 * generator this repository owes them is still a plain script.
 *
 * `dprint.json` excludes the output, because this generator owns its formatting.
 *
 * Run from the repository root. `--check` reports drift and exits 1.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Package } from "../Package.ts"

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
  if (match === null) throw new Error(`std docs: ${module} has no module JSDoc block`)
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
  if (entries.size === 0) throw new Error(`std docs: ${module} declares no documented exports`)
  return [...entries.values()]
}

const manifest = JSON.parse(read(join(packageRoot, "package.json")))
if (manifest.name !== Package.name) throw new Error("std docs: Package.ts and package.json names differ")

const barrel = read(join(packageRoot, "src", "index.ts"))
const barrelModules = [...barrel.matchAll(/export \* as (\w+) from "\.\/(\w+)\.ts"/g)].map((match) => ({
  name: match[1],
  file: match[2],
  root: true
}))
if (barrelModules.length === 0) throw new Error("std docs: the barrel re-exports no modules")

const modules = [
  ...barrelModules,
  ...Package.subpathModules.map((name) => ({ name, file: name, root: false }))
].map((module) => {
  const source = read(join(packageRoot, "src", `${module.file}.ts`))
  return { ...module, doc: moduleDoc(source, module.name), exports: exportedDocs(source, module.name) }
})

/**
 * The README ships in the tarball and `docs/` does not, so its Public API table
 * is the only inventory an npm reader sees and it cannot be replaced by a
 * pointer. It is hand-written, which is how it came to name 21 of 30 modules
 * and omit three registry flows a model can call, so it is checked here against
 * the barrel rather than left to drift again.
 */
const readme = read(join(packageRoot, "README.md"))
const publicApi = /^## Public API$([\s\S]*?)^## /m.exec(readme)
if (publicApi === null) throw new Error("std docs: README.md has no Public API section")
const readmeModules = [...publicApi[1].matchAll(/^\| `(\w+)` +\|/gm)].map((match) => match[1])
const declared = new Set(readmeModules)
const missing = modules.filter((module) => !declared.has(module.name)).map((module) => module.name)
const unknown = readmeModules.filter((name) => !modules.some((module) => module.name === name))
if (missing.length > 0 || unknown.length > 0) {
  throw new Error(
    `std docs: README.md's Public API table is out of step with the barrel${
      missing.length > 0 ? `; missing ${missing.join(", ")}` : ""
    }${unknown.length > 0 ? `; unknown ${unknown.join(", ")}` : ""}`
  )
}

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
      ? `\`import { ${module.name} } from "@smthrs/std"\` or \`import * as ${module.name} from "@smthrs/std/${module.name}"\``
      : `\`import * as ${module.name} from "@smthrs/std/${module.name}"\` (not re-exported from the root)`,
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

const reference = `<!-- Generated by \`node packages/std/scripts/docs.mjs\` from packages/std. Edit package sources, never this file. -->

# ${Package.name}

${manifest.description}.

${read(join(packageRoot, Package.api.source)).trim()}

## Reference

${modules.length} public modules, ${modules.reduce((sum, module) => sum + module.exports.length, 0)} documented exports.

${moduleTable}

${referenceSections}
`

const outputs = new Map([[Package.api.target, reference]])

const regionStart = (name) => `{/* generated:${name} start */}`
const regionEnd = (name) => `{/* generated:${name} end */}`

/** Replaces one marked region of a shared page with package-owned prose. */
const replaceRegion = (source, name, body) => {
  const start = source.indexOf(regionStart(name))
  const end = source.indexOf(regionEnd(name))
  if (start < 0 || end < 0 || end < start) throw new Error(`std docs: region ${name} is missing`)
  return `${source.slice(0, start)}${regionStart(name)}\n\n${body.trim()}\n\n${source.slice(end)}`
}

for (const snippet of Package.snippets) {
  const current = outputs.get(snippet.target) ?? read(join(repoRoot, snippet.target))
  outputs.set(snippet.target, replaceRegion(current, snippet.region, read(join(packageRoot, snippet.source))))
}

// The house style forbids an em-dash on a published page, and this generator is
// built to write onto one the day the sidebar entry lands. Failing here names
// the source file a writer has to fix instead of the generated page they must
// never edit. The package's own reference is not a published page, so it keeps
// the source's punctuation.
for (const [path, content] of outputs) {
  if (path.startsWith("docs/pages/") && content.includes("—")) {
    throw new Error(`std docs: ${path} would contain an em-dash`)
  }
}

const failures = []
let drifted = false
for (const [path, content] of outputs) {
  const absolute = join(repoRoot, path)
  if (existsSync(absolute) && read(absolute) === content) continue
  drifted = true
  if (check) failures.push(`${path}: drifted; run node packages/std/scripts/docs.mjs`)
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
    ? "✓ the std package documentation is current"
    : drifted
    ? "✓ std package documentation regenerated"
    : "✓ std package documentation already current"
)
