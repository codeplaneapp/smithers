/**
 * Cuts one release in the working copy: the version bump, the changelog
 * section, and the two verifications that prove both landed.
 *
 * Before this script the bump and the changelog were separate operator moves
 * with nothing sequencing them, and only one of them was checked. The version
 * setter has had a `--check` mode since it was written, `release.yml` runs it,
 * and a tag whose manifests disagreed with it failed loudly. The changelog had
 * no such gate at all, so the release that shipped with a missing section
 * shipped green.
 *
 * The script writes and then re-reads. Writing and verifying are separate
 * passes on purpose: the check is the same one `release.yml` runs, so a cut
 * that passes here is a cut whose release job reaches the pack step.
 *
 * Nothing here pushes. `--commit` records the cut and tags it locally; the tag
 * push is the irreversible half and stays an operator's own keystroke, because
 * pushing a `v*` tag is what starts the publish.
 *
 * usage:
 *   node scripts/cut-release.mjs <version> [--commit]
 *
 *   <version>   the release version, without the leading `v`
 *   --commit    also `git commit -am` the cut and `git tag v<version>`
 */
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")

/** The commit message a cut records, in the repository's emoji convention. */
export const releaseMessage = (version) => `🔖 release: ${version}`

/** The tag one version is released under. */
export const releaseTag = (version) => `v${version}`

/**
 * The two commands the operator runs after a cut, in order.
 *
 * The first is spelled for jj because this tree is jj-colocated and that is
 * what a maintainer types; `git commit -am` is what `--commit` runs, and both
 * record the same commit. The second is the irreversible one: pushing the tag
 * is what triggers `.github/workflows/release.yml`.
 */
export const nextCommands = (version) => [
  `jj commit -m ${JSON.stringify(releaseMessage(version))}`,
  `git tag ${releaseTag(version)} && git push origin main ${releaseTag(version)}`
]

/**
 * Every child invocation a cut makes, in order: write, write, verify, verify.
 *
 * Declared as data so the suite can assert the order and the flags without
 * running a release, and so the two verifications are visibly the same
 * commands `release.yml` runs rather than a paraphrase of them.
 */
export const steps = (version) => [
  { name: "set the workspace version", args: ["scripts/set-release-version.mjs", version] },
  { name: "write the changelog section", args: ["scripts/generate-changelog.mjs", "--version", version] },
  { name: "verify the workspace version", args: ["scripts/set-release-version.mjs", "--check", version] },
  { name: "verify the changelog section", args: ["scripts/generate-changelog.mjs", "--check", "--version", version] }
]

const run = (root, command, args) =>
  execFileSync(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] })

/**
 * The tracked paths git reports as modified, staged, or deleted.
 *
 * Untracked files are deliberately absent: they are not what `git commit -am`
 * would sweep in, so they are not what makes a cut unsafe.
 */
export const dirtyPaths = (root = repoRoot) =>
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3))

export const parseArguments = (argv) => {
  const options = { version: undefined, commit: false }
  for (const argument of argv) {
    if (argument === "--commit") {
      options.commit = true
      continue
    }
    if (argument.startsWith("-")) throw new Error(`unknown option ${argument}`)
    if (options.version !== undefined) throw new Error(`cut one version at a time, not ${options.version} and ${argument}`)
    options.version = argument
  }
  if (options.version === undefined) throw new Error("usage: node scripts/cut-release.mjs <version> [--commit]")
  if (options.version.startsWith("v")) throw new Error(`pass the version, not the tag: ${options.version.slice(1)}`)
  return options
}

export const main = (argv, root = repoRoot) => {
  const options = parseArguments(argv)
  // The guard is before the first write, not after it. `git commit -am` stages
  // every tracked modification, so a cut run over someone else's half-finished
  // edit would publish it under a release message. Refusing here also leaves
  // the tree untouched, so the operator's next move is `jj st`, not a revert.
  if (options.commit) {
    const dirty = dirtyPaths(root)
    if (dirty.length > 0) {
      throw new Error(
        `--commit stages every tracked modification and the working copy carries ${dirty.length}: ${
          dirty.join(", ")
        }`
      )
    }
  }
  for (const step of steps(options.version)) {
    process.stdout.write(`\n=== ${step.name}\n`)
    run(root, process.execPath, step.args)
  }
  if (options.commit) {
    process.stdout.write("\n=== record the cut\n")
    run(root, "git", ["commit", "-am", releaseMessage(options.version)])
    run(root, "git", ["tag", releaseTag(options.version)])
    process.stdout.write(
      `\nCut ${options.version} and tagged ${releaseTag(options.version)}. Nothing was pushed.\n`
    )
    process.stdout.write(`Push the tag to publish:\n  git push origin main ${releaseTag(options.version)}\n`)
    return
  }
  process.stdout.write(`\n${options.version} is cut in the working copy. Run these two next:\n`)
  for (const command of nextCommands(options.version)) process.stdout.write(`  ${command}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2))
}
