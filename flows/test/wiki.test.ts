import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { operations } from "../wiki/operations.ts"
import { reviewEvidence } from "../wiki/evidence.ts"
import type { PageSpec, ReviewedPage, Review } from "../wiki/schema.ts"

const fixture = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-wiki-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "src"))
  await writeFile(join(root, "page.md"), "# A small page\n\nThe answer is 42.\n")
  await writeFile(join(root, "src/answer.ts"), "export const answer = 42\n")
  const spec: PageSpec = { id: "answer", title: "Answer", purpose: "Find the answer.", kind: "current", document: "page.md", inputs: ["src/answer.ts"], related: [] }
  const output = join(root, "output"), ops = operations({ root, output })
  return { root, output, spec, ops }
}
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/FileSystem").FileSystem | import("effect/Path").Path | import("effect/Crypto").Crypto>) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const supported = (evidence: ReviewedPage["evidence"]): Review => ({ sections: evidence.sections.map((section) => ({ id: section.id, verdict: "supported", explanation: "The exported constant supports the explanation.", citations: [{ path: "src/answer.ts", line: 1, quote: "export const answer = 42" }] })) })

test("both owning prose and code invalidate a source snapshot; no input is truncated", async (t) => {
  const f = await fixture(t), before = await run(f.ops.collect(f.spec))
  await writeFile(join(f.root, "src/answer.ts"), "export const answer = 43\n")
  const code = await run(f.ops.collect(f.spec))
  assert.notEqual(before.inputDigest, code.inputDigest)
  assert.equal(before.contentDigest, code.contentDigest)
  await writeFile(join(f.root, "page.md"), "# A small page\n\nThe answer changed.\n")
  const prose = await run(f.ops.collect(f.spec))
  assert.notEqual(prose.contentDigest, code.contentDigest)
  assert.equal(prose.sources.find((source) => source.path === "src/answer.ts")?.text, "export const answer = 43\n")
})

test("outside-root and private paths cannot become generation input, including symlinks", async (t) => {
  const f = await fixture(t)
  await symlink("/etc/hosts", join(f.root, "outside"))
  for (const input of ["../secret", "/etc/hosts", ".env", ".flows/state", "Smithers-Ops/strategy.md", "outside"]) {
    await assert.rejects(run(f.ops.collect({ ...f.spec, inputs: [input] })), /WikiError|outside|escape|private|relative|Private|Source/)
  }
})

test("curated review excerpts retain full-file invalidation and enforce shown citation lines", async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, "src/answer.ts"), "// not sent to the reviewer\n  export const answer = 42\n// still a dependency\n")
  const spec = { ...f.spec, excerpts: { "src/answer.ts": [{ start: 2, end: 2 }] } }
  const evidence = await run(f.ops.collect(spec))
  const view = reviewEvidence(evidence).sources.find((source) => source.path === "src/answer.ts")!
  assert.deepEqual(view.lines, [{ line: 2, text: "  export const answer = 42" }])
  assert.equal(view.complete, false)
  assert.equal("text" in view, false, "full source must not leak into the reviewer view")
  const page = { evidence, reviewer: "scripted-test", review: { sections: supported(evidence).sections.map((section) => ({ ...section, citations: [{ path: "src/answer.ts", line: 2, quote: "export const answer = 42" }] })) } }
  await run(f.ops.assess(page)) // Exact quote begins after indentation.
  for (const citation of [
    { path: "src/answer.ts", line: 1, quote: "export const answer = 42" },
    { path: "src/answer.ts", line: 1, quote: "// not sent to the reviewer" },
    { path: "src/answer.ts", line: 2, quote: "export const answer = 42\n// still a dependency" }
  ]) await assert.rejects(run(f.ops.assess({ ...page, review: { sections: page.review.sections.map((section) => ({ ...section, citations: [citation] })) } })), /exact source/)
  await writeFile(join(f.root, "src/answer.ts"), "// changed outside excerpt\n  export const answer = 42\n// still a dependency\n")
  assert.notEqual((await run(f.ops.collect(spec))).inputDigest, evidence.inputDigest)
  for (const excerpts of [{ "src/answer.ts": [{ start: 0, end: 1 }] }, { "src/answer.ts": [{ start: 2, end: 200 }] }, { missing: [{ start: 1, end: 1 }] }]) {
    await assert.rejects(run(f.ops.collect({ ...spec, excerpts })), /Invalid review excerpt/)
  }
})

test("semantic gate requires complete exact citations and refuses false freshness", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  const page: ReviewedPage = { evidence, review: supported(evidence), reviewer: "scripted-test" }
  await assert.rejects(run(f.ops.assess({ ...page, review: { sections: [] } })), /every section/)
  const bad = supported(evidence)
  await assert.rejects(run(f.ops.assess({ ...page, review: { sections: bad.sections.map((section) => ({ ...section, citations: [{ path: "src/answer.ts", line: 2, quote: "export const answer = 42" }] })) } })), /exact source/)
  await writeFile(join(f.root, "src/answer.ts"), "export const answer = 43\n")
  await assert.rejects(run(f.ops.write([page], "verified")), /Source changed during review/)
})

