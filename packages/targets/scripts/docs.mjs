#!/usr/bin/env node
/**
 * Generates this package's own reference material from its sources.
 *
 * `@smthrs/targets` is private and has no page on the documentation site, so
 * its generated output stays inside the package: `docs/rules.md` is the
 * inventory of every catalog rule, read straight out of the `Target.make`
 * declarations in `src/`, and `docs/README.md` and `docs/api.md` are the
 * hand-written prose it sits beside.
 *
 * Default run writes; `--check` reports drift and exits 1, which is what the
 * `//packages/targets:docsPages` target and `scripts/check-docs.mjs` run.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Manifest } from "../docs/Manifest.ts"

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repositoryRoot = dirname(dirname(packageRoot))
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
if (manifest.name !== Manifest.name) {
  throw new Error("targets docs: Manifest.ts and package.json names differ")
}
const sourceDirectory = join(packageRoot, Manifest.rules.source)
const generated = join(repositoryRoot, Manifest.rules.target)

/** Every `Target.make(` call in one module, matched or not. */
const declarationCount = (text) => text.split("Target.make(").length - 1

/**
 * The rule id one `Target.make` call names.
 *
 * A few rules pass a module constant rather than a literal, because the same
 * name is also their type guard's comparison value. Reading the constant back
 * out of the module keeps them in the table: matching only string literals
 * silently dropped three rules while the page claimed to list every one.
 */
const ruleId = (text, head) => {
  const literal = /^"([^"]+)"$/.exec(head)
  if (literal !== null) return literal[1]
  const binding = new RegExp(`\\bconst ${head} = "([^"]+)"`).exec(text)
  return binding === null ? undefined : binding[1]
}

/** One `Target.make("<id>", { ... kinds: [...] })` declaration. */
const declarations = () => {
  const found = []
  let calls = 0
  for (const entry of readdirSync(sourceDirectory).sort()) {
    if (!entry.endsWith(".ts")) continue
    const text = readFileSync(join(sourceDirectory, entry), "utf8")
    calls += declarationCount(text)
    // The declaration head plus everything up to the first `kinds:` line. The
    // scan is deliberately shallow: a rule that does not spell its kinds as a
    // literal array is a rule whose verbs are not readable here, and that is
    // reported rather than guessed at.
    const pattern = /Target\.make\(\s*("[^"]+"|[A-Za-z_$][\w$]*)\s*,\s*\{([^]*?)\n\}\)/g
    for (const match of text.matchAll(pattern)) {
      const id = ruleId(text, match[1])
      if (id === undefined) continue
      const body = match[2]
      // `Alias` and `Materialize` mirror the verbs of the target they wrap,
      // so their kinds are a variable rather than a literal and the table says
      // so instead of inventing a list.
      const literalKinds = /kinds:\s*\[([^\]]*)\]/.exec(body)
      const mirroredKinds = /\n\s{4}kinds,/.test(body)
      const cached = /\n\s{2}cache:\s*(true|false|\()/.exec(body)
      const outputs = /\n\s{2}outputs:/.test(body)
      // A rule runs under the package executor only when its whole body is a
      // refusal. Three rules plan a real body and reach `Target.notImplemented`
      // for one operand kind their lane has not landed, and reading the bare
      // mention put those three in the wrong route.
      const notImplemented = /implementation:\s*\(\)\s*=>\s*Target\.notImplemented\(/.test(body)
      found.push({
        id,
        module: entry.replace(/\.ts$/, ""),
        kinds: literalKinds !== null
          ? literalKinds[1].split(",").map((kind) => kind.trim().replaceAll("\"", "")).filter(Boolean).join(", ") ||
            "none"
          : mirroredKinds
          ? "mirrors its target"
          : "unreadable",
        cache: cached === null ? "no" : cached[1] === "true" ? "yes" : cached[1] === "false" ? "no" : "by attrs",
        outputs: outputs ? "yes" : "no",
        route: notImplemented ? "package executor" : "flow body"
      })
    }
  }
  // The page says it lists every rule, so a declaration the scan did not match
  // is a failure rather than a quiet omission: an under-reported catalog reads
  // exactly like a complete one.
  if (found.length !== calls) {
    throw new Error(
      `packages/targets/scripts/docs.mjs matched ${found.length} of ${calls} Target.make declarations; ` +
        "a declaration names its rule in a form the scan cannot read"
    )
  }
  return found.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Renders one markdown table, each column padded to its widest cell.
 *
 * The generated file lives inside the package, so `dprint` formats it too and
 * `dprint` pads table columns. An unpadded table would leave the file with two
 * owners that disagree: `dprint check` would refuse the generator's output and
 * `docs.mjs --check` would refuse dprint's. Padding here is what makes the
 * generator the single owner and both gates agree on the same bytes.
 */
const table = (header, rows) => {
  const widths = header.map((cell, column) =>
    Math.max(3, cell.length, ...rows.map((row) => row[column].length))
  )
  const line = (cells) => `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`
  return [
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line)
  ]
}

const render = (rules) => {
  const rows = rules.map((rule) => [
    `\`${rule.id}\``,
    rule.module,
    rule.kinds,
    rule.cache,
    rule.outputs,
    rule.route
  ])
  return [
    "<!-- Generated by packages/targets/scripts/docs.mjs. Edit the sources, never this file. -->",
    "",
    "# Catalog rules",
    "",
    "Every rule `Target.make` declares in this package, with the verbs it",
    "participates in, whether its results may be replayed from the cache,",
    "whether it declares an output tree, and which route executes it. A",
    "`package executor` rule plans `Target.notImplemented` as its Flow body, so",
    "running one under a bare Flow runtime fails loudly instead of doing nothing.",
    "",
    ...table(["Rule", "Module", "Verbs", "Cacheable", "Declares outputs", "Route"], rows),
    "",
    `${rules.length} rules.`,
    ""
  ].join("\n")
}

const rules = declarations()
if (rules.length === 0) throw new Error("packages/targets/scripts/docs.mjs found no Target.make declarations")
const unreadable = rules.filter((rule) => rule.kinds === "unreadable")
if (unreadable.length > 0) {
  throw new Error(`rules with unreadable kinds: ${unreadable.map((rule) => rule.id).join(", ")}`)
}
// A rule id identifies a rule, which is the premise the whole catalog rests
// on: a BUILD.ts author writes one, the package executor dispatches on one,
// and the planner keys on one. Two declarations under one id make the table
// emit two rows for the same name and leave whichever one the namespace
// happens to export as the one an author can actually reach.
const byId = new Map()
for (const rule of rules) byId.set(rule.id, [...byId.get(rule.id) ?? [], rule.module])
const duplicates = [...byId].filter(([, modules]) => modules.length > 1)
if (duplicates.length > 0) {
  throw new Error(
    `two Target.make declarations share one rule id: ${
      duplicates.map(([id, modules]) => `${id} (${modules.join(", ")})`).join("; ")
    }`
  )
}
const next = render(rules)
if (next.includes("—")) throw new Error("generated documentation must not contain em-dashes")

if (process.argv.includes("--check")) {
  let current
  try {
    current = readFileSync(generated, "utf8")
  } catch {
    current = undefined
  }
  if (current !== next) {
    console.error("packages/targets/docs/rules.md is out of date; run node packages/targets/scripts/docs.mjs")
    process.exit(1)
  }
} else {
  writeFileSync(generated, next)
}
