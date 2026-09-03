/**
 * One `effect` version across the whole repository.
 *
 * Effect's schema internals are not interoperable between instances, so a tree
 * that resolves two copies of `effect` fails at runtime in ways a type check
 * never sees. This gate pins the supported range to the single version below
 * and proves the tree
 * agrees: every workspace manifest that declares `effect`, both lockfiles, and
 * whatever is actually installed must name it and nothing else.
 *
 * The gate reads `bun.lock` as well as `pnpm-lock.yaml` because Bun runs
 * `apps/*`, the `ci/legacy declaration` matrix, and `evals/agent`.
 *
 * Run it with `pnpm exec smithers-build test '//scripts:effectVersion'`, or directly
 * with `node scripts/check-single-effect-version.mjs`.
 */
import { createRequire } from "node:module"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { workspacePackages } from "./workspace-packages.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * The one supported version.
 *
 * Changing it requires updating every manifest and both lockfiles in the same
 * commit.
 */
export const EXPECTED_EFFECT_VERSION = "4.0.0-rc.108"


/** @type {Map<string, string[]>} */
const versions = new Map()

/**
 * @param {string | undefined} version
 * @param {string} source
 */
const addVersion = (version, source) => {
  if (typeof version !== "string") return
  const normalized = version.trim()
  if (normalized === "") return
  const sources = versions.get(normalized) ?? []
  sources.push(source)
  versions.set(normalized, sources)
}

/**
 * @param {string} manifestPath
 * @param {string} source
 */
const readManifestRanges = (manifestPath, source) => {
  if (!existsSync(manifestPath)) return
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch {
    return
  }
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const range = manifest?.[section]?.effect
    // Only exact pins are comparable; a range is a separate contract question
    // and `pnpm-lock.yaml` below reports what it actually resolved to.
    if (typeof range === "string" && /^\d/.test(range)) addVersion(range, `${source} (${section})`)
  }
}

/**
 * Collects the exact `effect` pins every workspace manifest declares.
 *
 * The member list comes from `pnpm-workspace.yaml` through the shared reader
 * rather than from a list of directory roots walked one level deep: a package
 * nested inside the product package it belongs to still pins `effect`, and a
 * one-level walk would stop reading it the day it moved.
 */
const collectManifestVersions = () => {
  readManifestRanges(join(root, "package.json"), "package.json")
  for (const member of workspacePackages(root)) {
    readManifestRanges(member.manifestPath, `${member.dir}/package.json`)
  }
}

/** Collects every `effect` version `pnpm-lock.yaml` resolved. */
const collectPnpmLockVersions = () => {
  const lockPath = join(root, "pnpm-lock.yaml")
  if (!existsSync(lockPath)) return
  const lock = readFileSync(lockPath, "utf8")
  for (const match of lock.matchAll(/^ {2}effect@([^:\s(]+):$/gm)) addVersion(match[1], "pnpm-lock.yaml")
}

/** Collects every `effect` version `bun.lock` resolved. */
const collectBunLockVersions = () => {
  const lockPath = join(root, "bun.lock")
  if (!existsSync(lockPath)) return
  const lock = readFileSync(lockPath, "utf8")
  for (const match of lock.matchAll(/"effect"\s*:\s*\[\s*"effect@([^"]+)"/g)) addVersion(match[1], "bun.lock")
}

/**
 * @param {string} packageJsonPath
 * @param {string} source
 */
const readInstalledVersion = (packageJsonPath, source) => {
  if (!existsSync(packageJsonPath)) return
  try {
    addVersion(JSON.parse(readFileSync(packageJsonPath, "utf8")).version, source)
  } catch {
    // An unreadable install is reported by the lockfile checks above.
  }
}

/** Collects the `effect` copies an install actually linked. */
const collectInstalledVersions = () => {
  readInstalledVersion(join(root, "node_modules", "effect", "package.json"), "node_modules/effect")

  const pnpmStore = join(root, "node_modules", ".pnpm")
  if (existsSync(pnpmStore)) {
    for (const entry of readdirSync(pnpmStore)) {
      if (!entry.startsWith("effect@")) continue
      readInstalledVersion(
        join(pnpmStore, entry, "node_modules", "effect", "package.json"),
        `node_modules/.pnpm/${entry}`
      )
    }
  }

  // The CLI is the entry point a consumer runs, so resolve `effect` the way it
  // does. The package root is the closest stable anchor.
  try {
    const cliRequire = createRequire(join(root, "packages", "smithers", "package.json"))
    readInstalledVersion(cliRequire.resolve("effect/package.json"), "packages/smithers import resolution")
  } catch {
    // A missing install is reported by the lockfile checks above.
  }
}

collectManifestVersions()
collectPnpmLockVersions()
collectBunLockVersions()
collectInstalledVersions()

if (versions.size === 0) {
  console.error("check-single-effect-version: found no resolved effect version in any manifest, lockfile, or install.")
  process.exit(1)
}

const sorted = [...versions.entries()].sort(([a], [b]) => a.localeCompare(b))

if (versions.size > 1) {
  console.error(`check-single-effect-version: expected exactly effect@${EXPECTED_EFFECT_VERSION}, found:`)
  for (const [version, sources] of sorted) {
    console.error(`  effect@${version}`)
    for (const source of sources) console.error(`    - ${source}`)
  }
  process.exit(1)
}

const [[version, sources]] = sorted
if (version !== EXPECTED_EFFECT_VERSION) {
  console.error(
    `check-single-effect-version: the tree resolves effect@${version}, ` +
      `but this release pins effect@${EXPECTED_EFFECT_VERSION}.`
  )
  for (const source of sources) console.error(`    - ${source}`)
  process.exit(1)
}

console.log(`check-single-effect-version: effect@${version} everywhere (${sources.length} sources)`)
