import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Executable from "@smthrs/registry/Executable"
import * as Discovery from "@smthrs/registry/Discovery"
import { RunStore } from "@smthrs/run-store/RunStore"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { Implement, ImplementPlan, RunCheck, policyLayers } from "../coding/workflow.ts"
import { catalogLayers } from "../coding/catalog.ts"
import { RunPlan, invalidInputLayer } from "../coding/registration.ts"
import { Implementation as ImplementationSchema, Receipt as ReceiptSchema } from "../coding/schema.ts"
import type { Check, CodingError, Implementation, Plan, Receipt, Revision } from "../coding/schema.ts"

const revision = (name: string, parent?: string): Revision => ({ changeId: `jj-${name}`, commitId: `commit-${name}`, treeId: `tree-${name}`, operationId: `op-${name}`, parentCommitIds: parent === undefined ? [] : [`commit-${parent}`] })
const plan: Plan = {
  prompt: "Build the database, then the server", memoryRevision: "sha256:memory", base: revision("base"),
  changes: ["database", "server"].map(id => ({
    id, title: id, intent: `Implement ${id}`, implementation: `implement/${id}`,
    atoms: [{ changeId: null, message: `✨ feat: ${id}`, intent: id, reads: [], writes: [`src/${id}.ts`] }],
    checks: [
      { id: "build", target: "//:build", flow: "backpressure/build", tier: "fast", required: true },
      { id: "review", target: "//:review", flow: "review", tier: "slow", required: true },
      { id: "canary", target: "//:canary", flow: "delivery/canary", tier: "delivery", required: true }
    ]
  }))
}
const implementation = (id: string): Implementation => {
  const parent = id === "database" ? "base" : "database"
  return { change: id, parent: revision(parent), atoms: [revision(id, parent)], head: revision(id, parent), reads: [], writes: [`src/${id}.ts`] }
}
const receipt = (impl: Implementation, check: Check): Receipt => ({
  checkId: check.id, target: check.target, tier: check.tier, change: impl.change,
  commitId: impl.head.commitId, treeId: impl.head.treeId, inputDigest: `digest:${impl.head.treeId}:${check.target}`,
  status: "passed", evidence: "fixture build receipt", findings: []
})
const latch = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { await: Effect.promise(() => promise), release }
}
const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-coding-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  return { root, filename: join(root, ".flows", "engine.db") }
}
const wiring = (
  fixture: { root: string; filename: string },
  implement: (input: typeof Implement.payloadSchema.Type) => Effect.Effect<Implementation, CodingError>,
  check: (input: typeof RunCheck.payloadSchema.Type) => Effect.Effect<Receipt, CodingError>
) => NodeRuntime.layerHost({ filename: fixture.filename, workspaceRoot: fixture.root, owner: { hostId: "coding-test" }, signals: [] },
  Layer.mergeAll(policyLayers, Implement.toLayer(implement), RunCheck.toLayer(check), Interpreter.layer(ImplementPlan))
    .pipe(Layer.provideMerge(Action.layerImplementations)))

test("slow review overlaps later implementation while fast gates preserve the linear order", { timeout: 60_000 }, async t => {
  const repo = await fixture(t), entered = latch(), advanced = latch(), events: string[] = []
  const runtime = wiring(repo, ({ change, parent }) => Effect.gen(function*() {
    if (change.id === "server") {
      assert.equal(parent.commitId, "commit-database")
      yield* entered.await
      assert.ok(events.includes("build:database"))
      advanced.release()
    }
    events.push(`implement:${change.id}`)
    return implementation(change.id)
  }), ({ implementation: impl, check }) => Effect.gen(function*() {
    assert.notEqual(check.tier, "delivery", "delivery belongs after vibing/landing")
    if (impl.change === "database" && check.tier === "slow") {
      events.push("slow:started")
      entered.release()
      yield* advanced.await
      events.push("slow:finished")
    } else events.push(`${check.id}:${impl.change}`)
    return receipt(impl, check)
  }))
  const result = await Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime))))
  assert.equal(result.status, "validated")
  assert.deepEqual(result.changes.map(change => change.implementation.change), ["database", "server"])
  assert.ok(events.indexOf("implement:server") < events.indexOf("slow:finished"))
  assert.equal(result.changes[0]?.receipts.length, 2)
})

test("a required fast failure blocks the next Change", { timeout: 60_000 }, async t => {
  const repo = await fixture(t), implemented: string[] = []
  const runtime = wiring(repo, ({ change }) => Effect.sync(() => { implemented.push(change.id); return implementation(change.id) }),
    ({ implementation: impl, check }) => Effect.succeed({ ...receipt(impl, check), status: check.tier === "fast" ? "failed" : "passed" }))
  await assert.rejects(Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime)))), /did not pass/)
  assert.deepEqual(implemented, ["database"])
})

test("a receipt from a previous commit cannot unlock the next Change", { timeout: 60_000 }, async t => {
  const repo = await fixture(t), implemented: string[] = []
  const runtime = wiring(repo, ({ change }) => Effect.sync(() => { implemented.push(change.id); return implementation(change.id) }),
    ({ implementation: impl, check }) => Effect.succeed({ ...receipt(impl, check), commitId: "old-commit" }))
  await assert.rejects(Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime)))), /current revision/)
  assert.deepEqual(implemented, ["database"])
})

