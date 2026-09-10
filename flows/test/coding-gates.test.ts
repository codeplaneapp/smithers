import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import * as Target from "@smthrs/targets/Target"
import { workspacePackages } from "../../scripts/workspace-packages.mjs"
import { Package } from "../PACKAGE.ts"
import { bunNativeTests, nativeTests } from "./coding-native-gate.mjs"

test("coding gates track source-only groups at every Smithers package boundary", () => {
  const metadata = Target.metadata(Package.codingPolicy)
  const groups = metadata.dependencies.map(Target.metadata).filter(member => member.target === "Filegroup")
  const backend = groups.filter(member => (member.attrs as { cwd: string }).cwd.startsWith("packages/smithers"))
  const actual = backend.map(member => (member.attrs as { cwd: string }).cwd).sort()
  const expected = workspacePackages().map(member => member.dir)
    .filter(dir => dir === "packages/smithers" || dir.startsWith("packages/smithers/")).sort()
  assert.deepEqual(actual, expected)
  for (const group of backend) {
    assert.equal(group.dependencies.length, 0, "source groups must not trigger package builds")
    assert.deepEqual(group.inputs, [
      { _tag: "Glob", pattern: "src/**", exclude: [] },
      { _tag: "File", path: "package.json" },
      { _tag: "File", path: "tsconfig.json" }
    ])
  }
  assert.ok(metadata.inputs.some(input => input._tag === "PnpmWorkspace" && input.path === "//pnpm-workspace.yaml"))
})

test("every coding test belongs to a declared gate; native targets stay separate and uncached", async () => {
  const actual = (await readdir(fileURLToPath(new URL("./", import.meta.url)))).filter(name => /^coding(?:-.*)?\.test\.ts$/.test(name))
  const ordinary = [Package.coding, Package.codingPolicy, Package.codingRuntime].flatMap(target =>
    (Target.metadata(target).attrs as { runner: { tests: ReadonlyArray<{ path: string }> } }).runner.tests.map(file => file.path.split("/").at(-1)!))
  assert.deepEqual([...ordinary, ...nativeTests].sort(), actual.sort())
  for (const target of [Package.codingNative, Package.codingNativeBun, Package.codingBundle, Package.codingBundleBun]) {
    const metadata = Target.metadata(target), attrs = metadata.attrs as { timeout: string; args: string[] }
    assert.equal(metadata.target, "Shell.Test")
    assert.equal(metadata.cacheable, false)
    assert.equal(attrs.timeout, "45m")
    assert.equal(attrs.args[0], "flows/test/coding-native-gate.mjs")
  }
  assert.ok(!bunNativeTests.includes("coding-atoms.test.ts") && !bunNativeTests.includes("coding-correction.test.ts"))
  assert.ok(bunNativeTests.includes("coding-request-host.test.ts"))
})

test("native gate refuses absent prerequisites before an opt-in fixture can skip", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./coding-native-gate.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH,
      PLUE_CODING_ADAPTER_SOURCE: "/smithers-acceptance-does-not-exist/adapter.py",
      PLUE_JJ_EXPORT_BINARY: "/smithers-acceptance-does-not-exist/exporter" }
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Native coding prerequisites are missing/)
  assert.doesNotMatch(result.stdout, /Native coding gate:/)
  const unlisted = spawnSync(process.execPath, [fileURLToPath(new URL("./coding-native-gate.mjs", import.meta.url)), "source", "../unlisted.ts"], {
    encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH }
  })
  assert.equal(unlisted.status, 1, unlisted.stderr)
  assert.match(unlisted.stderr, /Select an existing source fixture/)
})
