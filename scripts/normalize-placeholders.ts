#!/usr/bin/env node
/**
 * Normalizes command-argument placeholders to uppercase shell tokens.
 *
 * An angle-bracket placeholder such as `<run-id>` wraps badly in a rendered
 * page: the browser breaks the line at the hyphen, so it reads as `<run-i d>`.
 * It also reads as invalid command syntax next to a real flag. Uppercase tokens
 * carry no hyphen and are the conventional placeholder form, so the docs write
 * `RUN_ID`, `NODE_ID`, and `FLOW_ID`.
 *
 * Two scopes:
 *
 *   1. The hyphenated tokens `<run-id>`, `<node-id>`, and `<flow-id>` are
 *      replaced everywhere. They only ever appear as command arguments, and
 *      they are exactly the set that triggers the wrap.
 *   2. The camelCase and bare forms (`<runId>`, `<id>`, `<node>`) are replaced
 *      only inside shell blocks and only on lines that are not path or URL
 *      templates, where an angle-bracket placeholder is legitimate.
 *
 * Modes:
 *   node scripts/normalize-placeholders.ts          rewrite files in place
 *   node scripts/normalize-placeholders.ts --check  exit 1 and list offenders
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { repoRoot } from "./docs-shared.mjs"
import { isHistorical, pages } from "./docs-pages.mjs"

/** The hyphenated placeholders and the token each becomes. */
export const hyphenated: ReadonlyArray<readonly [RegExp, string]> = [
  [/<run-id>/g, "RUN_ID"],
  [/<node-id>/g, "NODE_ID"],
  [/<flow-id>/g, "FLOW_ID"],
  [/<workflow-id>/g, "FLOW_ID"]
]

/**
 * A line that is really a path or a URL template.
 *
 * `.flows/logs/<runId>.log` and `?runId=<id>` are correct as written: the
 * angle brackets mark a substitution in a path, not a command argument.
 */
export const isPathOrUrlContext = (line: string): boolean =>
  /\.flows\/|\/logs\/|\/objects\/|\?runId=|\/rpc\/|\/projections\//.test(line)

/** Maps a bare `<id>` to the token the surrounding command implies. */
export const mapBareId = (line: string): string => {
  if (/--node\s+<id>/.test(line)) return "NODE_ID"
  if (/\b(?:plan|up|ls)\s+<id>/.test(line)) return "FLOW_ID"
  return "RUN_ID"
}

/** Rewrites every placeholder in one command line. */
export const normalizeCommand = (text: string): string => {
  let out = text
  for (const [pattern, token] of hyphenated) out = out.replace(pattern, token)
  if (isPathOrUrlContext(out)) return out
  out = out.replace(/<runId>/g, "RUN_ID").replace(/<run_id>/g, "RUN_ID")
  out = out.replace(/<nodeId>/g, "NODE_ID")
  out = out.replace(/<flowId>/g, "FLOW_ID")
  out = out.replace(/(--node-id\s+|--node\s+)<node>/g, (_match, flag: string) => `${flag}NODE_ID`)
  out = out.replace(/<id>/g, () => mapBareId(out))
  return out
}

/** Rewrites a prose line: the wrap-prone tokens, and command spans in full. */
export const normalizeProseLine = (line: string): string => {
  let out = line
  for (const [pattern, token] of hyphenated) out = out.replace(pattern, token)
  return out.replace(/`([^`]+)`/g, (whole, inner: string) => {
    if (!/\bsmithers\s/.test(inner) || isPathOrUrlContext(inner)) return whole
    const fixed = normalizeCommand(inner)
    return fixed === inner ? whole : `\`${fixed}\``
  })
}

/** Shell languages whose fenced blocks hold command lines. */
export const shellLanguages = ["bash", "sh", "shell", "zsh", "console", ""]

/** Rewrites a whole page. */
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
    if (fenced && shellLanguages.includes(language)) {
      out.push(normalizeCommand(line))
    } else if (fenced) {
      let fixed = line
      for (const [pattern, token] of hyphenated) fixed = fixed.replace(pattern, token)
      out.push(fixed)
    } else {
      out.push(normalizeProseLine(line))
    }
  }
  return out.join("\n")
}

/** The files this rule governs, excluding the Smithers 0.x changelogs. */
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
      console.error(`✗ ${offenders.length} page(s) use a hyphenated angle-bracket placeholder:`)
      for (const offender of offenders) console.error(`    ${offender}`)
      console.error("\nUse RUN_ID, NODE_ID, or FLOW_ID. Run `node scripts/normalize-placeholders.ts` to fix.")
      process.exit(1)
    }
    console.log("✓ no hyphenated angle-bracket placeholders in the documentation")
  } else {
    console.log(`\nUpdated ${changed} file(s).`)
  }
}
