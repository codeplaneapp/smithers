import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Action, Interpreter } from "@smthrs/flow"
import { Capability } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import { Effect, Layer, Stream } from "effect"
import { IncrementalWiki, policySources, reuseLayers } from "../wiki/reuse.ts"
import { actionLayers, agentLayers } from "../wiki/runtime.ts"
import { Wiki } from "../wiki/workflow.ts"
import type { Input } from "../wiki/schema.ts"

// Real native engine, journal, attempt store, AgentAction and QuickJS. Only the
// model provider is scripted; every recorded receipt is produced by the flow.
test("incremental wiki reuses exact terminal receipts after restart and reviews changed inputs", { timeout: 300_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-wiki-reuse-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url))
  for (const file of policySources) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), await readFile(join(sourceRoot, file)))
  }
  await writeFile(join(root, "answer.ts"), "export const answer = 42\n")
  for (const id of ["first", "second"]) await writeFile(join(root, `${id}.md`), `# ${id}\n\nThe answer is 42.\n`)
  const pages: Input["pages"] = ["first", "second"].map((id) => ({ id, title: id, purpose: "Find the answer.", kind: "current", document: `${id}.md`, inputs: ["answer.ts", ...policySources], related: [] }))
  const counts: Record<string, number> = {}
  const model = Model.make({ stream: (request) => Stream.suspend(() => {
    const text = [...request.system.map((part) => part.text),
      ...request.messages.flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []))].join("\n")
    const page = ["first", "second"].find((id) => text.includes(`"document":"${id}.md"`))
    assert.ok(page, "scripted provider must receive one of the fixture's exact evidence snapshots")
    counts[page] = (counts[page] ?? 0) + 1
    const review = { sections: [{ id: "section-1", verdict: "supported", explanation: "The exported constant supports this explanation.", citations: [{ path: "answer.ts", line: 1, quote: "export const answer = 42" }] }] }
    return Stream.fromIterable([
      ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "review" }),
      ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "review", text: `\`\`\`cell\nctx.done(${JSON.stringify(review)})\n\`\`\`` }),
      ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "review" }),
      ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ])
  }) })
  const seats = SeatResolver.layer({ resolve: (id) => Effect.succeed(Seat.make({ id, modelId: "scripted-wiki-reuse", model, contextWindowTokens: 200_000,
    route: { prepare: () => Effect.succeed({ routeId: "wiki-test", protocolId: "wiki-test", method: "POST", url: "https://example.invalid", publicHeaders: {}, body: new TextEncoder().encode("{}"), bodyText: "{}" }) }
  })) })
  const output = join(root, ".flows/wiki")
  const rule = (action: "fs:read" | "fs:write", resource: string) => new Capability.Permission.Rule({ effect: "allow", pattern: new Capability.Capability.CapabilityPattern({ action, resource }) })
  const host = () => NodeRuntime.layerHost({ filename: join(root, ".flows/engine.db"), workspaceRoot: root, owner: { hostId: "wiki-reuse-test" }, signals: [],
    rules: [[rule("fs:read", root), rule("fs:read", `${root}/**`), rule("fs:write", `${root}/.flows/**`)]]
  }, Layer.mergeAll(actionLayers({ root, output }), reuseLayers({ root, output }), agentLayers(seats, 60_000), Interpreter.layer(Wiki)).pipe(Layer.provideMerge(Action.layerImplementations)))
  const input: Input = { pages, mode: "verified", reviewer: "scripted-wiki-reuse" }
  const first = await Effect.runPromise(Effect.scoped(Wiki.execute(input, { executionId: "wiki-original" }).pipe(Effect.provide(host()))))
  assert.equal(first.verification, "verified")
  assert.deepEqual(counts, { first: 1, second: 1 })
  t.diagnostic("Original durable reviews recorded")
  const incremental = (runId: string, priorRunId: string, reviewer = input.reviewer) => Effect.runPromise(Effect.scoped(
    IncrementalWiki.execute({ ...input, mode: "verified", reviewer, priorRunId }, { executionId: runId }).pipe(Effect.provide(host()))))
  const second = await incremental("wiki-reused", "wiki-original")
  assert.equal(second.verification, "verified")
  t.diagnostic("Both exact reviews reused after runtime restart")
  assert.deepEqual(counts, { first: 1, second: 1 }, "a fresh runtime scope reuses both durable model reviews")
  let snapshot = JSON.parse(await readFile(join(output, "current.json"), "utf8"))
  for (const page of snapshot.pages) {
    assert.equal(page.verification.provenance.originRunId, "wiki-original")
    assert.equal(page.verification.provenance.reusedFrom.runId, "wiki-original")
  }
  await writeFile(join(root, "first.md"), "# first\n\nThe answer remains 42.\n")
  await incremental("wiki-one-changed", "wiki-reused")
  t.diagnostic("One changed page reviewed; its neighbor reused")
  assert.deepEqual(counts, { first: 2, second: 1 }, "changing one page cannot rerun the unaffected model call")
  snapshot = JSON.parse(await readFile(join(output, "current.json"), "utf8"))
  assert.equal(snapshot.pages[0].verification.provenance.reusedFrom, null)
  assert.equal(snapshot.pages[1].verification.provenance.originRunId, "wiki-original")
  await incremental("wiki-model-changed", "wiki-one-changed", "another-model")
  t.diagnostic("Changed reviewer invoked for both pages")
  assert.deepEqual(counts, { first: 3, second: 2 }, "changing the reviewer cannot borrow a prior model's result")
  await writeFile(join(root, policySources[0]), (await readFile(join(root, policySources[0]), "utf8")) + "\n// changed review policy\n")
  await incremental("wiki-policy-changed", "wiki-model-changed", "another-model")
  assert.deepEqual(counts, { first: 4, second: 3 }, "policy source changes invalidate prior reviews")
})
