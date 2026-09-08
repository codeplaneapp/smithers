import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { docsText } from "./docs-text.mjs"

test("Dispatcher documents the registration refusal and supported alternatives until registration crosses the relay", () => {
  const source = readFileSync(new URL("../src/content/docs/docs/app/dispatcher.mdx", import.meta.url), "utf8")
  assert.doesNotMatch(source, /\b(?:trigger|registration) form\b/i)
  assert.ok(source.includes("A rule cannot be registered on owner/repo from here yet: declare it in .smithers/FACTORY.ts, or register it with the smthrs CLI on the box."))
  assert.ok(source.includes('"schedule:0 9 * * 1-5"'))
  assert.ok(source.includes('smthrs triggers register nightly-lint --flow lint --cron "0 9 * * 1-5"'))
  assert.ok(source.includes("/docs/guides/triggers/"))
})

test("sync follower guide requires explicit compaction recovery and a restored cursor", () => {
  const guide = readFileSync(new URL("../src/content/docs/docs/guides/sync-followers.mdx", import.meta.url), "utf8")
  assert.doesNotMatch(guide, /The default hook logs the skipped range and continues/)
  assert.doesNotMatch(guide, /`Sync.Read` and `Sync.Subscribe` are the whole wire/)
  assert.match(guide, /fails closed/)
  assert.match(guide, /`compacted`/)
  assert.match(guide, /`invalid_request`/)
  assert.match(guide, /`Sync.Snapshot`/)
  assert.match(guide, /onResync:.*Effect\.gen/s)
  assert.match(guide, /afterSeq: snapshot\.seq/)
  assert.match(guide, /yield\* restoreReadModel\(snapshot, cursor\)\s+return cursor/)
})

test("sync concept frame ceiling agrees with the protocol default", () => {
  const concept = readFileSync(new URL("../src/content/docs/docs/concepts/sync.mdx", import.meta.url), "utf8")
  const protocol = readFileSync(new URL("../../../packages/smithers/flows/sync/src/SyncProtocol.ts", import.meta.url), "utf8")
  const defaultMiB = /defaultMaxFrameBytes = (\d+) \* 1024 \* 1024/.exec(protocol)
  assert.ok(defaultMiB, "protocol declares its frame default in MiB")
  const documentedMiB = /The default frame ceiling is (\d+) MiB/.exec(concept)
  assert.ok(documentedMiB, "concept documents the frame default")
  assert.equal(documentedMiB[1], defaultMiB[1])
})

test("preserves example imports while removing MDX imports", () => {
  const source = 'import { Code } from "@astrojs/starlight/components"\n\n```ts title="main.ts"\nimport { Action } from "@smthrs/flow"\nconst value = 1\n```'
  const result = docsText(source)
  assert.ok(!result.includes("starlight/components"))
  assert.ok(result.includes('import { Action } from "@smthrs/flow"'))
})

test("exports navigation and diagram text", () => {
  const result = docsText('<CardGrid>\n<LinkCard title="Run" href="/docs/run/" description="Launch a flow." />\n</CardGrid>\n<DocsDiagram title="Resume" caption="Reuse the committed outcome." rows={[]} />')
  assert.match(result, /\[Run\]\(\/docs\/run\/\)/)
  assert.match(result, /Reuse the committed outcome/)
  assert.ok(!result.includes("<"))
})

test("exports app screenshots with their captions for text readers", () => {
  const result = docsText('<AppScreenshot src="/images/app/home.png" alt="The repository home." caption="Choose a featured flow." />')
  assert.equal(result, '![The repository home.](/images/app/home.png)\n\nChoose a featured flow.')
})

test("expands imported help and version fields", () => {
  const result = docsText('<Code lang="text" code={help} />\nNode {versions.node}', { raw: { help: "Usage: smthrs flow list   \n" }, versions: { node: "22.19.0" } })
  assert.match(result, /```text\nUsage: smthrs flow list\n```/)
  assert.match(result, /Node 22\.19\.0/)
})

test("exports literal install commands and refuses unknown code bindings", () => {
  assert.match(docsText('<Code lang="bash" code={`pnpm add package`} />'), /pnpm add package/)
  assert.throws(() => docsText('<Code code={missing} />'), /Cannot export/)
})

test("removes wrapper indentation without changing fenced source", () => {
  const result = docsText('<Tabs>\n  <TabItem label="Node">\n```ts\nconst content = `kept  `\n```\n  </TabItem>\n</Tabs>')
  assert.ok(!/^ +$/m.test(result))
  assert.ok(result.includes('`kept  `'))
})
