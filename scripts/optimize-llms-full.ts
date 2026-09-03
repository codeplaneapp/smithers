#!/usr/bin/env node
/**
 * Cuts the token cost of the documentation bundles without losing information.
 *
 * The site and the bundles want different things from the same page. A reader
 * on the site follows a link, uses the "where to go next" list, and may want to
 * know that a page is generated. An agent holding the whole corpus already has
 * every page, so those are repeated tokens that buy nothing.
 *
 * Four transforms, each information-preserving for a reader who holds the whole
 * bundle:
 *
 *   1. Drop the navigation sections a page ends with.
 *   2. Drop the "Source" footer the generated pages carry.
 *   3. Turn an internal cross-reference into its own text, keeping the route
 *      that the section header already prints. External URLs are untouched.
 *   4. Collapse the whitespace and separators those removals leave behind.
 *
 * The transform is pure and idempotent, so `generate-llms.ts` applies it while
 * building and this script can be run on its own to prove the committed bundles
 * are already optimized.
 *
 * Run: node scripts/optimize-llms-full.ts [--check]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { repoRoot } from "./docs-shared.mjs"

/** Headings whose whole section is navigation rather than content. */
export const navigationHeadings = [
  "Where to go next",
  "Next steps",
  "Next Steps",
  "Read next",
  "Read Next",
  "See also",
  "See Also",
  "Related",
  "Source"
]

const navigationPattern = new RegExp(
  `(^|\\n)###\\s+(?:${navigationHeadings.map((heading) => heading.replace(/ /g, "\\s+")).join("|")})\\s*\\n[\\s\\S]*?(?=\\n##\\s|\\n---\\s*\\n|$)`,
  "g"
)

/** Removes the navigation and provenance sections a bundled page does not need. */
export const dropNavigation = (text: string): string => text.replace(navigationPattern, (_match, lead: string) => lead)

/**
 * Replaces an internal link with its own text.
 *
 * A bundle is one document: the route is already printed in the section header,
 * so the link target is a repeated path rather than a way to get anywhere.
 */
export const stripInternalLinks = (text: string): string =>
  text.replace(/\[([^\]]+)\]\((\/[A-Za-z0-9._/#-]*)\)/g, (_match, label: string) => label)

/** Collapses the blank lines and doubled separators the removals leave. */
export const collapseWhitespace = (text: string): string =>
  text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(\n---\n)(\s*\n---\n)+/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trimEnd()
    .concat("\n")

/** The whole transform: pure, and unchanged by a second application. */
export const optimize = (text: string): string => collapseWhitespace(stripInternalLinks(dropNavigation(text)))

/** The bundles this script owns when it is run on its own. */
export const bundlePaths = [
  "docs/llms.txt",
  "docs/llms-full.txt",
  "docs/llms-core.txt",
  "docs/llms-api.txt",
  "docs/llms-control.txt",
  "docs/llms-operations.txt",
  "docs/llms-migration.txt",
  "docs/llms-internals.txt",
  "packages/cli/docs/llms.txt",
  "packages/cli/docs/llms-full.txt",
  "skills/smithers/llms-full.txt"
]

/**
 * Everything `generate-llms.ts` writes, which is what `check-llms.mjs` compares.
 *
 * `packages/cli/docs/SKILL.md` is a copy of `skills/smithers/SKILL.md` rather
 * than an optimized bundle, so it is not part of {@link bundlePaths}, which is
 * this script's own input. It is still an artifact the pipeline emits, and an
 * artifact no gate reads goes stale the first time its source changes.
 */
export const checkedPaths = [...bundlePaths, "packages/cli/docs/SKILL.md"]

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const check = process.argv.includes("--check")
  const drifted: Array<string> = []
  let before = 0
  let after = 0
  for (const path of bundlePaths) {
    const absolute = join(repoRoot, path)
    let source: string
    try {
      source = readFileSync(absolute, "utf8")
    } catch {
      continue
    }
    const optimized = optimize(source)
    before += source.length
    after += optimized.length
    if (optimized === source) continue
    drifted.push(path)
    if (!check) writeFileSync(absolute, optimized)
  }
  if (check && drifted.length > 0) {
    console.error(`✗ ${drifted.length} bundle(s) are not optimized: ${drifted.join(", ")}`)
    console.error("Run `pnpm docs:llms`.")
    process.exit(1)
  }
  const saved = before - after
  console.log(
    check
      ? `✓ ${bundlePaths.length} bundle(s) are optimized`
      : `optimized ${drifted.length} bundle(s), ${saved.toLocaleString()} bytes removed`
  )
}
