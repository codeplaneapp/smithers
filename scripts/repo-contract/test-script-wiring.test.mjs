/**
 * Every suite in this workspace is reachable from a command CI runs.
 *
 * Ported from the Smithers 0.x `packages/smithers/tests/test-script-wiring-gate`
 * suite. The defect it guards is the quiet one: a package with a `test/`
 * directory and no `scripts.test` never runs, and every config-level assertion
 * about it stays green while it does. The 0.x version drove a standalone
 * `check-smithers-test-script.mjs` against synthetic fixtures; the script is
 * gone, so what survives is the claim itself, checked against the real tree.
 *
 * Run it with `node --test "scripts/repo-contract/*.test.mjs"`.
 */
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..")

const readManifest = (path) => JSON.parse(readFileSync(path, "utf8"))

const rootManifest = readManifest(join(root, "package.json"))

/** Every workspace member the root manifest's globs name. */
const members = rootManifest.workspaces.flatMap((glob) => {
  if (!glob.endsWith("/*")) return existsSync(join(root, glob, "package.json")) ? [glob] : []
  const parent = glob.slice(0, -2)
  if (!existsSync(join(root, parent))) return []
  return readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json")))
    .map((entry) => `${parent}/${entry.name}`)
})

const hasTests = (directory) => {
  const candidates = ["test", "tests", "src/test"]
  return candidates.some((name) => {
    const path = join(root, directory, name)
    return existsSync(path) && statSync(path).isDirectory()
  })
}

describe("test-script wiring", () => {
  it("finds the workspace members the root manifest declares", () => {
    assert.ok(members.length > 20, `expected a populated workspace, found ${members.length}`)
  })

  it("gives every member with a test directory a test script", () => {
    for (const directory of members) {
      if (!hasTests(directory)) continue
      const manifest = readManifest(join(root, directory, "package.json"))
      assert.ok(
        manifest.scripts?.test,
        `${directory} has tests and no scripts.test, so nothing in CI runs them`
      )
    }
  })

  it("keeps the root aggregators fanning out recursively", () => {
    assert.equal(rootManifest.scripts.test, "pnpm --recursive --if-present run test")
    assert.equal(rootManifest.scripts.check, "pnpm --recursive --if-present run check")
    assert.equal(rootManifest.scripts.lint, "pnpm --recursive --if-present run lint")
  })

  it("keeps the pnpm workspace globs and the root manifest globs identical", () => {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
    const block = workspace.match(/^packages:\n(?:  - .+\n)+/m)?.[0]
    assert.ok(block, "pnpm-workspace.yaml must declare a packages block")
    const globs = block
      .split("\n")
      .slice(1)
      .filter((line) => line.startsWith("  - "))
      .map((line) => line.slice(4).replaceAll("\"", ""))
    assert.deepEqual(
      globs,
      rootManifest.workspaces,
      "pnpm installs what pnpm-workspace.yaml names and the recursive scripts fan out over the same set; "
        + "a member in one and not the other is installed but never tested, or tested and never installed"
    )
  })
})
