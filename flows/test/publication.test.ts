import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { test, type TestContext } from "node:test"
import { publishedPackages } from "../../scripts/pack-release.mjs"
import { candidateIntegrity, integrity } from "../../scripts/publish-release.mjs"
import { releaseInput } from "../release-support/input.ts"
import { commandRunner } from "../release-support/io.ts"
import { operations } from "../release-support/operations.ts"
import { ReleaseError, type Candidate } from "../release-support/schema.ts"
import { repository } from "./fixtures.ts"

const fixture = async (test: TestContext) => {
  const repo = await repository(test)
  const version = repo.evidence.version
  await writeFile(join(repo.root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n')
  for (const [index, name] of publishedPackages.entries()) {
    const directory = name === "@smthrs/cli" ? "smithers" : `package-${index}`
    await mkdir(join(repo.root, "packages", directory), { recursive: true })
    await writeFile(join(repo.root, "packages", directory, "package.json"), JSON.stringify({ name, version, smthrs: { group: "engine" } }))
  }
  repo.git("add", ".")
  repo.git("commit", "-m", "release roster fixture")
  const sourceSha = repo.git("rev-parse", "HEAD")
  const directory = `.flows/releases/npm/${version}/${sourceSha}`
  await mkdir(join(repo.root, directory), { recursive: true })
  const packages = publishedPackages.map((name, index) => ({ name, version, filename: `package-${index}.tgz`, integrity: integrity(Buffer.from(name)) }))
  for (const entry of packages) await writeFile(join(repo.root, directory, entry.filename), entry.name)
  const manifest = { schemaVersion: 1, source: { sha: sourceSha, tag: `v${version}`, dirty: false }, packages }
  const hash = candidateIntegrity(manifest)
  const candidate: Candidate = { directory, digest: hash, sourceSha, version, packageCount: packages.length, approvalPrompt: "" }
  await writeFile(join(repo.root, directory, "manifest.json"), JSON.stringify(packages))
  await writeFile(join(repo.root, directory, "release-manifest.json"), JSON.stringify(manifest))
  for (const runtime of ["22.19.0", "24.11.0"]) {
    const smoke = { schemaVersion: 1, status: "passed", candidateIntegrity: hash, toolchain: { node: `v${runtime}` } }
    await writeFile(join(repo.root, directory, `smoke-node-${runtime}.json`), JSON.stringify(smoke))
    await writeFile(join(repo.root, directory, "smoke-evidence.json"), JSON.stringify(smoke))
  }
  const registry = new Map(packages.slice(0, -1).map((entry) => [`${entry.name}@${version}`, entry.integrity]))
  const publishes: string[][] = []
  const ops = operations({
    root: repo.root,
    run: async (command, args, options) => {
      if (command === "git") return commandRunner(repo.root)(command, args, options)
      assert.equal(command, "pnpm")
      if (args[0] === "view") {
        const value = registry.get(args[1]!)
        if (value === undefined) throw new ReleaseError({ step: "registry", message: "ERR_PNPM_FETCH_404" })
        return JSON.stringify(value)
      }
      assert.equal(args[0], "publish")
      publishes.push([...args])
      const entry = packages.find((item) => basename(args[1]!) === item.filename)!
      assert.ok(entry)
      registry.set(`${entry.name}@${version}`, entry.integrity)
      return ""
    }
  })
  const input = releaseInput({ phase: "publish", dryRun: false, requireContentApproval: false, provenance: false }, version)
  return { ...repo, directory, candidate, packages, registry, publishes, ops, input }
}

test("the publisher rechecks both runtime receipts and publishes only missing exact packages", async (test) => {
  const state = await fixture(test)
  const verified = await state.ops.verifyCandidate({ input: state.input, candidate: state.candidate })
  assert.match(verified.approvalPrompt, /1 pending of 49/)
  const result = await state.ops.publish({ input: state.input, candidate: verified })
  assert.deepEqual(result.published, [state.packages.at(-1)!.name])
  assert.equal(state.publishes.length, 1)
  assert.ok(state.publishes[0]!.includes("--provenance=false"))
  assert.equal(state.publishes[0]![state.publishes[0]!.indexOf("--tag") + 1], "next")
  await state.ops.publish({ input: state.input, candidate: verified })
  assert.equal(state.publishes.length, 1)
})

test("registry conflicts, tampered smoke receipts and stale source each refuse the whole publication", async (test) => {
  const state = await fixture(test)
  const entry = state.packages[0]!
  state.registry.set(`${entry.name}@${entry.version}`, "sha512-other-bytes")
  await assert.rejects(state.ops.publish({ input: state.input, candidate: state.candidate }), /Registry integrity mismatch/)
  assert.equal(state.publishes.length, 0)
  state.registry.set(`${entry.name}@${entry.version}`, entry.integrity)
  await writeFile(join(state.root, state.directory, "smoke-node-22.19.0.json"), JSON.stringify({ status: "passed", candidateIntegrity: "wrong", toolchain: { node: "v22.19.0" } }))
  await assert.rejects(state.ops.publish({ input: state.input, candidate: state.candidate }), /Missing verified Node/)
  assert.equal(state.publishes.length, 0)
  await writeFile(join(state.root, "README.md"), "Changed source\n")
  state.git("add", "README.md")
  state.git("commit", "-m", "intervening source change")
  await assert.rejects(state.ops.publish({ input: state.input, candidate: state.candidate }), /Source HEAD changed/)
  assert.equal(state.publishes.length, 0)
})
