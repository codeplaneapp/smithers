import assert from "node:assert/strict"
import test from "node:test"
import { additions, assetRows, globToRegExp, originalPath, placements, routePlan } from "./docs-routes.mjs"

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
