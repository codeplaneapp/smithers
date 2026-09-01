#!/usr/bin/env node
/**
 * The documentation gate.
 *
 * Fourteen checks over the vocs page tree, each one a claim the documentation
 * makes that can be verified against something else in the repository:
 *
 *   1. house style: no em-dash anywhere in the prose
 *   2. every page carries a frontmatter description and one H1
 *   3. every internal link resolves to a page route or a served asset
 *   4. every documented import resolves to a package this workspace publishes
 *   5. nothing shipped is still described as coming soon
 *   6. the CLI catalog matches what the binary's `--help` prints
 *   7. no page outside the migration guide names a removed verb, a JSX API, or
 *      a Smithers 0.x package
 *   8. the generated pages are current
 *   9. every asset the ledger keeps has a place in the route plan
 *  10. every page is reachable from the sidebar, and every sidebar link resolves
 *  11. the compatibility promise is quoted verbatim wherever section 11 says
 *  12. every document that states the size of the published set agrees with
 *      the count section 3.1 spells
 *  13. no page sits in a tree vocs stopped publishing, and every route linked
 *      before its page exists is still waiting for it
 *  14. every anchor a removal message sends an operator to has a heading in
 *      the migration guide
 *  15. the browser-support tables and every stated browser entry-point count
 *      match the contract `pnpm run browser` executes
 *
 * The normalizers and every package-owned docs generator run in `--check`
 * mode, so their rules stay one implementation rather than a detector and a
 * fixer that can disagree.
 *
 * Run: node scripts/check-docs.mjs
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  availableCommands,
  citedPackageCounts,
  compatibilityPromise,
  countCitingDocuments,
  promiseHolders,
  publishedPackageCount,
  namedRemovedSurfaces,
  removedCommands,
  removedJsxSurfaces,
  removedZeroXPackages,
  repoRoot
} from "./docs-contract.mjs"
import { anchorsLinkedTo, deadLinks, missingAnchors } from "./docs-links.mjs"
import { assets, isHistorical, pages } from "./docs-pages.mjs"
import { sidebarRoutes } from "./docs-sidebar.mjs"
import { deferredRouteProblems, deferredRoutes, movedTreeProblems, movedTrees, routePlan } from "./docs-routes.mjs"
import { cliCatalog } from "./docs-help.mjs"
import { codeSpans, tableUnder } from "./docs-contract.mjs"
import { browserEntryNames, citedBrowserCounts, nodeEntryNames } from "./browser-contract.mjs"

let failed = false

const fail = (title, offenders) => {
  failed = true
  console.error(`\n✗ ${title}:`)
  for (const offender of offenders) console.error(`    ${offender}`)
}

const pass = (title) => console.log(`✓ ${title}`)

const allPages = pages()
const routes = new Set(allPages.map((page) => page.route))
const servedAssets = new Set(assets())
// One route is linked before the page answering it exists, because another body
// of work owns that page. Check 13 keeps the allowance from outliving the gap.
const deferred = new Set(deferredRoutes.map((entry) => entry.route))


// -----------------------------------------------------------------------------
// 1. House style
// -----------------------------------------------------------------------------

{
  const offenders = allPages
    .filter((page) => page.body.includes("—"))
    .map((page) => page.path)
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8")
  if (readme.includes("—")) offenders.push("README.md")
  if (offenders.length > 0) {
    fail("pages contain an em-dash, which the house style forbids", offenders)
  } else {
    pass("no em-dashes in the documentation")
  }
}

// -----------------------------------------------------------------------------
// 2. Page shape
// -----------------------------------------------------------------------------

{
  // A page titles itself with a level-one heading or with a frontmatter
  // `title`; vocs reads either. Headings inside a fenced block are shell
  // comments, not headings.
  const headings = (body) => {
    let fenced = false
    let count = 0
    for (const line of body.split("\n")) {
      if (/^\s*```/.test(line)) fenced = !fenced
      else if (!fenced && /^#\s+/.test(line)) count += 1
    }
    return count
  }
  const offenders = []
  for (const page of allPages) {
    if (page.description === undefined) offenders.push(`${page.path}: no frontmatter description`)
    const count = headings(page.body)
    if (page.title === undefined && page.frontmatter.title === undefined) {
      offenders.push(`${page.path}: no title, in frontmatter or as a heading`)
    }
    if (count > 1) offenders.push(`${page.path}: ${count} level-one headings`)
  }
  if (offenders.length > 0) fail("every page needs one description and one title", offenders)
  else pass(`${allPages.length} pages carry a description and a single title`)
}

// -----------------------------------------------------------------------------
// 3. Internal links
// -----------------------------------------------------------------------------

{
  const { checked, dead } = deadLinks(allPages, { assets: servedAssets, deferred, routes })
  if (dead.length > 0) fail("internal links must resolve to a page or a served asset", dead)
  else pass(`all ${checked} internal links resolve`)
}

// -----------------------------------------------------------------------------
// 4. Documented imports
// -----------------------------------------------------------------------------

{
  const workspacePackages = new Set()
  const packagesRoot = join(repoRoot, "packages")
  for (const name of readdirSync(packagesRoot)) {
    const manifest = join(packagesRoot, name, "package.json")
    if (!existsSync(manifest)) continue
    const declared = JSON.parse(readFileSync(manifest, "utf8")).name
    if (typeof declared === "string") workspacePackages.add(declared)
  }

  const offenders = []
  for (const page of allPages) {
    if (isHistorical(page.route)) continue
    for (const match of page.body.matchAll(/from\s+"(@smthrs\/[a-z0-9-]+)(\/[^"]*)?"/g)) {
      const name = match[1]
      if (workspacePackages.has(name)) continue
      offenders.push(`${page.path}: ${name}`)
    }
  }
  if (offenders.length > 0) fail("documented imports must resolve to a workspace package", offenders)
  else pass("every documented @smthrs import resolves to a workspace package")
}

// -----------------------------------------------------------------------------
// 5. Coming soon
// -----------------------------------------------------------------------------

{
  // A feature the release ships must not be described as pending. The list is
  // the set of claims Phase 5 made true; each one was "planned" in an imported
  // page at some point.
  const shipped = [
    /durable cancel/i,
    /signal delivery/i,
    /retry bound/i,
    /process containment/i,
    /owner fence/i
  ]
  const offenders = []
  for (const page of allPages) {
    if (isHistorical(page.route)) continue
    for (const line of page.body.split("\n")) {
      if (!/coming soon|not yet implemented|planned integration|remains planned/i.test(line)) continue
      if (!shipped.some((pattern) => pattern.test(line))) continue
      offenders.push(`${page.path}: ${line.trim().slice(0, 120)}`)
    }
  }
  if (offenders.length > 0) fail("shipped behavior is still described as pending", offenders)
  else pass("nothing shipped is described as pending")
}

// -----------------------------------------------------------------------------
// 6. CLI catalog against the binary
// -----------------------------------------------------------------------------

{
  const catalog = cliCatalog()
  const removed = removedCommands()
  const documented = new Set(
    allPages
      .filter((page) => page.route.startsWith("/cli/") && page.route !== "/cli")
      .map((page) => page.route.slice("/cli/".length))
  )
  const guide = allPages.find((page) => page.route === "/migration/1.0")
  if (guide === undefined) throw new Error("check-docs: the migration guide is missing")
  const anchors = new Set([...guide.body.matchAll(/^###\s+(\S+)\s*$/gm)].map((match) => match[1]))

  const offenders = []
  for (const [name] of catalog.commands) {
    if (documented.has(name)) continue
    if (removed.has(name) && anchors.has(name)) continue
    offenders.push(
      removed.has(name)
        ? `${name} is removed by the contract but has no anchor in the migration guide`
        : `${name} is offered by the binary and documented nowhere`
    )
  }
  for (const name of documented) {
    if (catalog.commands.has(name)) continue
    offenders.push(`/cli/${name} documents a command the binary does not offer`)
  }
  for (const [name, command] of catalog.commands) {
    if (!documented.has(name)) continue
    const page = allPages.find((candidate) => candidate.route === `/cli/${name}`)
    if (page?.description === command.description) continue
    offenders.push(`/cli/${name} summary is "${page?.description}" and --help says "${command.description}"`)
  }
  if (offenders.length > 0) fail("the CLI catalog must match the binary", offenders)
  else pass(`the CLI catalog matches ${catalog.commands.size} commands from --help`)
}

// -----------------------------------------------------------------------------
// 7. Removed surfaces
// -----------------------------------------------------------------------------

{
  const removed = removedCommands()
  const available = availableCommands()
  const surfaces = {
    jsx: removedJsxSurfaces(),
    packages: removedZeroXPackages,
    commands: [...removed.keys()].filter((name) => !available.has(name))
  }
  const offenders = []
  for (const page of allPages) {
    // Four exemptions, and each names a removed surface in order to say it is
    // gone: the 0.x changelogs are the record of the releases that shipped it,
    // the migration guide maps every construct to its replacement, the
    // compatibility policy quotes the promise that lists them, and the
    // known-limitations table quotes contract section 7, which names the
    // commands and packages the release excludes. Every other page is held to
    // never mentioning one, which is what makes those four readable as the
    // places to look.
    if (isHistorical(page.route)) continue
    if (page.route.startsWith("/migration")) continue
    if (page.route === "/changelogs/compatibility-policy") continue
    if (page.route === "/release/known-limitations") continue
    for (const surface of namedRemovedSurfaces(page.body, surfaces)) {
      offenders.push(`${page.path}: ${surface}`)
    }
  }
  if (offenders.length > 0) {
    fail("only the migration guide may name a removed verb, a JSX API, or a 0.x package", offenders)
  } else {
    pass("no page outside the migration guide names a removed surface")
  }
}

// -----------------------------------------------------------------------------
// 8 and 9. Generated pages, normalizers, and the route plan
// -----------------------------------------------------------------------------

const packageDocGenerators = readdirSync(join(repoRoot, "packages"))
  .map((name) => `packages/${name}/scripts/docs.mjs`)
  .filter((path) => existsSync(join(repoRoot, path)))
  .map((path) => [`the ${path.split("/")[1]} package documentation is current`, [path, "--check"]])

for (const [title, argv] of [
  ["the CLI invocations are the 1.0 command", ["scripts/normalize-bunx.ts", "--check"]],
  ["the argument placeholders are normalized", ["scripts/normalize-placeholders.ts", "--check"]],
  ["the generated pages are current", ["scripts/generate-docs-pages.mjs", "--check"]],
  ...packageDocGenerators
]) {
  const result = spawnSync(process.execPath, argv.map((entry) => (entry.startsWith("-") ? entry : join(repoRoot, entry))), {
    cwd: repoRoot,
    stdio: "inherit"
  })
  if (result.status !== 0) {
    failed = true
    console.error(`✗ ${title}`)
  }
}

{
  const plan = routePlan()
  if (plan.problems.length > 0) fail("the route plan must cover every kept asset", plan.problems)
  else pass(`the route plan covers ${plan.entries.length} kept assets and ${plan.deletions.length} deletion rules`)
}

// -----------------------------------------------------------------------------
// 10. Sidebar reachability
// -----------------------------------------------------------------------------

{
  // A generated page can exist, build, and ship while reachable only by guessing
  // its URL, because sidebar order is the one editorial thing no generator
  // writes. Both directions matter: an unlisted page is invisible, and a link to
  // a page that no longer exists is a 404 in the site's own navigation.
  const links = await sidebarRoutes()
  const offenders = []
  for (const page of allPages) {
    if (isHistorical(page.route) || links.has(page.route)) continue
    offenders.push(`${page.path} is published and the sidebar does not list it`)
  }
  for (const link of links) {
    if (link.startsWith("http") || routes.has(link) || deferred.has(link)) continue
    offenders.push(`the sidebar links ${link} and no page answers it`)
  }
  if (offenders.length > 0) fail("the sidebar must reach every page", offenders)
  else pass(`the sidebar reaches all ${links.size} routes the site publishes`)
}

// -----------------------------------------------------------------------------
// 11. The compatibility promise
// -----------------------------------------------------------------------------

{
  // Section 11 froze one paragraph and named the three places it belongs. A
  // rewrapped or reworded copy is a different promise, and this repository has
  // already had one silently rewritten by a rename pass.
  const promise = compatibilityPromise()
  const offenders = promiseHolders.filter((path) => !readFileSync(join(repoRoot, path), "utf8").includes(promise))
  if (offenders.length > 0) {
    fail("the compatibility promise must be quoted verbatim", offenders.map((path) => `${path}: not verbatim`))
  } else {
    pass(`the compatibility promise is verbatim in ${promiseHolders.length} places`)
  }
}

// -----------------------------------------------------------------------------
// 12. The size of the published set
// -----------------------------------------------------------------------------

{
  // Two documents state how many packages the release publishes, in prose a
  // maintainer reads before running the publish. The number is written by hand
  // and goes stale the moment a package joins the release, which is exactly
  // what happened when the migration tool became the fortieth name.
  const declared = publishedPackageCount()
  const offenders = []
  for (const path of countCitingDocuments()) {
    for (const cited of citedPackageCounts(readFileSync(join(repoRoot, path), "utf8"))) {
      if (cited !== declared) offenders.push(`${path}: states ${cited}, the contract freezes ${declared}`)
    }
  }
  if (offenders.length > 0) fail("a document states the wrong number of published packages", offenders)
  else pass(`every stated package count matches the ${declared} names in contract section 3.1`)
}

// -----------------------------------------------------------------------------
// 13. Moved trees and deferred routes
// -----------------------------------------------------------------------------

{
  // vocs publishes `docs/pages` and nothing else. A page written to one of the
  // Mintlify page roots builds no route and raises no error, so it leaves the
  // site, the sidebar and the llms bundles at once and nobody finds out. Other
  // work still holds patches against those paths, which is what makes this a
  // gate rather than a note.
  const offenders = [...movedTreeProblems(), ...deferredRouteProblems(routes)]
  if (offenders.length > 0) fail("a page must live where vocs publishes it", offenders)
  else {
    pass(
      `no page sits in one of the ${movedTrees.length} moved trees, and ${deferredRoutes.length} deferred route is still waiting for its page`
    )
  }
}

// -----------------------------------------------------------------------------
// 14. Migration guide anchors
// -----------------------------------------------------------------------------

{
  // Every refusal the CLI prints ends in a link to one anchor of the migration
  // guide. An anchor with no heading is worse than a dead link: the page loads,
  // the reader lands at the top, and the sentence that was supposed to explain
  // the removal is not there. The anchors are read out of the sentences
  // themselves, so the guide is checked against what an operator is holding.
  const unsupported = await import("../packages/cli/src/Unsupported.ts")
  const sentences = [
    ...unsupported.removedVerbs.map((verb) => unsupported.verbError(verb).message),
    ...unsupported.removedFlags.map((flag) => unsupported.flagMessage(flag)),
    unsupported.reservedFlowError("run", "system/plan").message
  ]
  const anchors = anchorsLinkedTo(unsupported.migrationUrl, sentences)
  const guide = allPages.find((page) => page.route === "/migration/1.0")
  const missing = guide === undefined
    ? ["docs/pages/migration/1.0.md: the migration guide is not published"]
    : missingAnchors(guide.body, anchors).map((anchor) => `docs/pages/migration/1.0.md: #${anchor}`)
  if (missing.length > 0) fail("a removal message links to an anchor the migration guide has no heading for", missing)
  else pass(`all ${anchors.size} anchors the removal messages link to have a heading in the migration guide`)
}

// -----------------------------------------------------------------------------
// 15. The browser contract's prose
// -----------------------------------------------------------------------------

{
  // `pnpm run browser` executes two lists. The support page reproduces them as
  // tables and two other pages state their size, and none of that is checked by
  // bundling anything: the gate stays green while the page names the wrong
  // entry points. Both halves are read back from the same declaration here.
  const offenders = []
  const support = allPages.find((candidate) => candidate.route === "/architecture/browser-support")
  const compare = (heading, declared) => {
    if (support === undefined) {
      offenders.push("docs/pages/architecture/browser-support.md: the page is not published")
      return
    }
    const listed = new Set(tableUnder(support.body, heading).flatMap((row) => codeSpans(row[0])))
    for (const name of declared) {
      if (!listed.has(name)) offenders.push(`browser-support.md: ${heading} omits ${name}`)
    }
    for (const name of listed) {
      if (!declared.includes(name)) offenders.push(`browser-support.md: ${heading} lists ${name}, which the gate does not`)
    }
  }
  const browser = browserEntryNames()
  compare("## Browser entry points", browser)
  compare("## Node entry points", nodeEntryNames())
  for (const path of countCitingDocuments()) {
    for (const cited of citedBrowserCounts(readFileSync(join(repoRoot, path), "utf8"))) {
      if (cited !== browser.length) {
        offenders.push(`${path}: states ${cited} browser entry points, the gate bundles ${browser.length}`)
      }
    }
  }
  if (offenders.length > 0) fail("the browser prose disagrees with the contract the gate executes", offenders)
  else pass(`the browser tables and counts match the ${browser.length} entry points the gate bundles`)
}

process.exit(failed ? 1 : 0)
