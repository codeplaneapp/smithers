import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { repoRoot } from "./docs-contract.mjs"
import {
  additions,
  assetRows,
  deferredRouteProblems,
  deferredRoutes,
  globToRegExp,
  movedTreeProblems,
  movedTrees,
  originalPath,
  placements,
  routePlan
} from "./docs-routes.mjs"

test("turns a ledger glob into a pattern over repository paths", () => {
  assert.ok(globToRegExp("docs/images/0.23.0/**").test("docs/images/0.23.0/a.png"))
  assert.ok(globToRegExp("docs/images/0.23.0/**").test("docs/images/0.23.0/nested/a.png"))
  assert.ok(globToRegExp("docs/changelogs/0.*.mdx").test("docs/changelogs/0.35.0.mdx"))
  assert.ok(!globToRegExp("docs/changelogs/0.*.mdx").test("docs/changelogs/compatibility-policy.mdx"))
})

test("escapes a dot so a glob cannot match a neighbour", () => {
  assert.ok(!globToRegExp("docs/data/sota-models.json").test("docs/data/sota-modelsXjson"))
})

test("maps a moved asset back to the path the ledger names", () => {
  assert.equal(originalPath("public/images/0.23.0/a.png"), "docs/images/0.23.0/a.png")
  assert.equal(originalPath("docs/pages/changelogs/0.35.0.mdx"), "docs/changelogs/0.35.0.mdx")
  assert.equal(originalPath("docs/data/sota-models.json"), "docs/data/sota-models.json")
})

test("every placement declares where it moved to and why", () => {
  for (const placement of placements) {
    assert.ok(placement.from.startsWith("docs/"), `${placement.from} is not a documentation path`)
    assert.ok(placement.to.length > 0)
    assert.ok(placement.note.length > 20, `${placement.from} needs a reason a reader can use`)
  }
})

test("reads the ledger rows that name an asset family", () => {
  const rows = assetRows()
  assert.ok(rows.some((row) => row.disposition === "keep"))
  assert.ok(rows.some((row) => row.disposition === "delete"))
  for (const row of rows) assert.ok(row.globs.length > 0)
})

test("the tree places every asset the ledger keeps and none it deletes", () => {
  const plan = routePlan()
  assert.deepEqual(plan.problems, [])
  assert.ok(plan.entries.length >= 89, `expected the kept assets, got ${plan.entries.length}`)
  for (const deletion of plan.deletions) assert.deepEqual(deletion.survivors, [])
})

test("every kept changelog and image has a route, and the registry says why it has none", () => {
  const plan = routePlan()
  for (const entry of plan.entries) {
    if (entry.path.startsWith("docs/data/")) {
      assert.equal(entry.route, undefined)
      assert.match(entry.note, /0\.x CLI/)
      continue
    }
    assert.ok(entry.route?.startsWith("/"), `${entry.path} has no route`)
  }
})

test("a Phase 4 addition is recorded rather than tolerated", () => {
  assert.ok(additions.length > 0)
  for (const addition of additions) assert.ok(addition.reason.length > 20)
})

test("a page written to a moved tree is reported, not silently unpublished", () => {
  // `docs/reference`, `docs/concepts` and `docs/guides` were the Mintlify page
  // roots. vocs publishes `docs/pages` alone, so a page written to the old root
  // builds nothing, joins no sidebar, and reaches no bundle. Another lane still
  // holds patches against those paths, and the failure is invisible without
  // this.
  assert.deepEqual(movedTreeProblems(), [])
  const probe = join(repoRoot, "docs/reference/probe-unpublished.md")
  mkdirSync(join(repoRoot, "docs/reference"), { recursive: true })
  writeFileSync(probe, "# probe\n")
  try {
    const problems = movedTreeProblems()
    assert.equal(problems.length, 1, problems.join("\n"))
    assert.match(problems[0], /docs\/reference\/probe-unpublished\.md/)
    assert.match(problems[0], /docs\/pages\/api/)
  } finally {
    rmSync(probe)
    if (existsSync(join(repoRoot, "docs/reference"))) rmSync(join(repoRoot, "docs/reference"), { recursive: true })
  }
})

test("every moved tree names where it went and how a reader gets there", () => {
  assert.ok(movedTrees.length > 0)
  for (const moved of movedTrees) {
    assert.ok(moved.from.startsWith("docs/"), `${moved.from} is not a documentation path`)
    assert.ok(moved.to.startsWith("docs/pages/"), `${moved.from} must land under the published tree`)
    assert.ok(moved.route.startsWith("/"), `${moved.from} needs the route a reader types`)
    assert.ok(moved.note.length > 20, `${moved.from} needs a reason a reader can use`)
  }
})

test("a deferred route is allowed while its page is missing and retires when it lands", () => {
  // The rule, exercised on an entry of its own so it survives the shipped list
  // being empty: an allowance holds while its page is missing and reports
  // itself the moment the page arrives.
  const entries = [
    { route: "/release/known-limitations", owner: "release enforcement", reason: "two writers on one path collide at landing" }
  ]
  assert.deepEqual(deferredRouteProblems(new Set(["/installation"]), entries), [])
  const landed = deferredRouteProblems(new Set(["/release/known-limitations"]), entries)
  assert.equal(landed.length, 1, landed.join("\n"))
  assert.match(landed[0], /\/release\/known-limitations/)
})

test("the shipped deferred list is empty, and every entry it ever carries names an owner", () => {
  // `/release/known-limitations` was the one entry. The release-enforcement
  // page landed, the route resolves, and the allowance retired as designed.
  assert.deepEqual(deferredRoutes, [])
  for (const entry of deferredRoutes) {
    assert.ok(entry.owner.length > 0)
    assert.ok(entry.reason.length > 20)
  }
  assert.deepEqual(deferredRouteProblems(new Set(["/release/known-limitations"])), [])
})