test("uncertain review persists an honest preview and cannot succeed as verified", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  const review = { sections: supported(evidence).sections.map((section) => ({ ...section, verdict: "uncertain" as const })) }
  await assert.rejects(run(f.ops.write([{ evidence, review, reviewer: "scripted-test" }], "verified")), /Semantic review did not pass/)
  const current = JSON.parse(await readFile(join(f.output, "current.json"), "utf8"))
  assert.equal(current.verification, "needs-changes")
  assert.equal(current.pages[0].verification.status, "needs-changes")
})

test("snapshot installation preserves human intent, records all sources and detects edited artifacts", async (t) => {
  const f = await fixture(t)
  await mkdir(f.output)
  await writeFile(join(f.output, "human-intent.md"), "Keep my future plans.\n")
  const evidence = await run(f.ops.collect(f.spec))
  const page: ReviewedPage = { evidence, review: supported(evidence), reviewer: "scripted-test" }
  const receipt = await run(f.ops.write([page], "verified"))
  assert.equal(receipt.verification, "verified")
  assert.equal(await readFile(join(f.output, "human-intent.md"), "utf8"), "Keep my future plans.\n")
  const current = JSON.parse(await readFile(join(f.output, "current.json"), "utf8"))
  assert.equal(current.pages[0].slug, "generated-answer")
  assert.deepEqual(current.pages[0].spec, f.spec, "the snapshot must retain the specification needed to reproduce its input digest")
  assert.equal(await readFile(join(f.output, current.directory, "sources/src/answer.ts"), "utf8"), "export const answer = 42\n")
  await run(f.ops.write([page], "verified"))
  await writeFile(join(f.output, current.directory, "pages/answer.md"), "A human correction.\n")
  await assert.rejects(run(f.ops.write([page], "verified")), /Immutable snapshot was edited/)
})

test("unowned or symlink current pointers are never overwritten", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  await mkdir(f.output)
  await writeFile(join(f.output, "current.json"), '{"my":"notes"}')
  const page = { evidence, review: null, reviewer: null }
  await assert.rejects(run(f.ops.write([page], "preview")), /unowned current pointer/)
  await rm(join(f.output, "current.json"))
  await symlink(join(f.root, "page.md"), join(f.output, "current.json"))
  await assert.rejects(run(f.ops.write([page], "preview")), /cannot be a symlink/)
  assert.equal(await readFile(join(f.root, "page.md"), "utf8"), "# A small page\n\nThe answer is 42.\n")
})

test("real AgentAction review and flow replay use the existing engine", { timeout: 90_000 }, async (t) => {
  const { Action, Interpreter } = await import("@smthrs/flow")
  const { FlowEngine } = await import("@smthrs/engine")
  const { Layer, Stream } = await import("effect")
  const Model = await import("@smthrs/model/Model")
  const ModelEvent = await import("@smthrs/model/ModelEvent")
  const Seat = await import("@smthrs/agent/Seat")
  const SeatResolver = await import("@smthrs/agent/SeatResolver")
  const { Wiki } = await import("../wiki/workflow.ts")
  const { agentLayers } = await import("../wiki/runtime.ts")
  const { actionLayers } = await import("../wiki/runtime.ts")
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  let calls = 0
  const model = Model.make({ stream: () => Stream.suspend(() => {
    calls++
    return Stream.fromIterable([
      ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "review" }),
      ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "review", text: `\`\`\`cell\nctx.done(${JSON.stringify(supported(evidence))})\n\`\`\`` }),
      ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "review" }),
      ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ])
  }) })
  const seats = SeatResolver.layer({ resolve: (id) => Effect.succeed(Seat.make({ id, model, contextWindowTokens: 200_000,
    route: { prepare: () => Effect.succeed({ routeId: "wiki-test", protocolId: "wiki-test", method: "POST", url: "https://example.invalid", publicHeaders: {}, body: new TextEncoder().encode("{}"), bodyText: "{}" }) }
  })) })
  const layer = Layer.mergeAll(actionLayers({ root: f.root, output: f.output }), agentLayers(seats, 10_000), Interpreter.layer(Wiki)).pipe(
    Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeServices.layer))
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const input = { pages: [f.spec], mode: "verified" as const, reviewer: "scripted-test" }
    const first = yield* Wiki.execute(input, { executionId: "wiki-replay-test" })
    assert.equal(first.verification, "verified")
    const second = yield* Wiki.execute(input, { executionId: "wiki-replay-test" })
    assert.deepEqual(second, first)
  }).pipe(Effect.provide(layer))))
  assert.equal(calls, 1, "a replay must not pay the reviewer twice")
})

test("freshness and verified checks detect stale inputs and altered verification metadata", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  await run(f.ops.write([{ evidence, review: null, reviewer: null }], "preview"))
  assert.equal((await run(f.ops.check([f.spec]))).verification, "unreviewed")
  await assert.rejects(run(f.ops.check([f.spec], true)), /has not passed semantic review/)
  const location = join(f.output, "current.json"), current = JSON.parse(await readFile(location, "utf8"))
  await writeFile(location, JSON.stringify({ ...current, verification: "verified" }))
  await assert.rejects(run(f.ops.check([f.spec], true)), /differs from its immutable snapshot/)
  await writeFile(location, JSON.stringify(current))
  await writeFile(join(f.root, "src/answer.ts"), "export const answer = 43\n")
  await assert.rejects(run(f.ops.check([f.spec])), /Stale wiki page/)
})
