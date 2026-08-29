#!/usr/bin/env node
/**
 * The documentation gate.
 *
 * Twelve checks over the vocs page tree, each one a claim the documentation
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
 *
 * The two normalizers run in `--check` mode first, so their rules stay one
 * implementation rather than a detector and a fixer that can disagree.
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
  removedCommands,
  repoRoot
} from "./docs-contract.mjs"
import { assets, isHistorical, pages } from "./docs-pages.mjs"
import { sidebarRoutes } from "./docs-sidebar.mjs"
import { routePlan } from "./docs-routes.mjs"
import { cliCatalog } from "./docs-help.mjs"

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
  const offenders = []
  for (const page of allPages) {
    for (const match of page.body.matchAll(/\]\((\/[A-Za-z0-9._/-]*)(#[A-Za-z0-9._-]*)?\)/g)) {
      const target = match[1]
      if (routes.has(target) || routes.has(target.replace(/\/$/, ""))) continue
      if (servedAssets.has(target)) continue
      offenders.push(`${page.path}: ${target}`)
    }
  }
  if (offenders.length > 0) fail("internal links must resolve to a page or a served asset", offenders)
  else pass("every internal link resolves")
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
  const jsxApis = [
    "jsxImportSource",
    "smthrs/jsx-runtime",
    "smthrs/jsx-dev-runtime",
    "createSmithers",
    "SmithersCtx",
    "renderFrame",
    "<Workflow>",
    "<Task>",
    "<Sequence>",
    "<Parallel>",
    "<Ralph>",
    "<Subflow>",
    "<Worktree>",
    "<Saga>"
  ]
  const oldPackages = [
    "smithers-orchestrator",
    "@smthrs/graph",
    "@smthrs/scheduler",
    "@smthrs/driver",
    "@smthrs/components",
    "@smthrs/react-reconciler",
    "@smthrs/gateway-react",
    "@smthrs/gateway-ui",
    "@smthrs/gateway-client",
    "@smthrs/ui-core",
    "@smthrs/tui",
    "@smthrs/protocol",
    "@smthrs/control-plane",
    "@smthrs/db",
    "@smthrs/server",
    "@smthrs/devtools",
    "@smthrs/xstate"
  ]
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
    for (const api of jsxApis) {
      if (page.body.includes(api)) offenders.push(`${page.path}: ${api}`)
    }
    for (const name of oldPackages) {
      if (new RegExp(`${name.replace("/", "\\/")}(?![a-z-])`).test(page.body)) offenders.push(`${page.path}: ${name}`)
    }
    for (const [name] of removed) {
      if (available.has(name)) continue
      if (new RegExp(`\`smithers ${name}(?![a-z-])`).test(page.body)) offenders.push(`${page.path}: smithers ${name}`)
    }
  }
  if (offenders.length > 0) {
    fail("only the migration guide may name a removed verb, a JSX API, or a 0.x package", offenders)
  } else {
    pass("no page outside the migration guide names a removed surface")
  }
}

// -----------------------------------------------------------------------------
// 8 and 9. Generated pages, the two normalizers, and the route plan
// -----------------------------------------------------------------------------

for (const [title, argv] of [
  ["the CLI invocations are the 1.0 command", ["scripts/normalize-bunx.ts", "--check"]],
  ["the argument placeholders are normalized", ["scripts/normalize-placeholders.ts", "--check"]],
  ["the generated pages are current", ["scripts/generate-docs-pages.mjs", "--check"]]
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
    if (link.startsWith("http") || routes.has(link)) continue
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

process.exit(failed ? 1 : 0)
