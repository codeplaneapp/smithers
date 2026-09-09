import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { hostname, tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Context, Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as ProcessLedger from "../../packages/smithers/flows/kernel/src/ProcessLedger.ts"
import * as ProcessReaper from "../../packages/smithers/flows/platform-node/src/ProcessReaper.ts"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as CodingFileSystem from "../coding/filesystem.ts"

const source = process.env.PLUE_CODING_ADAPTER_SOURCE
const exporter = process.env.PLUE_JJ_EXPORT_BINARY
test("native coding file policy refuses ignored sources, destinations and unbounded mutation forms", {
  skip: !source || !exporter ? "Native Plue adapter and exporter required" : false, timeout: 120_000
}, async t => {
  const { platform } = process.versions.bun
    ? await import("../../packages/smithers/src/internal/BunControl.ts")
    : await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coding-file-policy-")))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, "repo")
  execFileSync("jj", ["git", "init", root], {stdio:"pipe"})
  const jj = (...args: string[]) => execFileSync("jj", ["-R",root,...args], {stdio:"pipe"})
  jj("config","set","--repo","user.name","Fixture")
  jj("config","set","--repo","user.email","fixture@example.com")
  await writeFile(join(root,"tracked.ignore"),"tracked")
  await writeFile(join(root,"ordinary.txt"),"ordinary")
  jj("status")
  await writeFile(join(root,".gitignore"),".flows/\n*.ignore\n*.tmp\n")
  await writeFile(join(root,"source.ignore"),"must remain")
  jj("status")
  const nativeSource=join(directory,"native.py"), wrapper=join(directory,"adapter.py"), config=join(directory,"config.json"),reporter=join(directory,"reporter")
  await writeFile(nativeSource,(await readFile(source!,"utf8")).replace('"/usr/local/bin/smithers-jj-export"',JSON.stringify(exporter)))
  await writeFile(config,JSON.stringify({version:1,workspaceId:"file-policy",actorId:42,repositoryPath:root,username:userInfo().username}))
  await writeFile(reporter,'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(wrapper,`import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(nativeSource)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)},engine="--engine" in sys.argv)))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)
  const native = NativeControl.make(platform)
  await Effect.runPromise(Effect.gen(function*() {
    const engine = yield* native.materializeEngine(native.engineDurable(root))
    const contained = ProcessReaper.layerSpawner().pipe(Layer.provide(platform.host),
      Layer.provide(ProcessLedger.layer({hostId:hostname(),ownerPid:process.pid}).pipe(Layer.provide(engine.journal))))
    const spawner = Context.get(yield* Layer.build(contained), ChildProcessSpawner.ChildProcessSpawner)
    const fs = Context.get(yield* Layer.build(native.layerGuardedPlatform(root)), FileSystem.FileSystem)
    const coding = CodingFileSystem.make({repositoryPath:root,adapterPath:wrapper},fs,spawner)
    const refuses = <A, R>(effect: Effect.Effect<A, unknown, R>) => effect.pipe(Effect.result,Effect.tap(result => Effect.sync(() => assert.equal(result._tag,"Failure"))))
    yield* refuses(coding.remove(join(root,"source.ignore")))
    yield* refuses(coding.rename(join(root,"source.ignore"),join(root,"moved.txt")))
    yield* refuses(coding.rename(join(root,"ordinary.txt"),join(root,"destination.ignore")))
    yield* refuses(coding.copyFile(join(root,"ordinary.txt"),join(root,"destination.ignore")))
    yield* refuses(coding.open(join(root,"ordinary.txt"),{flag:"w"}))
    yield* refuses(coding.remove(root,{recursive:true}))
    yield* coding.writeFileString(join(root,"tracked.ignore"),"updated")
    const temporary=join(root,".smithers-11111111-1111-4111-8111-111111111111.tmp")
    yield* coding.writeFileString(temporary,"prepared",{flag:"wx"})
    yield* refuses(coding.rename(temporary,join(root,"destination.ignore")))
    yield* coding.rename(temporary,join(root,"accepted.txt"))
    assert.equal(yield* fs.readFileString(join(root,"source.ignore")),"must remain")
    assert.equal(yield* fs.readFileString(join(root,"ordinary.txt")),"ordinary")
    assert.equal(yield* fs.readFileString(join(root,"tracked.ignore")),"updated")
    assert.equal(yield* fs.readFileString(join(root,"accepted.txt")),"prepared")
    assert.equal(yield* fs.exists(join(root,"destination.ignore")),false)
    assert.equal(yield* fs.exists(temporary),false)
  }).pipe(Effect.provide(platform.host),Effect.scoped))
})
