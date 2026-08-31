import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import {
  availableCommands,
  citedPackageCounts,
  codeSpans,
  countCitingDocuments,
  commandName,
  namedRemovedSurfaces,
  partitionRemovals,
  compatibilityPromise,
  contractPath,
  promiseHolders,
  exclusions,
  publishedPackageCount,
  publishedPackages,
  repoRoot,
  releaseNotes,
  removedCommands,
  removedFlags,
  removedForms,
  removalMessage,
  removedJsxSurfaces,
  removedRpcs,
  removedZeroXPackages,
  runtimes,
  shippedCommands,
  supportedRunControl,
  survivingAliases,
  tableCells,
  tableUnder,
  unsupportedFeatures
} from "./docs-contract.mjs"

test("splits a table row on unescaped pipes only", () => {
  assert.deepEqual(tableCells("| a | b\\|c | d |"), ["a", "b\\|c", "d"])
})

test("reads the code spans of a cell in order", () => {
  assert.deepEqual(codeSpans("`ls` and `ps [--flow <id>]`"), ["ls", "ps [--flow <id>]"])
})

test("takes the command name from a signature and ignores a bare flag", () => {
  assert.equal(commandName("ps [--flow <id>]"), "ps")
  assert.equal(commandName("smithers --mcp [--surface raw]"), undefined)
  assert.equal(commandName("--version"), undefined)
})

test("refuses a heading the contract does not have", () => {
  assert.throws(() => tableUnder("nothing here", "### 9.9 Imaginary"), /heading not found/)
})

test("reads the commands section 4.1 ships, with every spelling of run", () => {
  const shipped = shippedCommands()
  assert.ok(shipped.has("plan"))
  assert.ok(shipped.has("serve"))
  assert.ok(shipped.has("gc"))
  const run = shipped.get("run")
  assert.ok(run.forms.some((form) => form.startsWith("run --resume")))
})

test("keeps a section 4.1 command out of the removed set", () => {
  const removed = removedCommands()
  for (const name of shippedCommands().keys()) assert.ok(!removed.has(name), `${name} is both shipped and removed`)
})

test("treats a surviving alias as available rather than removed", () => {
  const aliases = survivingAliases()
  assert.deepEqual([...aliases].sort(), ["events", "gateway", "inspect", "resume", "why", "workflow list"])
  const removed = removedCommands()
  assert.ok(!removed.has("gateway"), "gateway is an alias of serve, not a removed verb")
  assert.ok(availableCommands().has("inspect"))
})

test("sorts a removal row whose parent the contract keeps out of the bare verbs", () => {
  // The tip's table names this row `gateway` and qualifies it with the two
  // subcommands that went. Read as a bare removal it sends a proof at
  // `smithers gateway`, which is the surviving `serve` alias and never exits.
  const table = [
    { name: "gateway", reason: "replaced by `smithers serve`", subcommands: ["status", "stop"] },
    { name: "hijack", reason: "not available" }
  ]
  const { bare, contradictions, parentSurvives } = partitionRemovals(table)
  assert.deepEqual(bare.map((verb) => verb.name), ["hijack"])
  assert.deepEqual(parentSurvives.map((verb) => verb.name), ["gateway"])
  assert.deepEqual(contradictions, [])
})

test("reports a row that removes a shipped name outright as a contradiction", () => {
  // No subcommands to qualify it: section 4.1 ships `serve` and this table
  // removes it, so the command tree binds one meaning and no spawn can prove
  // the other. It is reported by name rather than run.
  const { bare, contradictions, parentSurvives } = partitionRemovals([{ name: "serve", reason: "removed" }])
  assert.deepEqual(contradictions.map((verb) => verb.name), ["serve"])
  assert.deepEqual(bare, [])
  assert.deepEqual(parentSurvives, [])
})

test("records a removed subcommand of a surviving verb as a form", () => {
  const forms = removedForms()
  assert.ok(forms.some((form) => form.form === "gateway status|stop"))
})

test("reads the removed verbs and the flags that go with them", () => {
  const removed = removedCommands()
  assert.ok(removed.has("hijack"))
  assert.ok(removed.has("replay"))
  assert.ok(removed.size > 50, `expected the whole 0.x verb set, got ${removed.size}`)
  const flags = removedFlags()
  assert.ok(flags.some((flag) => flag.parent === "steer" && flag.flag === "--takeover"))
})

test("prints the removal message the contract specifies", () => {
  const message = removalMessage("hijack", "not available")
  assert.equal(message, "smithers hijack was removed in 1.0.0-rc.0: not available. See https://smithers.sh/migration/1.0#hijack")
})

test("reads the Pause RPC from section 5.2, not from the verb table", () => {
  const rpcs = removedRpcs()
  assert.deepEqual([...rpcs], ["Pause"])
  assert.ok(removedCommands().has("list"), "the 0.x `list` verb is removed")
  assert.ok(!rpcs.has("List"), "the List RPC is live even though the list verb is gone")
})

test("quotes the compatibility promise verbatim from section 11", () => {
  const promise = compatibilityPromise()
  assert.match(promise, /^Smithers 1\.0\.0-rc\.0 is a source migration/)
  assert.match(promise, /no `smthrs\/jsx-runtime`/)
})

test("carries the promise verbatim everywhere section 11 names", () => {
  const promise = compatibilityPromise()
  for (const path of promiseHolders) {
    assert.ok(
      readFileSync(join(repoRoot, path), "utf8").includes(promise),
      `${path} does not quote section 11 verbatim`
    )
  }
})

