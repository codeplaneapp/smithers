import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { findPins, guardedGroups, guardedPackages, notesPath, undocumentedPins } from "./check-test-pins.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

test("finds every outright pin form, whatever the runner prefix", () => {
  const source = [
    `it.fails("a", () => {})`,
    `test.skip("b", () => {})`,
    `it.effect.skip("c", () => {})`,
    `it.live.todo("d")`,
    `describe.skip("e", () => {})`
  ].join("\n")

  assert.deepEqual(findPins(source).map((pin) => [pin.form, pin.title, pin.line]), [
    ["fails", "a", 1],
    ["skip", "b", 2],
    ["skip", "c", 3],
    ["todo", "d", 4],
    ["skip", "e", 5]
  ])
})

test("a capability gate is not a pin", () => {
  const source = [
    `describe.skipIf(process.platform === "win32")("windows", () => {})`,
    `describe.skipIf(!jjInstalled)("needs jj", () => {})`,
    `describe.skipIf(wasmBytes === undefined)("needs wasm", () => {})`,
    `describe.runIf(Boolean(process.env.CI))("ci only", () => {})`
  ].join("\n")

  assert.deepEqual(findPins(source), [])
})

test("an environment-variable gate is a pin, inline or through a const", () => {
  const inline = `it.live.runIf(process.env.FLOWS_SLOW_TESTS === "1")("slow one", () => {})`
  assert.deepEqual(findPins(inline).map((pin) => pin.title), ["slow one"])

  const nested = `it.runIf(Boolean(process.env.FLOWS_SLOW_TESTS))("slow nested", () => {})`
  assert.deepEqual(findPins(nested).map((pin) => pin.title), ["slow nested"])

  const aliased = [
    `const slowTests = process.env.FLOWS_SLOW_TESTS === "1"`,
    `it.live.runIf(slowTests)("slow two", () => {})`,
    `it.effect.skipIf(!slowTests)("slow three", () => {})`
  ].join("\n")
  assert.deepEqual(findPins(aliased).map((pin) => pin.title), ["slow two", "slow three"])
})

test("a pin counts as documented only when Surviving pins pairs its package and title", () => {
  const packages = [resolve(repoRoot, "packages", "database")]
  const notes = readFileSync(notesPath, "utf8")
  assert.deepEqual(undocumentedPins(notes, packages), [])

  const wrongPackage = notes.replace("| `database` | `dies with the original lock defect", "| `other` | `dies with the original lock defect")
  assert.equal(undocumentedPins(wrongPackage, packages).length, 1)

  const unexplained = undocumentedPins("# Alpha notes\n\nNothing here.\n", packages)
  assert.equal(unexplained.length, 1)
  assert.match(unexplained[0].title, /open-retry budget is exhausted/)
  assert.equal(unexplained[0].file, "packages/database/test/NodeDatabaseConcurrentOpen.test.ts")
})

test("reads Surviving pins through ordinary z text and through end of input", () => {
  const packages = [resolve(repoRoot, "packages", "database")]
  const title = "dies with the original lock defect after the fixed open-retry budget is exhausted"
  const notes = [
    "# Alpha notes",
    "",
    "### Surviving pins",
    "",
    "A z before this row must not end the section.",
    `| \`database\` | \`${title}\` | rationale |`
  ].join("\n")

  assert.deepEqual(undocumentedPins(notes, packages), [])
})

test("a resolved title does not authorize re-pinning a test", () => {
  const fixtureRoot = mkdtempSync(join(repoRoot, "scripts", ".check-test-pins-"))
  const packageDirectory = join(fixtureRoot, "capability")
  const title = "bounds wall time for adversarial repeated-star patterns against long non-matching resources"
  try {
    mkdirSync(join(packageDirectory, "test"), { recursive: true })
    writeFileSync(join(packageDirectory, "test", "Capability.test.mjs"), `it.fails(${JSON.stringify(title)}, () => {})\n`)

    const unexplained = undocumentedPins(readFileSync(notesPath, "utf8"), [packageDirectory])
    assert.equal(unexplained.length, 1)
    assert.equal(unexplained[0].title, title)
    assert.equal(unexplained[0].file, relative(repoRoot, join(packageDirectory, "test", "Capability.test.mjs")))
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test("the guarded set is the engine and tooling groups, read from the manifests", () => {
  assert.deepEqual([...guardedGroups].sort(), ["engine", "tooling"])

  const guarded = new Set(guardedPackages().map((directory) => directory.split("/").pop()))
  assert.ok(guarded.has("database"), "database is an engine package")
  assert.ok(guarded.has("build-cli"), "build-cli is a tooling package")
  assert.ok(!guarded.has("harness"), "harness is an agent package and out of scope")
})

test("the register exists and every pin in the tree appears in it", () => {
  assert.ok(existsSync(notesPath), "docs/alpha-notes.md is the register the guard reads")
  assert.match(readFileSync(notesPath, "utf8"), /## Known test pins/)
  assert.deepEqual(undocumentedPins(), [])
})
