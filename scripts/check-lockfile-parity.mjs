/**
 * Fails when a workspace manifest and `bun.lock` disagree about a dependency.
 *
 * The repository requires a manifest change to refresh both lockfiles, but
 * nothing enforced it: every CI job installs with pnpm, so `pnpm-lock.yaml` is
 * proved by `--frozen-lockfile` on every run while `bun.lock` is never read.
 * Bun still runs `apps/*`, the `ci/legacy declaration` matrix, and `evals/agent`, so a
 * stale entry there resolves a real package at the wrong version, and it does
 * so only on the Bun surfaces. `packages/fs` reached rc.0 still asking for
 * `@smthrs/core@0.1.0` that way.
 *
 * The check is a comparison, not an install: it reads the lockfile's own
 * `workspaces` table, which records the dependency ranges Bun resolved for
 * each workspace, and holds it against the manifests on disk. That runs
 * offline in milliseconds and needs no Bun on the machine.
 */
import { globSync, readFileSync } from "node:fs"
import * as path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

/**
 * `bun.lock` is JSONC: it carries whole-line comments, trailing commas, and
 * occasionally a raw control character inside a string. `JSON.parse` rejects
 * all three, so the text is normalized first. Only whole-line comments are
 * stripped, because a `//` inside a registry URL is not a comment.
 */
const readLock = () => {
  const raw = readFileSync(path.join(root, "bun.lock"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1")
    .replace(new RegExp("[\\u0000-\\u001f]", "g"), "")
  return JSON.parse(raw)
}

const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

const workspaces = readLock().workspaces ?? {}
const manifests = globSync(["packages/*/package.json", "apps/*/package.json"], { cwd: root }).sort()

const problems = []
for (const manifest of manifests) {
  const directory = path.dirname(manifest)
  const pkg = JSON.parse(readFileSync(path.join(root, manifest), "utf8"))
  const entry = workspaces[directory]
  if (entry === undefined) {
    problems.push(`${directory}: absent from bun.lock workspaces`)
    continue
  }
  for (const field of FIELDS) {
    const declared = pkg[field] ?? {}
    const locked = entry[field] ?? {}
    for (const [name, range] of Object.entries(declared)) {
      if (locked[name] !== range) {
        problems.push(`${directory}: ${field} ${name}@${range} is ${locked[name] ?? "absent"} in bun.lock`)
      }
    }
    for (const name of Object.keys(locked)) {
      if (declared[name] === undefined) {
        problems.push(`${directory}: ${field} ${name} is in bun.lock but not in the manifest`)
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`bun.lock disagrees with ${problems.length} manifest entries:`)
  for (const problem of problems) console.error(`  ${problem}`)
  console.error("\nRefresh it with: bun install --lockfile-only --offline")
  process.exit(1)
}
console.log(`bun.lock agrees with all ${manifests.length} workspace manifests`)
