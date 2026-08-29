/**
 * Sets one version across every workspace manifest, including the exact
 * `@smthrs/*` ranges the workspaces use for each other.
 *
 * The release workflow refuses a tag whose version does not match every engine
 * manifest, and the published packages depend on their siblings by exact
 * version. So a release bump is not `version` alone: an engine package
 * published as 0.1.0-next.0 that still depends on `@smthrs/kernel@0.1.0`
 * installs to a version nobody published. This rewrites both halves in one
 * pass, across every group, so the workspace stays resolvable afterwards.
 *
 * usage:
 *   node scripts/set-release-version.mjs <version>     rewrite manifests
 *   node scripts/set-release-version.mjs --check <version>
 *                                                      report drift, exit 1
 */
import { globSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspaceFile = join(repoRoot, "pnpm-workspace.yaml")

const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

/**
 * Reads the package globs from pnpm's workspace manifest.
 */
export const readWorkspacePatterns = (path = workspaceFile) => {
  const lines = readFileSync(path, "utf8").split(/\r?\n/)
  const heading = lines.findIndex((line) => /^\s*packages\s*:\s*(?:#.*)?$/.test(line))
  if (heading < 0) throw new Error(`${path} has no packages list`)
  const indentation = lines[heading].match(/^\s*/)[0].length
  const patterns = []
  for (const line of lines.slice(heading + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const currentIndentation = line.match(/^\s*/)[0].length
    if (currentIndentation <= indentation) break
    const item = line.match(/^\s*-\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/)
    if (item === null) throw new Error(`unsupported packages entry in ${path}: ${line.trim()}`)
    patterns.push(item[1] ?? item[2] ?? item[3])
  }
  if (patterns.length === 0) throw new Error(`${path} has an empty packages list`)
  return patterns
}

/**
 * Reads every manifest selected by `pnpm-workspace.yaml`, keyed by its path
 * relative to the repository root.
 */
export const readManifests = (root = repoRoot, path = join(root, "pnpm-workspace.yaml")) => {
  const manifests = new Set(
    readWorkspacePatterns(path).flatMap((pattern) =>
      globSync(`${pattern.replace(/\/$/, "")}/package.json`, { cwd: root })
    )
  )
  return [...manifests].sort().map((relativePath) => ({
    directory: dirname(relativePath),
    path: join(root, relativePath),
    manifest: JSON.parse(readFileSync(join(root, relativePath), "utf8"))
  }))
}

/**
 * Retargets one manifest at `version`.
 *
 * Only ranges naming a workspace package are rewritten, and `workspace:` and
 * `catalog:` protocol ranges are left alone — they carry no version to drift.
 */
export const retarget = (manifest, version, workspaceNames) => {
  const updated = manifest.private === true ? { ...manifest } : { ...manifest, version }
  for (const field of dependencyFields) {
    if (manifest[field] === undefined) continue
    updated[field] = Object.fromEntries(
      Object.entries(manifest[field]).map(([name, range]) =>
        workspaceNames.has(name) && !range.includes(":") ? [name, version] : [name, range]
      )
    )
  }
  return updated
}

/**
 * Every place a manifest still disagrees with `version`.
 */
export const mismatches = (entries, version) => {
  const workspaceNames = new Set(entries.map(({ manifest }) => manifest.name))
  const found = []
  for (const { directory, manifest } of entries) {
    if (manifest.private !== true && manifest.version !== version) {
      found.push(`${directory}: version is ${manifest.version}, expected ${version}`)
    }
    for (const field of dependencyFields) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (!workspaceNames.has(name) || range.includes(":") || range === version) continue
        found.push(`${directory}: ${field}.${name} is ${range}, expected ${version}`)
      }
    }
  }
  return found
}

export const main = (argv) => {
  const check = argv[0] === "--check"
  const version = check ? argv[1] : argv[0]
  if (version === undefined || version.startsWith("-")) {
    throw new Error("usage: node scripts/set-release-version.mjs [--check] <version>")
  }
  if (version.startsWith("v")) {
    throw new Error(`pass the version, not the tag: ${version.slice(1)}`)
  }
  const entries = readManifests()
  if (check) {
    const drift = mismatches(entries, version)
    for (const line of drift) console.error(line)
    if (drift.length > 0) {
      console.error(`\n${drift.length} manifest entries disagree with ${version}.`)
      process.exitCode = 1
      return
    }
    console.log(`${entries.length} workspace manifests have release ranges at ${version}.`)
    return
  }
  const workspaceNames = new Set(entries.map(({ manifest }) => manifest.name))
  let written = 0
  for (const { manifest, path } of entries) {
    const updated = retarget(manifest, version, workspaceNames)
    const text = `${JSON.stringify(updated, null, 2)}\n`
    if (text === `${JSON.stringify(manifest, null, 2)}\n`) continue
    writeFileSync(path, text)
    written += 1
  }
  console.log(`set ${written} of ${entries.length} workspace manifests to ${version}.`)
  console.log("run `pnpm install --lockfile-only` next: the lockfile records these specifiers.")
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2))
}
