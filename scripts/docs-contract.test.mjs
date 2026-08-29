import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import {
  availableCommands,
  codeSpans,
  commandName,
  compatibilityPromise,
  promiseHolders,
  exclusions,
  publishedPackages,
  repoRoot,
  releaseNotes,
  removedCommands,
  removedFlags,
  removedForms,
  removalMessage,
  removedRpcs,
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
  assert.equal(publishedPackages().length, 39)
  assert.ok(supportedRunControl().some((row) => row.feature === "Cancel"))
  assert.ok(unsupportedFeatures().some((row) => row.feature === "Hijack"))
})
