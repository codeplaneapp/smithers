import assert from "node:assert/strict"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { partitionRemovals, removalMessage, repoRoot } from "./docs-contract.mjs"
import { runCli } from "./docs-help.mjs"

const Unsupported = await import(pathToFileURL(join(repoRoot, "packages", "cli", "src", "Unsupported.ts")).href)
const guide = readFileSync(join(repoRoot, "docs", "pages", "migration", "1.0.md"), "utf8")

/** The three shapes of removal row, read once: bare verbs, surviving parents, contradictions. */
const { bare, contradictions, parentSurvives } = partitionRemovals(Unsupported.removedVerbs)

/** The fenced block under each `### <verb>` heading of the removed-command section. */
const documentedMessages = () => {
  const blocks = new Map()
  const pattern = /^### (\S+)\n\n```\n([^\n]+)\n```$/gm
  for (const match of guide.matchAll(pattern)) blocks.set(match[1], match[2])
  return blocks
}

/** Every sentence the guide publishes inside a code fence, however the block is introduced. */
const publishedSentences = () =>
  new Set([...guide.matchAll(/^```\n([\s\S]*?)\n```$/gm)].flatMap((match) => match[1].split("\n")))

/** The `### <name>` headings a `#<name>` link in a refusal resolves to. */
const guideAnchors = () => new Set([...guide.matchAll(/^###\s+(\S+)\s*$/gm)].map((match) => match[1]))

/** The line a CLI source names `name` on, so a failure cites a file a reader can open. */
const sourceLine = (relative, name) => {
  const lines = readFileSync(join(repoRoot, relative), "utf8").split("\n")
  const index = lines.findIndex((line) => new RegExp(`"${name}(?:"| )`).test(line))
  return index < 0 ? relative : `${relative}:${index + 1}`
}

test("no removal row removes a name the contract ships outright", () => {
  // The cause the spawns below cannot report. A name that section 4.1 ships and
  // section 4.2 removes has two meanings, the command tree binds one of them,
  // and running it proves whichever it happened to bind: a removed verb bound
  // to a server answers a proof with a fifteen-second kill rather than with the
  // contradiction. A row that qualifies itself with subcommands is not this
  // shape; it is `parentSurvives`, proved by form below. Fixing one of these is
  // a choice between the alias and the removal, and the choice belongs to
  // whoever owns the CLI source, so the failure names both files.
  assert.deepEqual(
    contradictions.map((verb) =>
      `${verb.name}: rc-contract section 4.1 ships it (${sourceLine("packages/cli/src/Verb.ts", verb.name)})` +
      ` and the removal table removes it with no subcommands (${sourceLine("packages/cli/src/Unsupported.ts", verb.name)})`
    ),
    []
  )
})

test("the guide prints the sentence the binary prints, for every removed verb", () => {
  // `Unsupported.ts` and `rc-contract.md` are two hand-maintained copies of the
  // same table. Nothing but this makes them agree, and an operator who pastes
  // the message from their terminal into search has to land on the anchor it
  // names.
  const documented = documentedMessages()
  const offenders = []
  for (const verb of bare) {
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

test("every removed verb really prints its documented sentence", { concurrency: 8, timeout: 120_000 }, async (t) => {
  // The table is data; this proves the data reaches a terminal, for every row
  // rather than for one. A verb the guide documents as removed while the binary
  // answers it with the root help is the defect this catches: the table stays
  // green because the table is not the binary. The spawns run eight at a time
  // so sixty-seven of them cost seconds, not a minute.
  const documented = documentedMessages()
  const names = bare.map((verb) => verb.name)
  const printed = new Map()
  const queue = [...names]
  const workers = Array.from({ length: 8 }, async () => {
    for (let verb = queue.shift(); verb !== undefined; verb = queue.shift()) {
      printed.set(verb, await runCli([verb], { signal: t.signal }))
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

test("a surviving parent's removed forms are documented and refuse", { concurrency: 8, timeout: 120_000 }, async (t) => {
  // `gateway` and `workflow` reach this proof, and the bare proof above never
  // does: section 4.1 keeps `smithers gateway` and `smithers workflow list`, so
  // the removed unit is the form. Spawning the parent would start a server and
  // wait it out; spawning the form is the assertion that matters, because a
  // subcommand registered under a parent that runs is exactly the registration
  // an argument parser drops back to the root help.
  const published = publishedSentences()
  const anchors = guideAnchors()
  const offenders = []
  const forms = []
  for (const verb of parentSurvives) {
    // Every one of these refusals links to `#<parent>`, and the parent is not a
    // removed verb, so nothing else in the guide mints that heading.
    if (!anchors.has(verb.name)) {
      offenders.push(`${verb.name}: its refusals link to #${verb.name} and the guide has no "### ${verb.name}" heading`)
    }
    for (const subcommand of verb.subcommands) {
      const expected = Unsupported.message(`${verb.name} ${subcommand}`, verb.reason, verb.name)
      if (!published.has(expected)) offenders.push(`${verb.name} ${subcommand}: the guide publishes no fenced refusal`)
      forms.push({ args: [verb.name, subcommand], expected, name: `${verb.name} ${subcommand}` })
    }
  }

  const printed = new Map()
  const queue = [...forms]
  const workers = Array.from({ length: 8 }, async () => {
    for (let form = queue.shift(); form !== undefined; form = queue.shift()) {
      printed.set(form.name, await runCli(form.args, { signal: t.signal }))
    }
  })
  await Promise.all(workers)

  for (const form of forms) {
    const result = printed.get(form.name)
    if (result?.exited !== true) {
      offenders.push(`${form.name}: did not exit`)
      continue
    }
    if (result.text === form.expected) continue
    offenders.push(
      `${form.name}: printed ${JSON.stringify(result.text.split("\n")[0] ?? "")}, expected ${
        JSON.stringify(form.expected)
      }`
    )
  }
  assert.deepEqual(offenders, [])
})

test("a verb that never exits is reported, not waited out", { timeout: 10_000 }, async (t) => {
  // The bound is the whole point, so it is proved against a process that does
  // exactly what a verb bound to a server does: hold the event loop open. The
  // `timeout` option is the backstop: without it, a `runCli` that lost its own
  // bound would leave this test waiting forever, and a proof that hangs when
  // the thing it proves regresses is a hung CI job rather than a failure.
  const fixture = join(tmpdir(), `docs-removals-never-exits-${process.pid}.mjs`)
  writeFileSync(fixture, "setInterval(() => {}, 1_000)\n")
  try {
    const started = Date.now()
    const result = await runCli(["gateway"], { entry: fixture, timeoutMs: 1_000, signal: t.signal })
    assert.equal(result.exited, false)
    // Five seconds of slack over a one-second bound: enough for a loaded
    // machine, short enough that the assertion fires before the backstop does.
    assert.ok(Date.now() - started < 5_000, `waited ${Date.now() - started}ms`)
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
