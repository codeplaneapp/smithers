import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { removalMessage, repoRoot } from "./docs-contract.mjs"
import { cliEntry } from "./docs-help.mjs"

const Unsupported = await import(pathToFileURL(join(repoRoot, "packages", "cli", "src", "Unsupported.ts")).href)
const guide = readFileSync(join(repoRoot, "docs", "pages", "migration", "1.0.md"), "utf8")

/** The fenced block under each `### <verb>` heading of the removed-command section. */
const documentedMessages = () => {
  const blocks = new Map()
  const pattern = /^### (\S+)\n\n```\n([^\n]+)\n```$/gm
  for (const match of guide.matchAll(pattern)) blocks.set(match[1], match[2])
  return blocks
}

test("the guide prints the sentence the binary prints, for every removed verb", () => {
  // `Unsupported.ts` and `rc-contract.md` are two hand-maintained copies of the
  // same table. Nothing but this makes them agree, and an operator who pastes
  // the message from their terminal into search has to land on the anchor it
  // names.
  const documented = documentedMessages()
  const offenders = []
  for (const verb of Unsupported.removedVerbs) {
    // `verbError` anchors on the verb's own name; `group` is the display
    // heading the table is organized under, not a URL fragment.
    const expected = Unsupported.message(verb.name, verb.reason, verb.name)
    const actual = documented.get(verb.name)
    if (actual === undefined) offenders.push(`${verb.name}: no fenced message in the guide`)
    else if (actual !== expected) offenders.push(`${verb.name}:\n    guide:  ${actual}\n    binary: ${expected}`)
  }
  assert.deepEqual(offenders, [])
})

test("the guide documents no verb the binary does not refuse", () => {
  const known = new Set(Unsupported.removedVerbs.map((verb) => verb.name))
  const extra = [...documentedMessages().keys()].filter((name) => !known.has(name))
  assert.deepEqual(extra, [])
})

test("a removed verb really prints its documented sentence", () => {
  // The table is data; this proves the data reaches a terminal. One spawn, not
  // sixty-seven: the wiring is shared, only the rows differ.
  const result = spawnSync(process.execPath, [cliEntry, "hijack"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }
  })
  const printed = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  assert.equal(printed, documentedMessages().get("hijack"))
})

test("every refusal obeys the sentence shape section 4.2 mandates", () => {
  // The contract fixes the template; `Unsupported.ts` fills it in. Comparing
  // the rendered halves keeps the binary from inventing its own phrasing while
  // leaving it free to word the reason.
  const offenders = []
  for (const verb of Unsupported.removedVerbs) {
    const template = removalMessage(verb.name, verb.reason)
    const actual = Unsupported.message(verb.name, verb.reason, verb.name)
    if (actual !== template) offenders.push(`${verb.name}:\n    contract: ${template}\n    binary:   ${actual}`)
  }
  assert.deepEqual(offenders, [])
})
