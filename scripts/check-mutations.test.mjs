import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { runMutations, verifyOutcome } from "./check-mutations.mjs"
import { mutants } from "./mutations/manifest.mjs"

test("mutation evidence refuses surviving, unloaded, empty, interrupted and infrastructure failures", () => {
  const mutant = { id: "fixture", test: "behavior oracle" }
  const result = () => ({ status: 1, signal: null, applied: true, report: { success: false,
    testResults: [{ status: "failed", message: "", assertionResults: [{ status: "failed", fullName: "behavior oracle", failureMessages: ["AssertionError: independent output differs"] }] }] } })
  assert.equal(verifyOutcome(result(), false, mutant).length, 1)
  for (const mutate of [
    (x) => { x.status = 0 }, (x) => { x.signal = "SIGTERM" }, (x) => { x.applied = false },
    (x) => { x.report.testResults[0].message = "missing module" },
    (x) => { x.report.testResults[0].assertionResults = [] },
    (x) => { x.report.testResults[0].assertionResults[0].failureMessages = ["Error: missing module"] },
    (x) => { x.report.testResults[0].assertionResults[0].fullName = "unrelated failure" }
  ]) { const value = result(); mutate(value); assert.throws(() => verifyOutcome(value, false, mutant)) }
  assert.throws(() => verifyOutcome(result(), true, mutant))
})

test("the mutation manifest names a behavioral assertion for every unique site", () => {
  assert.equal(new Set(mutants.map((mutant) => mutant.id)).size, mutants.length)
  assert.ok(mutants.length >= 11)
  for (const mutant of mutants) {
    assert.ok(mutant.assertion.length > 20)
    assert.ok(mutant.test.length > 10)
    assert.notEqual(mutant.original, mutant.replacement)
    assert.doesNotMatch(mutant.package, /control|sync|jj|engine-store|run-store|journal/)
  }
})

test("mutation failures cannot be overwritten or reused as fresh evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-mutation-preservation-"))
  try {
    const prior = join(directory, "failure.json")
    writeFileSync(prior, "prior failure")
    assert.throws(() => runMutations(directory), /prior evidence is immutable/)
    assert.equal(readFileSync(prior, "utf8"), "prior failure")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
