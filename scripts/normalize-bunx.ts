#!/usr/bin/env node
/**
 * Normalizes how the documentation invokes the command line.
 *
 * Smithers 1.0 ships one binary, `smithers`, from `@smthrs/cli`. The rule in
 * `docs/pages/installation.md` is that a documented invocation is either the
 * installed binary (`smithers <verb>`) or an explicit one-off runner naming the
 * scoped package (`npx @smthrs/cli@next smithers <verb>`).
 *
 * Smithers 0.x documented `bunx smthrs <verb>`, and that spelling is now wrong
 * in a way a reader cannot see: `smthrs@1.0.0-rc.0` is a migration notice whose
 * only module throws on import, so `bunx smthrs plan` runs the notice rather
 * than the CLI. This script rewrites every such invocation to `smithers <verb>`
 * inside fenced shell blocks and inline code spans.
 *
 * One spelling is deliberately left alone: a version-pinned 0.x invocation such
 * as `bunx smthrs@0.35.0 ps`, which the migration guide tells an operator to
 * run against their old project. Pinning the old major is the point of it.
 *
 * Modes:
 *   node scripts/normalize-bunx.ts          rewrite files in place
 *   node scripts/normalize-bunx.ts --check  exit 1 and list offenders
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { repoRoot } from "./docs-contract.mjs"
import { isHistorical, pages } from "./docs-pages.mjs"

/**
 * The runners a 0.x page used to spell the CLI with.
 *
 * `bun x` is the spaced form of `bunx`, and `pnpm dlx` and `yarn dlx` appear in
 * copied snippets.
 */
export const runners = ["bunx", "bun x", "npx", "pnpm dlx", "yarn dlx"]

/** The package names 0.x invoked, none of which carries the 1.0 CLI. */
export const stalePackages = ["smthrs", "smithers-orchestrator"]

const runnerAlternatives = runners.map((runner) => runner.replace(" ", "\\s+")).join("|")
const packageAlternatives = stalePackages.join("|")

/**
 * A stale invocation: a runner, one of the old package names with no version
 * pin, and a verb. The negative lookahead on `@` is what preserves the pinned
 * `bunx smthrs@0.35.0` form the migration guide needs.
 */
const stalePattern = new RegExp(
  `(?<![\\w./-])(?:${runnerAlternatives})\\s+(?:${packageAlternatives})(?!@)\\s+(?=[a-z])`,
  "g"
)

/** A bare `smthrs <verb>` invocation, with no runner in front of it. */
const barePattern = new RegExp(`(?<![\\w./@-])(?:${packageAlternatives})(?!@)\\s+(?=[a-z])`, "g")

/** Rewrites one command line onto the 1.0 spelling. */
export const normalizeCommand = (line: string): string => line.replace(stalePattern, "smithers ").replace(barePattern, "smithers ")

/** Rewrites the inline code spans of a prose line, leaving the prose alone. */
export const normalizeProseLine = (line: string): string =>
  line.replace(/`([^`]+)`/g, (whole, inner: string) => {
    const fixed = normalizeCommand(inner)
    return fixed === inner ? whole : `\`${fixed}\``
  })

/** Shell languages whose fenced blocks hold command lines. */
export const shellLanguages = ["bash", "sh", "shell", "zsh", "console", ""]

/** Rewrites a whole page: shell blocks by line, prose by code span. */
export const rewrite = (source: string): string => {
  const out: Array<string> = []
  let fenced = false
  let language = ""
  for (const line of source.split("\n")) {
    const fence = /^(\s*)(`{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line)
    if (fence !== null) {
      fenced = !fenced
      language = fenced ? (fence[3] ?? "") : ""
      out.push(line)
      continue
    }
    if (fenced && shellLanguages.includes(language)) out.push(normalizeCommand(line))
    else if (fenced) out.push(line)
    else out.push(normalizeProseLine(line))
  }
  return out.join("\n")
}

/**
 * Every file this rule governs: the site pages and the repository README.
 *
 * The Smithers 0.x changelogs are excluded. They document the commands 0.x
 * shipped, and `bunx smthrs up` is what those releases were run with.
 */
export const targets = (): ReadonlyArray<string> => [
  ...pages().filter((page) => !isHistorical(page.route)).map((page) => join(repoRoot, page.path)),
  join(repoRoot, "README.md")
]

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const check = process.argv.includes("--check")
  const offenders: Array<string> = []
  let changed = 0
  for (const file of targets()) {
    const original = readFileSync(file, "utf8")
    const next = rewrite(original)
    if (next === original) continue
    const path = relative(repoRoot, file)
    if (check) offenders.push(path)
    else {
      writeFileSync(file, next)
      changed += 1
      console.log(`  fixed ${path}`)
    }
  }
  if (check) {
    if (offenders.length > 0) {
      console.error(`✗ ${offenders.length} page(s) invoke the CLI through a Smithers 0.x package name:`)
      for (const offender of offenders) console.error(`    ${offender}`)
      console.error("\nUse `smithers <verb>`, or `npx @smthrs/cli@next smithers <verb>` for a one-off run.")
      console.error("Run `node scripts/normalize-bunx.ts` to fix.")
      process.exit(1)
    }
    console.log("✓ every documented CLI invocation uses the 1.0 command")
  } else {
    console.log(`\nUpdated ${changed} file(s).`)
  }
}
