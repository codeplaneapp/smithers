/**
 * The Phase 7 gate on `legacy/`.
 *
 * `legacy/` holds the Smithers 0.x sources that Phase 4 lanes port from. It is
 * outside the pnpm workspace, outside the root TypeScript program, outside
 * every legacy declaration inventory, and outside every walk that honors `.gitignore`
 * (`legacy/.gitignore` ignores its own contents). Nothing live may import it.
 *
 * The directory is deliberately temporary: PLAN.md Phase 7 requires that only
 * one Smithers execution architecture remains, which means every remaining file
 * here has either been ported or recorded as dropped in
 * `docs/migration/disposition-ledger.md`. This gate is therefore expected to
 * FAIL from Phase 2 until the last port lands, and it exists so that "legacy is
 * empty" is a checked fact rather than a claim in a report.
 *
 * Run it with `pnpm run check:legacy-absent` from the repository root.
 */
import { readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..")
const legacyRoot = join(repoRoot, "legacy")

/** The directory's own ignore file leaves with the directory, so it is not a survivor. */
const ownFiles = new Set([".gitignore"])

/**
 * Lists every file under `legacy/`, depth first, as repository-relative POSIX
 * paths.
 *
 * @param {string} directory Absolute path.
 * @returns {string[]}
 */
const listFiles = (directory) => {
  /** @type {string[]} */
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...listFiles(full))
      continue
    }
    const path = relative(repoRoot, full).split("\\").join("/")
    if (path === "legacy/.gitignore" && ownFiles.has(entry.name)) continue
    found.push(path)
  }
  return found
}

let survivors = []
try {
  if (statSync(legacyRoot).isDirectory()) survivors = listFiles(legacyRoot)
} catch {
  survivors = []
}

if (survivors.length === 0) {
  console.log("check-legacy-absent: legacy/ is empty; every 0.x path has been ported or dropped")
  process.exit(0)
}

console.error(`check-legacy-absent: ${survivors.length} file(s) remain under legacy/:`)
for (const path of survivors) console.error(`  ${path}`)
console.error(
  "\nEvery file here belongs to a disposition-ledger row. Port it to its recorded\n" +
    "newHome and `git rm` the legacy copy, or `git rm` it and record the reason in\n" +
    "docs/migration/phase2-baseline.md. This gate is expected to fail until the\n" +
    "last Phase 4 port lands (PLAN.md Phase 7)."
)
process.exit(1)
