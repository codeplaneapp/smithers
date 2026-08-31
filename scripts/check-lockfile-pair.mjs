/**
 * Both lockfiles current against every workspace manifest.
 *
 * The repository ships two lockfiles because two runtimes install from it:
 * pnpm owns the workspace graph and Bun runs `apps/*`, the `ci/BUILD.ts`
 * matrix, and `evals/agent`. The invariant (CLAUDE.md, rc-contract.md
 * section "Both lockfiles") is that a dependency or manifest change
 * refreshes `pnpm-lock.yaml` and `bun.lock` in the same commit — but until
 * this gate nothing proved it, and the history carries hundreds of unpaired
 * commits.
 *
 * The check is not a git-history scan. It proves the three sources agree
 * right now: every dependency range a workspace `package.json` declares must
 * appear with that exact specifier in the `pnpm-lock.yaml` importer for that
 * workspace and in the `bun.lock` workspace entry for the same path (for
 * workspace-internal names the bun side checks presence only, because bun
 * records the resolved workspace version there rather than the range). A
 * mismatch or a missing entry names the package, the workspace, and the side
 * that drifted, then prints the regeneration command for that side
 * (`pnpm install --lockfile-only` / `bun install --lockfile-only`, the same
 * commands rc-contract.md section 9 records).
 *
 * Run it with `pnpm exec smithers-build test '//scripts:lockfilePair'`, or
 * directly with `node scripts/check-lockfile-pair.mjs`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * The dependency sections both lockfiles record per importer/workspace.
 * `peerDependencies` is excluded: pnpm importers do not list peers as
 * installed edges, so the two files are not comparable there.
 */
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"]

/** Reads the workspace directory globs pnpm-workspace.yaml declares. */
const readWorkspaceDirectories = () => {
  const text = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
  const packagesBlock = text.match(/^packages:\n((?: {2}- .+\n)+)/m)
  if (packagesBlock === null) {
    throw new Error("check-lockfile-pair: pnpm-workspace.yaml has no packages block")
  }
  /** @type {string[]} */
  const directories = []
  for (const line of packagesBlock[1].split("\n")) {
    const entry = line.match(/^ {2}- "?([^"\s]+)"?$/)
    if (entry === null) continue
    directories.push(entry[1])
  }
  return directories
}

/** Expands the pnpm-workspace globs into existing manifest directories. */
export const collectManifestDirectories = () => {
  /** @type {string[]} */
  const directories = ["."]
  for (const pattern of readWorkspaceDirectories()) {
    if (!pattern.endsWith("/*")) {
      if (existsSync(join(root, pattern, "package.json"))) directories.push(pattern)
      continue
    }
    const parent = pattern.slice(0, -2)
    const absolute = join(root, parent)
    if (!existsSync(absolute)) continue
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const relative = `${parent}/${entry.name}`
      if (existsSync(join(root, relative, "package.json"))) directories.push(relative)
    }
  }
  return directories
}

/**
 * Parses the `importers:` block of pnpm-lock.yaml into
 * path -> section -> name -> specifier. The shape is fixed (lockfile v9
 * emits two-space indentation and a `specifier:` line per entry), so a
 * purpose-built line parser is enough — no YAML dependency.
 */
export const parsePnpmImporters = () => {
  const text = readFileSync(join(root, "pnpm-lock.yaml"), "utf8")
  const start = text.indexOf("\nimporters:\n")
  if (start === -1) throw new Error("check-lockfile-pair: pnpm-lock.yaml has no importers block")
  const body = text.slice(start + "\nimporters:\n".length)
  /** @type {Map<string, Map<string, Map<string, string>>>} */
  const importers = new Map()
  let importer = null
  let section = null
  let name = null
  for (const line of body.split("\n")) {
    if (line !== "" && !line.startsWith(" ")) break // next top-level key ends the block
    let match
    if ((match = line.match(/^ {2}([^\s:][^:]*):( \{\})?$/)) !== null) {
      // `path: {}` is how pnpm emits an importer with no dependencies.
      importer = new Map()
      importers.set(match[1], importer)
    } else if (importer !== null && (match = line.match(/^ {4}(\w+):$/)) !== null) {
      section = new Map()
      importer.set(match[1], section)
    } else if (section !== null && (match = line.match(/^ {6}'?([^':]+)'?:$/)) !== null) {
      name = match[1]
    } else if (section !== null && name !== null && (match = line.match(/^ {8}specifier: (.+)$/)) !== null) {
      section.set(name, match[1].replace(/^'(.*)'$/, "$1"))
    }
  }
  return importers
}

/** Parses bun.lock (JSON with trailing commas) into its object form. */
export const parseBunLock = () => {
  const text = readFileSync(join(root, "bun.lock"), "utf8")
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"))
}

