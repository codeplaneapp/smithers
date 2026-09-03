/**
 * The release cut, driven end to end against a temporary repository.
 *
 * The fixture is a real git repository carrying the shapes a cut touches: a
 * `pnpm-workspace.yaml`, two members that depend on each other by exact
 * version, the three sources that repeat the release version as a literal, a
 * `CHANGELOG.md`, and a `v*` tag with commits after it. The scripts under test
 * resolve their repository root from their own location, so the fixture holds
 * copies of them and a run inside it cannot reach this checkout.
 *
 * Run it with `node --test scripts/cut-release.test.mjs`.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { dirtyPaths, nextCommands, parseArguments, releaseMessage, releaseTag, steps } from "./cut-release.mjs"
import { versionedSources } from "./set-release-version.mjs"

const scriptsDirectory = resolve(import.meta.dirname)

/** The scripts a cut spawns, plus the membership reader they share. */
const copiedScripts = [
  "cut-release.mjs",
  "generate-changelog.mjs",
  "set-release-version.mjs",
  "workspace-packages.mjs"
]

const git = (root, args, env) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", env: env === undefined ? process.env : { ...process.env, ...env } })
    .trim()

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const write = (root, path, contents) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents)
}

/**
 * A repository a cut can run in, at version 0.1.0 with two commits past its tag.
 *
 * The versioned sources are written with the exact declarations
 * `set-release-version.mjs` rewrites, so the cut's `--check` pass proves the
 * whole write, not just the manifests.
 */
const seed = () => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-cut-release-"))
  mkdirSync(join(root, "scripts"), { recursive: true })
  for (const script of copiedScripts) copyFileSync(join(scriptsDirectory, script), join(root, "scripts", script))
  write(root, "pnpm-workspace.yaml", "packages:\n  - \"packages/*\"\n")
  write(
    root,
    "package.json",
    json({ name: "fixture", private: true, repository: { type: "git", url: "git+https://github.com/smithersai/smithers.git" } })
  )
  write(
    root,
    "packages/smithers/package.json",
    json({ name: "@smthrs/cli", version: "0.1.0", dependencies: { "@smthrs/kernel": "0.1.0", effect: "4.0.0-rc.108" } })
  )
  write(root, "packages/kernel/package.json", json({ name: "@smthrs/kernel", version: "0.1.0" }))
  write(root, "packages/private/package.json", json({ name: "@smthrs/tooling", private: true, version: "0.0.0" }))
  write(root, versionedSources[0].path, "export const defaultServiceVersion = \"0.1.0\"\n")
  write(root, versionedSources[1].path, "export const version = \"0.1.0\"\n")
  write(
    root,
    versionedSources[2].path,
    "export const tool = { name: \"@smthrs/migrate\", version: \"0.1.0\" } as const\n"
  )
  write(root, "CHANGELOG.md", "# smthrs\n\nPreamble.\n\n## 0.1.0 (2020-01-01)\n\nThe first release.\n")
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.email", "release@smithers.sh"])
  git(root, ["config", "user.name", "Release"])
  const commitAll = (message, date) => {
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  }
  commitAll("🎉 chore: initial", "2026-01-01T00:00:00+00:00")
  git(root, ["tag", "v0.1.0"])
  write(root, "a.txt", "a")
  commitAll("✨ feat(cli): add the doctor verb", "2026-02-02T00:00:00+00:00")
  write(root, "b.txt", "b")
  commitAll("🐛 fix(engine): stop the leak", "2026-02-03T00:00:00+00:00")
  return root
}

