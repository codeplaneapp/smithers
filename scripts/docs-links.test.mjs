import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { repoRoot } from "./docs-contract.mjs"
import { anchorsLinkedTo, deadLinks, isInternal, linkTargets, missingAnchors, resolveLink } from "./docs-links.mjs"

const site = {
  routes: new Set(["/installation", "/api/database", "/architecture/browser-support"]),
  assets: new Set(["/images/0.23.0/run.png"]),
  deferred: new Set(["/release/known-limitations"])
}

test("reads every spelling that becomes an anchor", () => {
  const body = [
    "See [install](/installation) and [png](/images/0.23.0/run.png 'title').",
    'An MDX page writes <a href="/api/database">the reference</a>.',
    "",
    "[shorthand]: /architecture/browser-support"
  ].join("\n")
  // Markdown links first, then hand-written hrefs, then reference definitions.
  assert.deepEqual(linkTargets(body), [
    "/installation",
    "/images/0.23.0/run.png",
    "/api/database",
    "/architecture/browser-support"
  ])
})

test("a scheme or a bare fragment addresses nothing this site publishes", () => {
  assert.equal(isInternal("https://smithers.sh"), false)
  assert.equal(isInternal("mailto:hi@example.com"), false)
  assert.equal(isInternal("javascript:alert(1)"), false)
  assert.equal(isInternal("#anchor"), false)
  assert.equal(isInternal("/installation"), true)
  assert.equal(isInternal("../api/database"), true)
})

test("a relative link resolves against the page that writes it", () => {
  assert.equal(resolveLink("/api/database", "../installation"), "/installation")
  assert.equal(resolveLink("/api/database", "./gateway.md"), "/api/gateway")
  assert.equal(resolveLink("/guides/testing", "/api/database#retry"), "/api/database")
  assert.equal(resolveLink("/", "concepts/journal/index.mdx"), "/concepts/journal")
})

test("a relative link to a page that does not exist is dead", () => {
  // The check this replaced read absolute Markdown links only, so a page could
  // link `../reference/run-store.md` and ship a 404.
  const { dead } = deadLinks([{ path: "docs/pages/api/gateway.md", route: "/api/gateway", body: "[gone](../reference/run-store.md)" }], site)
  assert.deepEqual(dead, ["docs/pages/api/gateway.md: ../reference/run-store.md"])
})

test("an href a page writes by hand is checked like a Markdown link", () => {
  const { dead } = deadLinks([{ path: "docs/pages/external.mdx", route: "/external", body: '<a href="/api/missing">x</a>' }], site)
  assert.deepEqual(dead, ["docs/pages/external.mdx: /api/missing"])
})

test("a route recorded as deferred is allowed, and a served asset resolves", () => {
  const body = "[limits](/release/known-limitations) [shot](/images/0.23.0/run.png) [db](/api/database#sqlite)"
  const { checked, dead } = deadLinks([{ path: "docs/pages/installation.md", route: "/installation", body }], site)
  assert.equal(checked, 3)
  assert.deepEqual(dead, [])
})

test("vocs still reports the dead links it finds", () => {
  // The build does not fail on them, because the gate that runs before it
  // already did and knows about the deferred route. Silencing vocs entirely
  // would drop the second opinion as well as the failure.
  const config = readFileSync(join(repoRoot, "vocs.config.ts"), "utf8")
  assert.match(config, /checkDeadlinks: "warn"/)
})

test("a heading answers the anchor a link points at, and one that is gone is named", () => {
  const body = [
    "# Migrating from Smithers 0.x",
    "",
    "## Removed flags",
    "",
    "#### supervision",
    "",
    "```",
    "#### plan-admission",
    "```"
  ].join("\n")
  const anchors = new Set(["removed-flags", "supervision", "plan-admission"])

  // The heading inside the fence is code a page quotes, not structure a
  // reader can land on, so the anchor it looks like is still missing.
  assert.deepEqual(missingAnchors(body, anchors), ["plan-admission"])
  assert.deepEqual(missingAnchors(body.replace("#### supervision", ""), anchors), [
    "plan-admission",
    "supervision"
  ])
})

test("the anchors are read out of the sentences the CLI prints", () => {
  const messages = [
    "smithers rewind was removed in 1.0.0-rc.0: reason. See https://smithers.sh/migration/1.0#rewind",
    "smithers up --force was removed in 1.0.0-rc.0: reason. See https://smithers.sh/migration/1.0#supervision"
  ]
  assert.deepEqual(
    [...anchorsLinkedTo("https://smithers.sh/migration/1.0", messages)].sort(),
    ["rewind", "supervision"]
  )
})

test("every anchor the CLI sends an operator to resolves in the migration guide", async () => {
  const unsupported = await import("../packages/cli/src/Unsupported.ts")
  const sentences = [
    ...unsupported.removedVerbs.map((verb) => unsupported.verbError(verb).message),
    ...unsupported.removedFlags.map((flag) => unsupported.flagMessage(flag)),
    unsupported.reservedFlowError("run", "system/plan").message
  ]
  const anchors = anchorsLinkedTo(unsupported.migrationUrl, sentences)
  const body = readFileSync(join(repoRoot, "docs", "pages", "migration", "1.0.md"), "utf8")

  assert.ok(anchors.size > 60, `expected the removal surface to link many anchors, got ${anchors.size}`)
  assert.deepEqual(missingAnchors(body, anchors), [])
})