test("a late finding retains the earlier owner and prevents validation", { timeout: 60_000 }, async t => {
  const repo = await fixture(t)
  const runtime = wiring(repo, ({ change }) => Effect.succeed(implementation(change.id)),
    ({ implementation: impl, check }) => Effect.succeed(impl.change === "server" && check.tier === "slow"
      ? { ...receipt(impl, check), status: "failed", findings: [{ owner: "database", sourceCommitId: impl.head.commitId, message: "The database owns the missing constraint" }] }
      : receipt(impl, check)))
  const result = await Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime))))
  assert.equal(result.status, "changes-requested")
  assert.equal(result.findings[0]?.owner, "database")
  assert.equal(result.findings[0]?.sourceCommitId, "commit-server")
})

test("invalid plan policy is refused before implementation starts", { timeout: 60_000 }, async t => {
  const repo = await fixture(t), called: string[] = []
  const invalid = { ...plan, changes: plan.changes.map(change => ({ ...change, checks: change.checks.filter(check => check.tier !== "slow") })) }
  const runtime = wiring(repo, ({ change }) => Effect.sync(() => { called.push(change.id); return implementation(change.id) }),
    ({ implementation: impl, check }) => Effect.succeed(receipt(impl, check)))
  await assert.rejects(Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan: invalid }).pipe(Effect.provide(runtime)))), /required slow check/)
  assert.deepEqual(called, [])
})

test("an implementation on a different parent cannot advance the mythical progression", { timeout: 60_000 }, async t => {
  const repo = await fixture(t), implemented: string[] = []
  const runtime = wiring(repo, ({ change }) => Effect.sync(() => {
    implemented.push(change.id)
    return { ...implementation(change.id), atoms: [revision(change.id, "unrelated")] }
  }), ({ implementation: impl, check }) => Effect.succeed(receipt(impl, check)))
  await assert.rejects(Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime)))), /linear progression/)
  assert.deepEqual(implemented, ["database"])
})

test("registered project flows persist native child lineage and replay without reimplementing", { timeout: 90_000 }, async t => {
  const repo = await fixture(t), called: Array<{ flow: string; runId: string }> = []
  const DelegateAction = Action.make("coding-test/project-step", {
    payload: Executable.Invocation, success: Schema.Json
  })
  const Delegate = Flow.make("coding-test/project", {
    payload: Executable.Invocation, success: Schema.Json,
    body: input => DelegateAction.call(input)
  })
  for (const name of ["implement/database", "implement/server", "backpressure/build", "review"]) {
    const path = join(repo.root, "flows", name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, "flow.mdx"), "---\ndescription: Coding contract fixture.\nflows: [coding-test/project]\ncapabilities: []\n---\nRun the registered fixture.\n")
  }
  const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const executables = await Effect.runPromise(Effect.gen(function*() {
    const discovery = yield* Discovery.Discovery
    const found = yield* discovery.scan({ source: "project", root: join(repo.root, "flows"), naming: "path" })
    assert.equal(found.entries.length, 4)
    return yield* Effect.forEach(found.entries, descriptor => Executable.fromDescriptor(descriptor, { delegates: [Delegate] }))
  }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provideMerge(platform)))))
  const delegates = DelegateAction.toLayer(input => Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    called.push({ flow: input.flow, runId: instance.executionId })
    if (input.flow.startsWith("implement/")) {
      const payload = yield* Schema.decodeUnknownEffect(Implement.payloadSchema)(input.input).pipe(Effect.orDie)
      return Schema.encodeSync(Schema.toCodecJson(ImplementationSchema))(implementation(payload.change.id))
    }
    const payload = yield* Schema.decodeUnknownEffect(RunCheck.payloadSchema)(input.input).pipe(Effect.orDie)
    return Schema.encodeSync(Schema.toCodecJson(ReceiptSchema))(receipt(payload.implementation, payload.check))
  }))
  const runtime = NodeRuntime.layerHost({ filename: repo.filename, workspaceRoot: repo.root, owner: { hostId: "coding-catalog-test" }, signals: [] },
    Layer.mergeAll(policyLayers, invalidInputLayer, catalogLayers, delegates, Interpreter.layer(ImplementPlan), Interpreter.layer(RunPlan), Interpreter.layer(Delegate), ...executables.map(executable => executable.layer))
      .pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(Layer.succeed(Executable.Catalog, { executables, refused: [] }))))
  const run = Effect.gen(function*() {
    const result = yield* RunPlan.execute({
      flow: "coding", input: { plan }, prompt: "", model: null, placement: null,
      placementOptions: null, capabilities: [], flows: ["coding/RunPlan"]
    }, { executionId: "coding-catalog-parent" })
    const store = yield* RunStore
    for (const call of called) {
      const row = yield* store.get(call.runId)
      // RunStore.parentRunId is the trampoline predecessor. Spawn ancestry
      // lives in the engine state and its existing durable parent-edge table.
      assert.equal(JSON.parse(row.stateJson).parentExecutionId, "coding-catalog-parent")
      assert.equal(row.status, "completed")
    }
    return result
  }).pipe(Effect.provide(runtime), Effect.scoped)
  assert.equal((await Effect.runPromise(run)).status, "validated")
  assert.equal(called.length, 6)
  assert.equal(new Set(called.map(call => call.runId)).size, 6)
  assert.equal((await Effect.runPromise(run)).status, "validated")
  assert.equal(called.length, 6, "settled native executions must replay after the host is reopened")
  await assert.rejects(Effect.runPromise(RunPlan.execute({
    flow: "coding", input: { plan: "malformed" }, prompt: "", model: null,
    placement: null, placementOptions: null, capabilities: [], flows: ["coding/RunPlan"]
  }, { executionId: "coding-invalid-envelope" }).pipe(Effect.provide(runtime), Effect.scoped)), /must contain a valid predicted/)
  assert.equal(called.length, 6)
})
