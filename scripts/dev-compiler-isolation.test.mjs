import assert from "node:assert/strict"
import test from "node:test"
import { classicCompilerTools, hooks } from "../.pnpmfile.mjs"
import { publishedPackages, readWorkspaceManifests } from "./pack-release.mjs"

test("the compiler compatibility hook only changes explicitly named dev tools", () => {
  for (const other of [{}, { name: "unrelated" }, { name: "madge" }]) {
    assert.equal(hooks.readPackage(other), other)
  }
  for (const [name, version] of classicCompilerTools) {
    const original = {
      name, version,
      dependencies: { keep: "1.0.0" },
      peerDependencies: { typescript: ">=4.8.4 <6.1.0", eslint: "^9" }
    }
    assert.deepEqual(hooks.readPackage(original), {
      ...original,
      dependencies: { keep: "1.0.0", typescript: "5.9.3" },
      peerDependencies: { eslint: "^9" }
    })
    assert.equal(original.peerDependencies.typescript, ">=4.8.4 <6.1.0")
    const future = { ...original, version: "99.0.0" }
    assert.equal(hooks.readPackage(future), future)
  }
})

test("all public runtime dependency declarations remain untouched", () => {
  const manifests = readWorkspaceManifests()
  assert.equal(manifests.size, publishedPackages.length)
  assert.ok(manifests.size > 0)
  for (const manifest of manifests.values()) {
    assert.equal(hooks.readPackage(manifest), manifest)
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        assert.ok(!classicCompilerTools.has(name), `${manifest.name} has a runtime dependency on dev tool ${name}`)
      }
    }
  }
  const compiler = { name: "typescript", version: "7.0.2" }
  assert.equal(hooks.readPackage(compiler), compiler)
})