/**
 * Compares every workspace manifest against both lockfiles.
 *
 * @returns {{ pnpmDrift: string[], bunDrift: string[] }} one line per drifted
 * entry, empty when both lockfiles are current.
 */
export const collectDrift = () => {
  /** @type {string[]} */
  const pnpmDrift = []
  /** @type {string[]} */
  const bunDrift = []

  const importers = parsePnpmImporters()
  const bunLock = parseBunLock()
  const bunWorkspaces = bunLock.workspaces ?? {}
  const manifestDirectories = collectManifestDirectories()

  // The names of the workspace's own packages. For these, bun.lock records
  // the workspace version that was resolved when the edge was first locked,
  // not the manifest range — `bun install --lockfile-only` does not rewrite
  // it and `--frozen-lockfile` accepts it — so the bun side checks presence
  // only. External dependencies are compared range-for-range on both sides.
  const workspacePackageNames = new Set(
    manifestDirectories.map((directory) => JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")).name)
  )

  for (const directory of manifestDirectories) {
    const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"))
    const importer = importers.get(directory)
    const bunEntry = bunWorkspaces[directory === "." ? "" : directory]
    const label = directory === "." ? "package.json" : `${directory}/package.json`

    if (importer === undefined) {
      pnpmDrift.push(`${label}: workspace missing from pnpm-lock.yaml importers`)
    }
    if (bunEntry === undefined) {
      bunDrift.push(`${label}: workspace missing from bun.lock workspaces`)
    }

    // Both lockfiles are compared name-by-name across the sections merged:
    // pnpm dedupes a name declared in more than one section into a single
    // importer entry, so a per-section comparison would report phantom drift.
    /** @type {(entry: Record<string, Record<string, string>> | Map<string, Map<string, string>> | undefined) => Map<string, Set<string>>} */
    const mergeSections = (entry) => {
      /** @type {Map<string, Set<string>>} */
      const merged = new Map()
      if (entry === undefined) return merged
      for (const sectionName of SECTIONS) {
        const section = entry instanceof Map ? entry.get(sectionName) : entry[sectionName]
        if (section === undefined) continue
        for (const [depName, specifier] of section instanceof Map ? section : Object.entries(section)) {
          const specifiers = merged.get(depName) ?? new Set()
          specifiers.add(specifier)
          merged.set(depName, specifiers)
        }
      }
      return merged
    }

    const pnpmLocked = mergeSections(importer)
    const bunLocked = mergeSections(bunEntry)

    for (const sectionName of SECTIONS) {
      const declared = manifest[sectionName]
      if (declared === undefined) continue
      for (const [depName, range] of Object.entries(declared)) {
        if (importer !== undefined) {
          const locked = pnpmLocked.get(depName)
          if (locked === undefined) {
            pnpmDrift.push(`${label}: ${sectionName}.${depName}@${range} is not in pnpm-lock.yaml`)
          } else if (!locked.has(range)) {
            pnpmDrift.push(`${label}: ${sectionName}.${depName} is ${range} but pnpm-lock.yaml has ${[...locked].join(", ")}`)
          }
        }
        if (bunEntry !== undefined) {
          const locked = bunLocked.get(depName)
          if (locked === undefined) {
            bunDrift.push(`${label}: ${sectionName}.${depName}@${range} is not in bun.lock`)
          } else if (!workspacePackageNames.has(depName) && !locked.has(range)) {
            bunDrift.push(`${label}: ${sectionName}.${depName} is ${range} but bun.lock has ${[...locked].join(", ")}`)
          }
        }
      }
    }
  }

  return { pnpmDrift, bunDrift }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const { pnpmDrift, bunDrift } = collectDrift()
  if (pnpmDrift.length > 0 || bunDrift.length > 0) {
    console.error("check-lockfile-pair: the lockfiles are not both current with the workspace manifests.")
    if (pnpmDrift.length > 0) {
      console.error(`\n  pnpm-lock.yaml drift (${pnpmDrift.length}):`)
      for (const line of pnpmDrift) console.error(`    - ${line}`)
      console.error("  repair: pnpm install --lockfile-only")
    }
    if (bunDrift.length > 0) {
      console.error(`\n  bun.lock drift (${bunDrift.length}):`)
      for (const line of bunDrift) console.error(`    - ${line}`)
      console.error("  repair: bun install --lockfile-only")
    }
    console.error("\n  Commit the refreshed lockfile(s) with the manifest change (CLAUDE.md invariant).")
    process.exit(1)
  }
  console.log("check-lockfile-pair: pnpm-lock.yaml and bun.lock are both current with every workspace manifest")
}
