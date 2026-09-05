import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { DirectorySandbox } from "@smthrs/sandbox"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Echo } from "./release-sandbox-entry.mjs"

const root = await mkdtemp(join(tmpdir(), "smithers-release-sandbox-"))
try {
  const platform = Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.merge(NodeFileSystem.layer, Path.layer))
  const provider = await Effect.runPromise(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner
    return DirectorySandbox.make({ fs, spawner, root })
  }).pipe(Effect.provide(platform)))
  for (const [format, sandbox] of [
    ["esm", await import("@smthrs/flows/SandboxedFlow")],
    ["cjs", createRequire(import.meta.url)("@smthrs/flows/SandboxedFlow")]
  ]) {
    const result = await Effect.runPromise(sandbox.execute(Echo, { value: `release-${format}` }, {
      provider,
      session: `release-${format}`,
      entry: new URL("./release-sandbox-entry.mjs", import.meta.url)
    }))
    assert.equal(result.output, `release-${format}`)
    assert.deepEqual(result.diff, [])
    console.log(`sandbox smoke ok: ${format} bundles and executes its packaged guest runner`)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
