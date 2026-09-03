#!/usr/bin/env node
/** Projects package-owned smthrs documentation into the repository site. */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Manifest } from "../docs/Manifest.ts"

const check = process.argv.includes("--check")
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(packageRoot, "..", "..")
const read = (path) => readFileSync(path, "utf8")

const manifest = JSON.parse(read(join(packageRoot, "package.json")))
if (manifest.name !== Manifest.name) throw new Error("smthrs docs: Manifest.ts and package.json names differ")

const entry = read(join(packageRoot, "src", "index.ts"))
const noticeArray = /const notice: string = \[([\s\S]*?)\]\.join\("\\n"\)/.exec(entry)?.[1] ?? ""
const noticeLines = [...noticeArray.matchAll(/"([^"\n]*)"/g)].map((match) => match[1])
if (noticeLines.length < 4) throw new Error("smthrs docs: fewer than four notice lines found in src/index.ts")
const notice = noticeLines.join("\n")

const firstFence = (markdown) => (/^```[^\n]*\n([\s\S]*?)^```/m.exec(markdown)?.[1] ?? "").trimEnd()

const fragment = read(join(packageRoot, "docs", "notice.md"))
const readme = read(join(packageRoot, "README.md"))

const failures = []
if (firstFence(fragment) !== notice) failures.push("docs/notice.md: first fenced block differs from src/index.ts")
if (firstFence(readme) !== notice) failures.push("README.md: first fenced block differs from src/index.ts")

const regionStart = (name) => `{/* generated:${name} start */}`
const regionEnd = (name) => `{/* generated:${name} end */}`
const replaceRegion = (source, name, body) => {
  const start = source.indexOf(regionStart(name))
  const end = source.indexOf(regionEnd(name))
  if (start < 0 || end < 0 || end < start) throw new Error(`smthrs docs: region ${name} is missing`)
  return `${source.slice(0, start)}${regionStart(name)}\n\n${body.trim()}\n\n${source.slice(end)}`
}

const outputs = new Map()
for (const snippet of Manifest.snippets) {
  const current = outputs.get(snippet.target) ?? read(join(repoRoot, snippet.target))
  outputs.set(snippet.target, replaceRegion(current, snippet.region, read(join(packageRoot, snippet.source))))
}

for (const path of Manifest.references) {
  if (!read(join(repoRoot, path)).includes("smthrs")) failures.push(`${path}: must reference smthrs`)
}
// The em-dash rule covers what this package writes, not the whole page it
// writes into: the rest of the upgrade guide is maintained separately.
for (const snippet of Manifest.snippets) {
  if (read(join(packageRoot, snippet.source)).includes("—")) {
    failures.push(`${snippet.source}: package-owned content contains an em-dash`)
  }
}

let drifted = false
for (const [path, content] of outputs) {
  const absolute = join(repoRoot, path)
  if (read(absolute) === content) continue
  drifted = true
  if (check) failures.push(`${path}: drifted; run node packages/smthrs-deprecation/scripts/docs.mjs`)
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
    ? "✓ the smthrs package documentation is current"
    : drifted
    ? "✓ smthrs package documentation regenerated"
    : "✓ smthrs package documentation already current"
)