test("pairs every release note with the exclusions that cite it", () => {
  const notes = releaseNotes()
  const titles = new Set(notes.map((note) => note.title))
  assert.ok(titles.has("Databases"))
  assert.ok(titles.has("Hijack"))
  for (const exclusion of exclusions()) {
    for (const title of exclusion.titles) {
      assert.ok(titles.has(title), `${exclusion.id} cites a section 7 note that does not exist: ${title}`)
    }
  }
})

test("reads the runtime, package, and run-control tables", () => {
  assert.ok(runtimes().some((row) => row.runtime === "Node.js"))
  assert.ok(publishedPackages().some((row) => row.name === "@smthrs/cli"))
  assert.ok(supportedRunControl().some((row) => row.feature === "Cancel"))
  assert.ok(unsupportedFeatures().some((row) => row.feature === "Hijack"))
})

test("the section 3.1 heading counts the rows it heads", () => {
  // The heading spells the number out. When a package joins the release the
  // heading and the table move together or the contract contradicts itself,
  // and every page that cites the count inherits the contradiction.
  assert.equal(publishedPackageCount(), publishedPackages().length)
})

test("a section 3.1 count that disagrees with its table is rejected", () => {
  const source = readFileSync(contractPath, "utf8").replace(
    /### 3.1 Published at 1.0.0-rc.0 \(\d+ names\)/,
    "### 3.1 Published at 1.0.0-rc.0 (2 names)"
  )
  assert.throws(() => publishedPackages(source), /heading says 2 .* rows/)
})

test("the count survives a package joining the release", () => {
  const source = readFileSync(contractPath, "utf8")
  const declared = publishedPackageCount(source)
  const grown = source
    .replace(
      `### 3.1 Published at 1.0.0-rc.0 (${declared} names)`,
      `### 3.1 Published at 1.0.0-rc.0 (${declared + 1} names)`
    )
    .replace("| `@smthrs/model` |", "| `@smthrs/new` | A new one. | no claim |\n| `@smthrs/model` |")
  assert.equal(publishedPackageCount(grown), declared + 1)
  assert.equal(publishedPackages(grown).length, declared + 1)
})

test("finds both spellings a document uses to cite the published set", () => {
  const body = [
    "checks that set against the 39 names frozen in [rc-contract.md section 3.1](x)",
    "Scope: the 41 packages `node scripts/pack-release.mjs --names` prints, every",
    "| Published packages | 42 | enforced somewhere |",
    "39 packages of prose that cite nothing"
  ].join("\n")
  assert.deepEqual(citedPackageCounts(body), [39, 41, 42])
})

test("finds the count the contract cites in its own cross-references", () => {
  // Section 9 cited "the 39 names in §3.1" while section 3.1 froze 40, and
  // every gate stayed green: the citation reader knew "names frozen in" and
  // not the shorter spelling the contract uses to point at itself.
  const body = [
    "with a check that the non-private set equals the 39 names in §3.1 (update the roster test)",
    "the 41 names in section 3.1 are what the smoke installs",
    "39 packages of prose that cite nothing"
  ].join("\n")
  assert.deepEqual(citedPackageCounts(body), [39, 41])
})

test("finds no citation in a document that states no count", () => {
  assert.deepEqual(citedPackageCounts("The release publishes several packages."), [])
})

test("every document that cites the published set agrees with the contract", () => {
  const declared = publishedPackageCount()
  for (const path of countCitingDocuments()) {
    for (const cited of citedPackageCounts(readFileSync(join(repoRoot, path), "utf8"))) {
      assert.equal(cited, declared, `${path} cites ${cited} published packages and the contract freezes ${declared}`)
    }
  }
})

// The section 11 promise names thirteen JSX components. Check 7 of
// `check-docs.mjs` is what enforces the promise's "no page outside the
// migration guide names one" half, so the two lists have to be one list: a
// component the promise retires and the check does not know about is a
// component any page may keep advertising.
test("every JSX component the compatibility promise retires is a refused surface", () => {
  const components = [...compatibilityPromise().matchAll(/<([A-Z][A-Za-z]*)>/g)].map((match) => match[0])
  assert.ok(components.length >= 13, `the promise names ${components.length} components`)
  const surfaces = removedJsxSurfaces()
  assert.deepEqual(components.filter((component) => !surfaces.includes(component)), [])
  // `<Kanban>` shipped in the 0.x board pack, which the promise retires as
  // part of the JSX API rather than by name.
  assert.ok(surfaces.includes("<Kanban>"))
})

test("a page that names a retired JSX component names a removed surface", () => {
  const body = "The old `<Kanban>` component wrapped its columns in a `<Loop>` whose `maxIterations` defaulted to five."
  assert.deepEqual(namedRemovedSurfaces(body), ["<Loop>", "<Kanban>"])
})

test("a removed surface is a 0.x package or a verb in its command form, and nothing else", () => {
  const surfaces = { jsx: [], packages: removedZeroXPackages, commands: ["rewind"] }
  assert.deepEqual(namedRemovedSurfaces("a rewind of the plan under @smthrs/engine", surfaces), [])
  assert.deepEqual(namedRemovedSurfaces("run `smithers rewind` under @smthrs/graph", surfaces), [
    "@smthrs/graph",
    "smithers rewind"
  ])
})
