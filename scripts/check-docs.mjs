#!/usr/bin/env node
/**
 * The documentation gate.
 *
 * Checks over the vocs page tree, each one a claim the documentation
 * makes that can be verified against something else in the repository:
 *
 *   1. house style: no em-dash anywhere in the prose
 *   2. every page carries a frontmatter description and one H1
 *   3. every internal link resolves to a page route or a served asset
 *   4. every documented import resolves to a package this workspace publishes
 *   5. nothing shipped is still described as coming soon
 *   6. the CLI catalog matches what the binary's `--help` prints
 *   7. no page outside the upgrade guide names a removed verb, a JSX API, or
 *      a Smithers 0.x package
 *   8. the generated pages are current
 *   9. every page is reachable from the sidebar, and every sidebar link resolves
 *  10. every stated package count agrees with the live publication roster
 *  11. every anchor a removal message sends an operator to has a heading in
 *      the upgrade guide
 *  12. browser-support prose matches the list `pnpm run browser` executes
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
  citedPackageCounts,
  codeSpans,
  countCitingDocuments,
  namedRemovedSurfaces,
  removedJsxSurfaces,
  removedZeroXPackages,
  repoRoot,
  tableUnder
} from "./docs-shared.mjs"
import { anchorsLinkedTo, deadLinks, missingAnchors } from "./docs-links.mjs"
import { assets, isHistorical, pages } from "./docs-pages.mjs"
import { sidebarRoutes } from "./docs-sidebar.mjs"
import { cliCatalog } from "./docs-help.mjs"
import { browserEntryNames, citedBrowserCounts, nodeEntryNames } from "./browser-contract.mjs"
import { publishedPackages } from "./pack-release.mjs"

const Unsupported = await import("../packages/cli/src/Unsupported.ts")

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
  const { checked, dead } = deadLinks(allPages, { assets: servedAssets, deferred: new Set(), routes })
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
  // These claims have all shipped and must not regress to tentative wording.
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
  const removed = new Map(Unsupported.removedVerbs.map((entry) => [entry.name, entry]))
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
        ? `${name} is removed but has no anchor in the upgrade guide`
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
  const removed = new Map(Unsupported.removedVerbs.map((entry) => [entry.name, entry]))
  const available = new Set([
    ...allPages.filter((page) => page.route.startsWith("/cli/")).map((page) => page.route.slice(5)),
    "events",
    "gateway",
    "inspect",
    "resume",
    "why",
    "workflow"
  ])
  const surfaces = {
    jsx: removedJsxSurfaces,
    packages: removedZeroXPackages,
    commands: [...removed.keys()].filter((name) => !available.has(name))
  }
  const offenders = []
  for (const page of allPages) {
    // These exemptions name removed surfaces in order to explain them.
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
// 8. Generated pages and normalizers
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

// -----------------------------------------------------------------------------
// 9. Sidebar reachability
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
    if (link.startsWith("http") || routes.has(link)) continue
    offenders.push(`the sidebar links ${link} and no page answers it`)
  }
  if (offenders.length > 0) fail("the sidebar must reach every page", offenders)
  else pass(`the sidebar reaches all ${links.size} routes the site publishes`)
}

// -----------------------------------------------------------------------------
// 10. The size of the published set
// -----------------------------------------------------------------------------

{
  const declared = publishedPackages.length
  const offenders = []
  for (const path of countCitingDocuments()) {
    for (const cited of citedPackageCounts(readFileSync(join(repoRoot, path), "utf8"))) {
      if (cited !== declared) offenders.push(`${path}: states ${cited}, the publication roster has ${declared}`)
    }
  }
  if (offenders.length > 0) fail("a document states the wrong number of published packages", offenders)
  else pass(`every stated package count matches the ${declared} published packages`)
}

// -----------------------------------------------------------------------------
// 11. Upgrade-guide anchors
// -----------------------------------------------------------------------------

{
  // Every refusal the CLI prints ends in a link to one anchor of the migration
  // guide. An anchor with no heading is worse than a dead link: the page loads,
  // the reader lands at the top, and the sentence that was supposed to explain
  // the removal is not there. The anchors are read out of the sentences
  // themselves, so the guide is checked against what an operator is holding.
  const sentences = [
    ...Unsupported.removedVerbs.map((verb) => Unsupported.verbError(verb).message),
    ...Unsupported.removedFlags.map((flag) => Unsupported.flagMessage(flag)),
    Unsupported.reservedFlowError("run", "system/plan").message
  ]
  const anchors = anchorsLinkedTo(Unsupported.migrationUrl, sentences)
  const guide = allPages.find((page) => page.route === "/migration/1.0")
  const missing = guide === undefined
    ? ["docs/pages/migration/1.0.md: the migration guide is not published"]
    : missingAnchors(guide.body, anchors).map((anchor) => `docs/pages/migration/1.0.md: #${anchor}`)
  if (missing.length > 0) fail("a removal message links to an anchor the migration guide has no heading for", missing)
  else pass(`all ${anchors.size} anchors the removal messages link to have a heading in the migration guide`)
}

// -----------------------------------------------------------------------------
// 12. Browser-support prose
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
  if (offenders.length > 0) fail("the browser prose disagrees with the list the gate executes", offenders)
  else pass(`the browser tables and counts match the ${browser.length} entry points the gate bundles`)
}

process.exit(failed ? 1 : 0)