const withFixture = (body) => {
  const root = seed()
  try {
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const cut = (root, args) =>
  execFileSync(process.execPath, ["scripts/cut-release.mjs", ...args], { cwd: root, encoding: "utf8" })

const manifest = (root, path) => JSON.parse(readFileSync(join(root, path), "utf8"))

test("parseArguments takes one version and refuses a tag", () => {
  assert.deepEqual(parseArguments(["1.0.0"]), { version: "1.0.0", commit: false })
  assert.deepEqual(parseArguments(["1.0.0", "--commit"]), { version: "1.0.0", commit: true })
  assert.throws(() => parseArguments([]), /usage: node scripts\/cut-release\.mjs/)
  assert.throws(() => parseArguments(["v1.0.0"]), /pass the version, not the tag: 1\.0\.0/)
  assert.throws(() => parseArguments(["1.0.0", "2.0.0"]), /cut one version at a time/)
  assert.throws(() => parseArguments(["1.0.0", "--push"]), /unknown option --push/)
})

test("a cut writes both halves and then verifies both, in that order", () => {
  assert.deepEqual(steps("1.0.0").map((step) => step.args), [
    ["scripts/set-release-version.mjs", "1.0.0"],
    ["scripts/generate-changelog.mjs", "--version", "1.0.0"],
    ["scripts/set-release-version.mjs", "--check", "1.0.0"],
    ["scripts/generate-changelog.mjs", "--check", "--version", "1.0.0"]
  ])
})

test("the printed follow-up commits with the repository's message and pushes the tag", () => {
  assert.equal(releaseMessage("1.0.0"), "🔖 release: 1.0.0")
  assert.equal(releaseTag("1.0.0"), "v1.0.0")
  assert.deepEqual(nextCommands("1.0.0"), [
    "jj commit -m \"🔖 release: 1.0.0\"",
    "git tag v1.0.0 && git push origin main v1.0.0"
  ])
})

test("a cut bumps every manifest, retargets internal ranges, and writes the section", () => {
  withFixture((root) => {
    const output = cut(root, ["0.2.0"])

    assert.equal(manifest(root, "packages/smithers/package.json").version, "0.2.0")
    assert.equal(manifest(root, "packages/smithers/package.json").dependencies["@smthrs/kernel"], "0.2.0")
    assert.equal(manifest(root, "packages/smithers/package.json").dependencies.effect, "4.0.0-rc.108")
    assert.equal(manifest(root, "packages/kernel/package.json").version, "0.2.0")
    assert.equal(manifest(root, "packages/private/package.json").version, "0.0.0", "a private manifest is not bumped")
    assert.match(readFileSync(join(root, versionedSources[0].path), "utf8"), /"0\.2\.0"/)

    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8")
    assert.match(changelog, /^## 0\.2\.0 \(2026-02-03\)$/m)
    assert.match(changelog, /^- \*\*cli:\*\* add the doctor verb \(\[[0-9a-f]{10}\]/m)
    assert.match(changelog, /^- \*\*engine:\*\* stop the leak \(\[[0-9a-f]{10}\]/m)
    assert.match(changelog, /## 0\.1\.0 \(2020-01-01\)\n\nThe first release\./, "the older section is untouched")

    assert.match(output, /jj commit -m "🔖 release: 0\.2\.0"/)
    assert.match(output, /git tag v0\.2\.0 && git push origin main v0\.2\.0/)
    assert.deepEqual(git(root, ["tag"]), "v0.1.0", "a cut without --commit tags nothing")
  })
})

test("a cut is a no-op the second time, so a re-run after a fix is safe", () => {
  withFixture((root) => {
    cut(root, ["0.2.0"])
    const first = readFileSync(join(root, "CHANGELOG.md"), "utf8")
    const dirty = dirtyPaths(root)

    cut(root, ["0.2.0"])

    assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), first)
    assert.deepEqual(dirtyPaths(root), dirty)
  })
})

test("--commit records the cut, tags it, and pushes nothing", () => {
  withFixture((root) => {
    const output = cut(root, ["0.2.0", "--commit"])

    assert.equal(git(root, ["log", "-1", "--format=%s"]), "🔖 release: 0.2.0")
    assert.deepEqual(git(root, ["tag"]).split("\n").sort(), ["v0.1.0", "v0.2.0"])
    assert.equal(git(root, ["rev-parse", "v0.2.0"]), git(root, ["rev-parse", "HEAD"]))
    assert.deepEqual(dirtyPaths(root), [], "the cut is entirely in the commit")
    assert.match(output, /Nothing was pushed\./)
    assert.equal(output.includes("git push origin main v0.2.0\n"), true)
  })
})

test("the section a cut writes still checks green once the release commit exists", () => {
  withFixture((root) => {
    cut(root, ["0.2.0", "--commit"])

    // This is the check `release.yml` runs at the tag. It reads
    // `v0.1.0..HEAD`, and HEAD is now the release commit the cut just made, so
    // a generator that listed release commits would report its own work as
    // drift and fail every real release.
    const checked = execFileSync(
      process.execPath,
      ["scripts/generate-changelog.mjs", "--check", "--version", "0.2.0"],
      { cwd: root, encoding: "utf8" }
    )
    assert.match(checked, /matches v0\.1\.0\.\.HEAD/)
  })
})

test("--commit refuses a dirty working copy rather than sweeping it into the release", () => {
  withFixture((root) => {
    writeFileSync(join(root, "a.txt"), "someone else's edit")

    assert.throws(() => cut(root, ["0.2.0", "--commit"]), /--commit stages every tracked modification/)
    assert.equal(manifest(root, "packages/kernel/package.json").version, "0.1.0", "the refusal is before the first write")
  })
})
