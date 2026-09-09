import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Control } from "@smthrs/control"
import * as Model from "@smthrs/model/Model"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect, Stream } from "effect"
import * as Registry from "@smthrs/registry/Registry"
import { platform } from "../../packages/smithers/src/internal/NodeControlHost.ts"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import { layer } from "../coding/host.ts"
import { NativeCoding, nativeLayer } from "../coding/native.ts"
import type { Revision } from "../coding/schema.ts"

const source = process.env.PLUE_CODING_ADAPTER_SOURCE
const exporter = process.env.PLUE_JJ_EXPORT_BINARY
test("configured coding host runs the real AgentAction, guarded file tool and native JJ atom", {
  skip: source === undefined || exporter === undefined ? "Set PLUE_CODING_ADAPTER_SOURCE and PLUE_JJ_EXPORT_BINARY to Plue's native artifacts" : false,
  timeout: 1_200_000
}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-host-native-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Native Coding Host")
  jj("config", "set", "--repo", "user.email", "acceptance@example.com")
  await mkdir(join(root, "flows", "coding", "implementation"), { recursive: true })
  for (const file of ["flow.ts", "schema.ts", "implementation/flow.ts"]) {
    await cp(new URL(`../coding/${file}`, import.meta.url), join(root, "flows", "coding", file))
  }
  for (const tier of ["fast", "slow"]) {
    await mkdir(join(root, "flows", "checks", tier), { recursive: true })
    await writeFile(join(root, "flows", "checks", tier, "flow.mdx"),
      "---\ndescription: Verify the implemented file.\nflows: [coding/CommandCheck]\ncapabilities: ['*']\n---\n" +
      JSON.stringify({ argv: [process.execPath, "verify.mjs"], cwd: ".", timeoutMs: 30_000 }) + "\n")
  }
  await writeFile(join(root, "verify.mjs"), "import {readFileSync} from 'node:fs';\n" +
    "if (readFileSync('hello.txt', 'utf8') !== 'hello from the real agent cell\\\\n') process.exit(7);\n")
  // Declaration imports use this worktree's exact packages. Immutable checks
  // never borrow these dependencies or execute from the editing checkout.
  await symlink(new URL("../node_modules", import.meta.url).pathname, join(root, "node_modules"), "dir")
  await writeFile(join(root, ".gitignore"), ".flows/\nnode_modules\n")
  jj("status")
  const config = join(temporary, "coding.json"), reporter = join(temporary, "reporter"), wrapper = join(temporary, "adapter.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "host-acceptance", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(wrapper, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(source)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)})))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)
  const options = { repositoryPath: root, adapterPath: wrapper,
    gatewayId: "11111111-1111-4111-8111-111111111111", implementationModel: "test:scripted", exporterPath: exporter }
  const initial = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read()).pipe(
    Effect.provide(nativeLayer(options)), Effect.provide(platform.host), Effect.scoped))
  assert.equal(initial.head.kind, "resolved")
  const calls: string[] = []
  const cell = `const result = await ctx.call("write", { path: ${JSON.stringify(join(root, "hello.txt"))}, content: "hello from the real agent cell\\n" }); if (!result.ok) throw new Error(JSON.stringify(result)); ctx.done(${JSON.stringify(JSON.stringify({ summary: "Wrote hello.txt", reads: [], writes: ["hello.txt"] }))})`
  const model = Model.make({ stream: request => Stream.suspend(() => {
    calls.push(JSON.stringify(request))
    return Stream.fromIterable([
      ModelEvent.TextStart({ type: "text-start", id: "cell" }),
      ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
      ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
      ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ])
  }) })
  const seats = { resolve: (id: string) => Effect.succeed({ id, modelId: "scripted", model, contextWindowTokens: 100_000,
    route: { prepare: () => Effect.succeed({ routeId: "fixture", protocolId: "fixture", method: "POST" as const,
      url: "https://fixture.invalid", publicHeaders: {}, body: new TextEncoder().encode("{}"), bodyText: "{}" }) } }) }
  const registry = NativeControl.make(platform).layerRegistry(root)
  const implementation = await Effect.runPromise(Registry.Registry.pipe(
    Effect.flatMap(registry => registry.get("coding/implementation")), Effect.provide(registry), Effect.scoped))
  const checks = await Effect.runPromise(Effect.gen(function*() {
    const registry = yield* Registry.Registry
    return yield* Effect.forEach(["fast", "slow"] as const, tier => registry.get(`checks/${tier}`).pipe(
      Effect.map(descriptor => ({ id: tier, target: "hello.txt", flow: descriptor.name,
        flowDigest: Descriptor.executionDigest(descriptor)!, tier, required: true }))))
  }).pipe(Effect.provide(registry), Effect.scoped))
  const result = await Effect.runPromise(Effect.gen(function*() {
    const control = yield* Control.Control
    const card = yield* control.plan({ flowId: "coding", input: { plan: {
      prompt: "Write hello.txt", memoryRevision: "fixture", base: initial.head as Revision,
      changes: [{ id: "hello", title: "Hello", intent: "Write one file", implementation: "coding/implementation",
        implementationDigest: Descriptor.executionDigest(implementation)!, checks,
        atoms: [{ changeId: null, message: "✨ feat: add hello", intent: "Write hello.txt", reads: [], writes: ["hello.txt"] }] }]
    } } })
    yield* control.approve(card.approval)
    const receipt = yield* control.run({ _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope, idempotencyKey: "native-host" })
    assert.equal(receipt._tag, "Accepted")
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) throw new Error("expected accepted native run")
    return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
      Stream.takeUntil(event => event.kind === "control.engine.projection-settled"), Stream.runCollect,
      Effect.timeout("180 seconds"))
  }).pipe(Effect.provide(layer(platform, options, seats)), Effect.scoped))
  const failed = result.find(event => event.kind === "control.run.failed")
  assert.equal(failed, undefined, JSON.stringify({ failed, contents: await readFile(join(root, "hello.txt"), "utf8").catch(() => null),
    history: jj("log", "--no-graph", "-r", "all()", "-T", "change_id ++ ' ' ++ description"),
    evidence: result.filter(event => event.kind === "control.engine.event").slice(-20) }))
  assert(result.some(event => event.kind === "control.run.completed"))
  assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "hello from the real agent cell\\n")
  assert.equal(calls.length, 1)
  assert.equal(jj("log", "--no-graph", "-r", "@", "-T", "description").trim(), "✨ feat: add hello")
})
