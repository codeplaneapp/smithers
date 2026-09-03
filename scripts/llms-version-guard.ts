#!/usr/bin/env node
/**
 * Keeps a released documentation bundle immutable.
 *
 * Smithers 0.x wrote one `llms-v<version>.txt` per release and refused to
 * overwrite a published one. Smithers 1.0 drops the versioned filenames
 * so the artifact that must not move after a release is the committed bundle
 * itself: `docs/llms.txt`, `docs/llms-full.txt`,
 * their topic fragments, and the two package mirrors, each stamped with the
 * `@smthrs/cli` version they were built from.
 *
 * The rule is unchanged in substance. A version that is already released, by
 * git tag or by npm, keeps the bundle it shipped with; regenerating a changed
 * bundle for it means bumping the version first.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { repoRoot } from "./docs-shared.mjs"

/** The package whose version stamps the bundles and whose release freezes them. */
export const PUBLISHED_PACKAGE_NAME = "@smthrs/cli"

/** Whether a version is out in the world, and how confidently we know it. */
export type ReleaseStatus = "released" | "unreleased" | "unavailable"

/** The version the bundles are stamped with: the CLI's, not the workspace root's. */
export const packageVersion = (): string => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8")) as {
    version?: unknown
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("llms-version-guard: packages/cli/package.json declares no version")
  }
  return manifest.version
}

/**
 * Checks local and remote refs, so a shallow CI checkout still sees a release.
 *
 * `actions/checkout` fetches without tags by default, which is why the remote
 * is consulted rather than trusted to be local.
 */
export const hasReleaseTag = (version: string): boolean => {
  const tagRef = `refs/tags/v${version}`
  const local = spawnSync("git", ["rev-parse", "--verify", "--quiet", tagRef], { cwd: repoRoot, stdio: "ignore" })
  if (local.status === 0) return true
  return (
    spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", tagRef], {
      cwd: repoRoot,
      stdio: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    }).status === 0
  )
}

/**
 * Asks npm whether an exact version is published.
 *
 * npm exits non-zero for a missing version and for a registry failure alike, so
 * only the documented not-found responses count as unreleased. Anything else is
 * unavailable, and an unavailable answer must never silently unfreeze a bundle.
 */
export const checkNpmPublication = (version: string): ReleaseStatus => {
  const result = spawnSync("npm", ["view", `${PUBLISHED_PACKAGE_NAME}@${version}`, "version"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
  if (result.status === 0) return "released"
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  if (/\bE404\b|404\s+(?:Not Found|No match)|No match found for version/i.test(output)) return "unreleased"
  return "unavailable"
}

/** A release tag is authoritative even when publication was deliberately delayed. */
export const checkVersionRelease = (
  version: string,
  options: {
    readonly hasReleaseTag?: (version: string) => boolean
    readonly checkPublication?: (version: string) => ReleaseStatus
  } = {}
): ReleaseStatus => {
  const tagged = options.hasReleaseTag ?? hasReleaseTag
  if (tagged(version)) return "released"
  return (options.checkPublication ?? checkNpmPublication)(version)
}

/**
 * Refuses a bundle change that would rewrite a released version's documentation.
 *
 * `changed` is the list of artifacts whose bytes would move. An empty list is
 * always allowed: regenerating a released version to the same bytes is how the
 * gate proves the bundles are current.
 */
export const assertRegenerable = (
  version: string,
  changed: ReadonlyArray<string>,
  status: ReleaseStatus
): void => {
  if (changed.length === 0) return
  if (status === "unreleased") return
  const reason = status === "released"
    ? `${PUBLISHED_PACKAGE_NAME}@${version} is already released (tagged or published)`
    : `the release status of ${PUBLISHED_PACKAGE_NAME}@${version} could not be determined`
  throw new Error(
    `Refusing to rewrite the documentation bundles: ${reason}.\n` +
      `Changed: ${changed.join(", ")}.\n` +
      "Bump the version first, then regenerate."
  )
}

/** The stamp every generated bundle carries, so a mirror cannot drift silently. */
export const versionStamp = (version: string): string => `Version: ${version}`
