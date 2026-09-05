import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { readWorkspaceManifests } from "./pack-release.mjs"

test("every published consumer of the cell compiler declares its supported Node range", () => {
  const manifests = readWorkspaceManifests()
  const consumers = new Set(["@smthrs/harness"])
  let changed
  do {
    changed = false
    for (const manifest of manifests.values()) {
      const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }
      if (!consumers.has(manifest.name) && Object.keys(dependencies).some(name => consumers.has(name))) {
        consumers.add(manifest.name)
        changed = true
      }
    }
  } while (changed)
  assert.ok(consumers.has("@smthrs/cli"))
  for (const manifest of manifests.values()) {
    if (consumers.has(manifest.name)) assert.equal(manifest.engines.node, "^22.19.0 || >=24.11.0", manifest.name)
  }
  const harnessRequire = createRequire(new URL("../packages/smithers/agent/harness/package.json", import.meta.url))
  for (const dependency of ["@babel/parser", "@babel/types"]) {
    assert.equal(harnessRequire(`${dependency}/package.json`).engines.node, "^22.18.0 || >=24.11.0",
      `${dependency}: recheck the public support range when this requirement changes`)
  }
  for (const template of ["default", "aomi"]) {
    const manifest = JSON.parse(readFileSync(new URL(`../packages/smithers/create-app/template/${template}/package.json`, import.meta.url), "utf8"))
    assert.equal(manifest.engines.node, "^22.19.0 || >=24.11.0", template)
  }
})
