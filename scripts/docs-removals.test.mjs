import assert from "node:assert/strict"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { removalMessage, repoRoot } from "./docs-contract.mjs"
import { runCli } from "./docs-help.mjs"

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

test("every removed verb really prints its documented sentence", { concurrency: 8 }, async () => {
  // The table is data; this proves the data reaches a terminal, for every row
  // rather than for one. A verb the guide documents as removed while the binary
  // answers it with the root help is the defect this catches: the table stays
  // green because the table is not the binary. The spawns run eight at a time
  // so sixty-seven of them cost seconds, not a minute.
  const documented = documentedMessages()
  const names = Unsupported.removedVerbs.map((verb) => verb.name)
  const printed = new Map()
  const queue = [...names]
  const workers = Array.from({ length: 8 }, async () => {
    for (let verb = queue.shift(); verb !== undefined; verb = queue.shift()) {
      printed.set(verb, await runCli([verb]))
    }
  })
  await Promise.all(workers)

  const offenders = []
  for (const verb of names) {
    const result = printed.get(verb)
    // A verb that never returns is the failure this bound exists for: it is
    // also bound as a live command somewhere, so the removal table and the
    // command table disagree about the same name.
    if (result?.exited !== true) {
      offenders.push(`${verb}: did not exit`)
      continue
    }
    const expected = documented.get(verb)
    if (result.text === expected) continue
    offenders.push(
      `${verb}: printed ${JSON.stringify(result.text.split("\n")[0] ?? "")}, guide says ${JSON.stringify(expected)}`
    )
  }
  assert.deepEqual(offenders, [])
})

test("a verb that never exits is reported, not waited out", async () => {
  // The bound is the whole point, so it is proved against a process that does
  // exactly what a verb bound to a server does: hold the event loop open.
  const fixture = join(tmpdir(), `docs-removals-never-exits-${process.pid}.mjs`)
  writeFileSync(fixture, "setInterval(() => {}, 1_000)\n")
  try {
    const started = Date.now()
    const result = await runCli(["gateway"], { entry: fixture, timeoutMs: 1_000 })
    assert.equal(result.exited, false)
    assert.ok(Date.now() - started < 10_000, `waited ${Date.now() - started}ms`)
  } finally {
    rmSync(fixture, { force: true })
  }
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
