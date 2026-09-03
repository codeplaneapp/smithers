#!/usr/bin/env node
/**
 * The colocated documentation generator for `@smthrs/chain`.
 *
 * `docs/README.md` states that every published sentence about this package
 * has one source inside the package. Two of those three sources were already
 * gated: `test/Docs.test.ts` fails when `docs/api.md` misses a namespace the
 * barrel exports, and when `docs/contract.md` states a default the source no
 * longer carries. The third — the JSDoc on the exports themselves — had no
 * gate at all, so a member could be added, renamed, or recategorized and
 * nothing in the repository noticed.
 *
 * This script closes that gap. It projects the `@category` and the first
 * JSDoc sentence of every documented export into `docs/exports.md`, one
 * section per barrel namespace, and `--check` reports drift instead of
 * writing. `//packages/chain:docsPages` runs it: the `run` verb writes, and
 * the `lint` verb — which CI's `ci '//packages/...'` step includes — fails
 * on drift.
 *
 * The output stays inside the package on purpose. `@smthrs/chain` is private
 * at 1.0.0-rc.0 and publishes no page under `docs/pages`, so there is
 * nothing to project outward yet; when it goes public, `Manifest.ts` is where
 * the outward targets get declared and only the write step below changes.
 *
 * Run: node packages/chain/scripts/docs.mjs [--check]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Manifest } from "../docs/Manifest.ts"

const CHECK = process.argv.includes("--check")

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (...parts) => readFileSync(join(packageRoot, ...parts), "utf8")

// -----------------------------------------------------------------------------
// JSDoc extraction
// -----------------------------------------------------------------------------

/** Strips the leading ` * ` gutter from the body of one JSDoc block. */
const ungutter = (block) =>
  block
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n")

/** The description of a JSDoc body: everything before the first `@` tag line. */
const description = (body) => {
  const kept = []
  for (const line of body.split("\n")) {
    if (/^@\w+/.test(line)) break
    kept.push(line)
  }
  return kept.join("\n").trim()
}

/** Replaces `{@link X}` with a code span so prose renders outside TypeScript. */
const delink = (text) => text.replace(/\{@link\s+([^}]+)\}/g, "`$1`")

/** The longest summary one member contributes. */
const maxSummary = 200

/**
 * The first sentence of a JSDoc description, flattened to one line.
 *
 * One line matters twice over: a wrapped summary would make the generated
 * file's shape depend on where the author happened to break the comment, and
 * dprint reflows nothing it finds already on one line. A colon does not end a
 * sentence here, because this package writes many of its summaries as
 * "What it is: the detail", and cutting at the colon would publish the label
 * without the thing it labels.
 */
const firstSentence = (text) => {
  const flat = delink(text).split("\n\n")[0].split("\n").join(" ").replaceAll(/\s+/g, " ").trim()
  const match = /^[\s\S]*?\.(?=\s|$)/.exec(flat)
  const sentence = (match ? match[0] : flat).trim()
  return sentence.length <= maxSummary ? sentence : `${sentence.slice(0, maxSummary - 3)}...`
}

/**
 * The JSDoc block regex.
 *
 * `(?:[^*]|\*(?!\/))*` is the body: any character that is not a star, or a
 * star not followed by a slash. A lazy `[\s\S]*?` would match ACROSS two
 * comment blocks whenever the first one carries no `@category`, silently
 * attributing one export's prose to another.
 */
const documented = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*\nexport (?:declare )?(const|type|interface|class|function) (\w+)/g

/** Every documented export of one source file, in declaration order. */
const exportedDocs = (source) => {
  const entries = []
  for (let match = documented.exec(source); match !== null; match = documented.exec(source)) {
    const body = ungutter(match[1])
    const category = /@category (\S+)/.exec(body)?.[1]
    if (category === undefined) continue
    entries.push({
      category,
      kind: match[2],
      name: match[3],
      since: /@since (\S+)/.exec(body)?.[1],
      summary: firstSentence(description(body))
    })
  }
  return entries
}

/** The module JSDoc of one source file: the first block in it. */
const moduleDoc = (source, label) => {
  const match = /\/\*\*([\s\S]*?)\*\//.exec(source)
  if (match === null) throw new Error(`chain docs: ${label} has no module JSDoc block`)
  return delink(description(ungutter(match[1])))
}

// -----------------------------------------------------------------------------
// The barrel
// -----------------------------------------------------------------------------

const barrel = read("src", "index.ts")

/**
 * Every `export * as <Namespace> from "./<Module>.ts"` in the barrel, with
 * the summary of the JSDoc block directly above it.
 */
const namespaces = [
  ...barrel.matchAll(
    /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*\nexport \* as (\w+) from "\.\/(\w+)\.ts"/g
  )
].map((match) => ({
  module: match[3],
  name: match[2],
  summary: firstSentence(description(ungutter(match[1])))
}))

if (namespaces.length === 0) throw new Error("chain docs: the barrel exports no namespaces")

// -----------------------------------------------------------------------------
// Page assembly
// -----------------------------------------------------------------------------

const failures = []

const sections = namespaces.map((namespace) => {
  const source = read("src", `${namespace.module}.ts`)
  const exports = exportedDocs(source)
  if (exports.length === 0) {
    failures.push(`src/${namespace.module}.ts: no export carries an @category tag`)
  }
  for (const entry of exports) {
    if (entry.since === undefined) {
      failures.push(`src/${namespace.module}.ts: ${entry.name} has @category but no @since`)
    }
    if (entry.summary === "") {
      failures.push(`src/${namespace.module}.ts: ${entry.name} has an @category tag but no description`)
    }
  }
  const lines = exports.map((entry) => `- \`${entry.name}\` (${entry.kind}, ${entry.category}) — ${entry.summary}`)
  return `### \`${namespace.name}\`\n\n${namespace.summary}\n\n${lines.join("\n")}\n`
})

const total = namespaces.reduce((count, namespace) => count + exportedDocs(read("src", `${namespace.module}.ts`)).length, 0)

const page = `<!-- Generated by \`node ${Manifest.generator}\` from the JSDoc in packages/chain/src. Edit the JSDoc, never this file. -->

# Exported members

Every member the barrel reaches, with the kind and \`@category\` it declares
and the first sentence of its JSDoc. An export without an \`@category\` tag is
not part of the documented surface and does not appear here.

This file is generated, and \`//packages/chain:docsPages\` drift-checks it under
the \`lint\` verb, which is what CI's \`ci '//packages/...'\` step runs. So a
JSDoc edit that renames a member, moves it to another category, or rewrites
its first sentence has to be regenerated in the same commit. That is the
member-level half of the drift gate; \`test/Docs.test.ts\` owns the
namespace-level and resource-limit halves.

${namespaces.length} namespaces, ${total} documented members.

${sections.join("\n")}`

// -----------------------------------------------------------------------------
// Verification and writes
// -----------------------------------------------------------------------------

const outputs = new Map([[Manifest.exports.target, page]])

let drifted = false
for (const [relative, contents] of outputs) {
  const absolute = join(packageRoot, "..", "..", relative)
  const current = (() => {
    try {
      return readFileSync(absolute, "utf8")
    } catch {
      return undefined
    }
  })()
  if (current === contents) continue
  drifted = true
  if (CHECK) {
    failures.push(`${relative}: drifted from its generated form; run node ${Manifest.generator}`)
  } else {
    writeFileSync(absolute, contents)
    console.log(`wrote ${relative}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}

console.log(
  CHECK
    ? "✓ the chain package documentation is current"
    : drifted
    ? "✓ chain package documentation regenerated"
    : "✓ chain package documentation already current"
)
