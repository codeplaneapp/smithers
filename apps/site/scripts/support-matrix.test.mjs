/**
 * Checks the published support reference against release manifests and links.
 *
 * @since 1.0.0
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import test from "node:test"
import { readWorkspaceManifests } from "../../../scripts/pack-release.mjs"

const root = resolve(import.meta.dirname, "../../..")
const read = (path) => readFileSync(resolve(root, path), "utf8")
const route = "/docs/reference/support-matrix/"

test("the support reference states every released Node engine range and current CI pins", () => {
  const page = read("apps/site/src/content/docs/docs/reference/support-matrix.mdx")
  const manifests = readWorkspaceManifests(root)
  for (const [directory, manifest] of manifests) {
    assert.ok(page.includes(`\`${manifest.engines.node}\``), `${manifest.name}: exact engines.node`)
    assert.ok(page.includes(`${directory}/package.json`), `${manifest.name}: manifest citation`)
  }
  const ci = read(".github/workflows/ci.yml")
  for (const [, pin] of ci.matchAll(/(?:node|bun)-version: ([\d.]+)/g)) {
    assert.ok(page.includes(`\`${pin}\``), `CI pin ${pin}`)
  }
  for (
    const term of [
      "unsupported_runtime",
      "bundle only",
      "advisory, not release-gating",
      "TLS termination",
      "ControlClient.credential",
      "unauthenticated",
      "before paging",
      "canary",
      "funded",
      "migrated project"
    ]
  ) {
    assert.ok(page.includes(term), `support boundary: ${term}`)
  }
})

test("installation, changelog, API overview, and navigation lead to the one support reference", () => {
  for (const path of ["docs/installation.mdx", "changelogs/1.0.0-rc.0.mdx", "docs/reference/api/index.mdx"]) {
    const page = read(`apps/site/src/content/docs/${path}`)
    assert.ok(page.includes(route), `${path}: support link`)
    assert.doesNotMatch(page, /1\.3\.14|ci\/BUILD\.ts|whichever runtime you provide/)
  }
  assert.ok(read("apps/site/astro.config.mjs").includes("slug: \"docs/reference/support-matrix\""))
})

test("Bun installation claims match its declared engine floor", () => {
  const directory = "packages/smithers/flows/platform-bun"
  const floor = JSON.parse(read(`${directory}/package.json`)).engines.bun.slice(2)
  for (const path of ["README.md", "docs/api.md", "docs/installation.md", "docs/quickstart.md"]) {
    const page = read(`${directory}/${path}`)
    assert.ok(page.includes(floor), `${path}: Bun ${floor}`)
    assert.doesNotMatch(page, /1\.3\.0/)
  }
})

test("the aggregate does not promise edge runtime execution", () => {
  const page = read("packages/smithers/flows/README.md")
  assert.doesNotMatch(page, /browser and edge runtimes may author/)
  assert.ok(page.includes("/docs/reference/support-matrix/"))
})

test("the reference is a current projection of its colocated sources", () => {
  const child = spawnSync(process.execPath, ["apps/site/scripts/sync-support-docs.mjs", "--check"], {
    cwd: root,
    encoding: "utf8"
  })
  assert.equal(child.status, 0, child.stdout + child.stderr)
})

test("generation repairs output drift and check mode refuses it", () => {
  mkdirSync(join(root, "review-evidence"), { recursive: true })
  const directory = mkdtempSync(join(root, "review-evidence/support-docs-"))
  try {
    mkdirSync(join(directory, "scripts"))
    cpSync(resolve(root, "apps/site/scripts/sync-support-docs.mjs"), join(directory, "scripts/sync-support-docs.mjs"))
    cpSync(resolve(root, "apps/site/docs"), join(directory, "docs"), { recursive: true })
    const run = (...args) =>
      spawnSync(process.execPath, [join(directory, "scripts/sync-support-docs.mjs"), ...args], {
        cwd: directory,
        encoding: "utf8"
      })
    assert.equal(run().status, 0)
    const page = join(directory, "src/content/docs/docs/reference/support-matrix.mdx")
    const generated = readFileSync(page, "utf8")
    writeFileSync(page, "stale support claim\n")
    const drift = run("--check")
    assert.equal(drift.status, 1)
    assert.match(drift.stderr, /support docs drift: docs\/reference\/support-matrix.mdx/)
    assert.equal(readFileSync(page, "utf8"), "stale support claim\n", "checking must not rewrite output")
    assert.equal(run().status, 0)
    assert.equal(readFileSync(page, "utf8"), generated)
    assert.equal(run("--check").status, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
