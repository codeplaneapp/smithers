#!/usr/bin/env node
/**
 * Fails when the committed documentation bundles are stale.
 *
 * The bundles are generated from `docs/pages`, so an edited page and an
 * unedited bundle are a contradiction: `smithers docs`, the installed skill,
 * and smithers.sh would all serve the previous text. This gate regenerates
 * them, compares the bytes, and restores the tree it found so a red check never
 * leaves a half-written artifact behind.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { repoRoot } from "./docs-contract.mjs"
import { checkedPaths } from "./optimize-llms-full.ts"

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined)

const before = new Map(checkedPaths.map((path) => [path, read(join(repoRoot, path))]))

const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "generate-llms.ts")], {
  cwd: repoRoot,
  encoding: "utf8"
})

if (result.status !== 0) {
  process.stderr.write(result.stderr ?? "")
  console.error("\n✗ the documentation bundles could not be generated")
  process.exit(result.status ?? 1)
}

const stale = checkedPaths.filter((path) => before.get(path) !== read(join(repoRoot, path)))

if (stale.length > 0) {
  for (const path of stale) {
    const original = before.get(path)
    if (original === undefined) continue
    writeFileSync(join(repoRoot, path), original)
  }
  console.error("✗ the committed documentation bundles are out of date:")
  for (const path of stale) console.error(`    ${before.get(path) === undefined ? "missing" : "stale"}: ${path}`)
  console.error("\nRun `pnpm docs:llms` and commit the result.")
  process.exit(1)
}

console.log(`✓ ${checkedPaths.filter((path) => before.get(path) !== undefined).length} documentation artifact(s) are current`)
