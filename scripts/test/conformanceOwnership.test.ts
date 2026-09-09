import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { it } from "node:test"

const root = resolve(import.meta.dirname, "../..")

it("runs repository conformance from the scripts target, outside the flows library suite", () => {
  const targets = readFileSync(resolve(root, "scripts/PACKAGE.ts"), "utf8")
  const runner = readFileSync(resolve(root, "scripts/test/repositoryConformance.test.ts"), "utf8")
  assert.ok(
    targets.includes("runner: Smithers.testRunner([Smithers.file(\"//scripts/test/repositoryConformance.test.ts\")])")
  )
  for (
    const owner of ["ci", "publication", "coverage", "spawnContainment", "workspaceInventory", "conformanceOwnership"]
  ) {
    const path = `scripts/test/${owner}.test.ts`
    assert.ok(existsSync(resolve(root, path)), `${path} must be owned by scripts`)
    assert.ok(runner.includes(`import "./${owner}.test.ts"`), `${path} must execute in the conformance runner`)
    assert.ok(targets.includes(`Smithers.file("//${path}")`), `${path} must run in the scripts target`)
  }
  for (const name of ["vitestCoverageIsolation", "spawnContainment"]) {
    assert.equal(existsSync(resolve(root, `packages/smithers/flows/test/${name}.test.ts`)), false)
  }
})
