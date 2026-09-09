import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"
import { readWorkspaceInventory } from "../readWorkspaceInventory.ts"

it("includes nested and config-less packages while excluding installed dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-workspace-inventory-"))
  try {
    for (const name of ["smithers", "smithers/flows", "smithers/flows/new-engine", "smithers/node_modules/installed"]) {
      const path = join(root, "packages", name)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, "package.json"), JSON.stringify({ name, smthrs: { group: "engine" } }))
    }
    writeFileSync(join(root, "packages/smithers/flows/vitest.config.ts"), "export default {}")
    const inventory = readWorkspaceInventory(root)
    assert.equal(inventory.packagesDir, join(root, "packages"))
    assert.deepEqual(inventory.manifests.map(({ name }) => name), [
      "smithers",
      "smithers/flows",
      "smithers/flows/new-engine"
    ])
    assert.deepEqual(inventory.packages, inventory.manifests.map(({ name }) => name))
    assert.equal(inventory.configs.find(({ name }) => name === "smithers/flows/new-engine")?.source, "")
    assert.equal(inventory.configs.find(({ name }) => name === "smithers/flows")?.source, "export default {}")
    assert.equal(inventory.manifests[2]?.manifest.smthrs?.group, "engine")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("keeps non-library members in the full inventory used by barrel and containment checks", () => {
  const inventory = readWorkspaceInventory()
  for (const name of ["rpc", "smithers/ui", "smithers/ui/ui-styleguide", "smithers/build/infra"]) {
    assert.ok(inventory.manifests.some((entry) => entry.name === name))
    assert.ok(!inventory.packages.includes(name))
  }
  assert.ok(inventory.packages.includes("smithers/flows"))
  assert.ok(inventory.packages.includes("smithers/flows/kernel"))
})
