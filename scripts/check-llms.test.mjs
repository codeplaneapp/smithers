import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { servedBundles, servedDrift, servedRoot, siteIsBuilt } from "./check-llms.mjs"
import { repoRoot } from "./docs-shared.mjs"

/**
 * Writes a repository-shaped fixture: the curated bundles under `docs/`, and
 * whatever `served` names under the directory the deploy uploads.
 */
const fixture = (served) => {
  const root = mkdtempSync(join(tmpdir(), "check-llms-"))
  mkdirSync(join(root, "docs"), { recursive: true })
  for (const bundle of servedBundles) writeFileSync(join(root, bundle.curated), `curated ${bundle.name}\n`)
  if (served !== undefined) {
    mkdirSync(join(root, servedRoot), { recursive: true })
    for (const [name, content] of Object.entries(served)) writeFileSync(join(root, servedRoot, name), content)
  }
  return root
}

test("a tree with no built site has no served bundle to compare", () => {
  const root = fixture(undefined)
  try {
    assert.deepEqual(servedDrift(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("served bundles that match the curated bundles byte for byte are not drift", () => {
  const root = fixture(Object.fromEntries(servedBundles.map((bundle) => [bundle.name, `curated ${bundle.name}\n`])))
  try {
    assert.deepEqual(servedDrift(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("vocs' own bundle left in the served directory is drift", () => {
  // `vocs build` writes its own llms.txt and llms-full.txt into the directory
  // docs-deploy.yml uploads. That bundle carries the 0.x changelogs, the JSX
  // `<Task` tags, and the `smithers oneshot` invocations generate-llms.ts
  // excludes, and the installed skill tells agents to read
  // https://smithers.sh/llms-full.txt first.
  const root = fixture(Object.fromEntries(servedBundles.map((bundle) => [bundle.name, "vocs wrote this\n"])))
  try {
    const drift = servedDrift(root)
    assert.equal(drift.length, servedBundles.length)
    for (const bundle of servedBundles) {
      assert.ok(
        drift.some((line) => line.includes(bundle.name) && line.includes(bundle.curated)),
        `${bundle.name} is not reported against ${bundle.curated}: ${drift.join(" | ")}`
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a served bundle the build never wrote is drift, because the URL the skill names would 404", () => {
  const root = fixture({ "llms.txt": "curated llms.txt\n" })
  try {
    const drift = servedDrift(root)
    assert.equal(drift.length, 1)
    assert.match(drift[0], /llms-full\.txt is missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the deploy replaces vocs' bundles with the curated ones and re-checks before it uploads", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "docs-deploy.yml"), "utf8")
  const build = workflow.slice(workflow.indexOf("\njobs:"), workflow.indexOf("\n  deploy:"))
  const order = [
    "pnpm exec vocs build",
    "cp docs/llms.txt docs/llms-full.txt docs/dist/public/",
    "node scripts/check-llms.mjs",
    "actions/upload-pages-artifact"
  ]
  const copy = build.indexOf(order[1])
  assert.ok(copy > 0, "the deploy does not copy the curated bundles over vocs' own")
  assert.ok(build.indexOf(order[0]) < copy, "the copy runs before the build that writes vocs' bundles")
  assert.ok(build.indexOf(order[2], copy) > copy, "check-llms does not re-run against the served copies")
  assert.ok(build.indexOf(order[3]) > build.indexOf(order[2], copy), "the site is uploaded before the served copies are checked")
})

test("the built site in this tree serves the curated bundles", { skip: siteIsBuilt(repoRoot) ? false : "docs/dist is not built" }, () => {
  assert.deepEqual(servedDrift(repoRoot), [])
})
