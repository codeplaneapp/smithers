/**
 * No fault case may focus, skip, or park itself unnoticed.
 *
 * Ported from the Smithers 0.x `fault-skip-audit-gate` and `fault-only-todo-audit`
 * suites. Those drove a standalone `check-fault-skips.mjs` against synthetic
 * fixtures; the script is gone, so what survives is the audit itself, run
 * against the real matrix.
 *
 * The two failure modes are different. A focused test (`.only`) silently drops
 * every other case in its file, and a `.todo` reports as a pass. Both are
 * refused outright. A conditional skip is legitimate — cases 12 and 21 need the
 * `jj` binary — but every one has to be listed here with the condition it
 * skips on, so "this case has not run in six months" is a fact somebody chose
 * rather than one nobody noticed.
 *
 * Run it with `node --test "scripts/repo-contract/*.test.mjs"`.
 */
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..")
const faults = join(root, "e2e", "faults")
const harness = join(root, "e2e", "harness")

/**
 * The conditional skips the matrix is allowed to carry, and what each skips on.
 *
 * A file not listed here may contain no skip at all. Adding a row is the review
 * step: it states, in the repository, that a case does not always run.
 */
const allowedSkips = new Map([
  [
    "faults/case12-rewind-reverts-vcs.test.ts",
    "Needs the jj binary to rewind a real workspace. Skips locally without it and throws on CI."
  ],
  [
    "faults/case21-jj-pointer-integrity.test.ts",
    "Needs the jj binary to take and restore real snapshots. Skips locally without it and throws on CI."
  ]
])

/**
 * The inverted expectations the matrix carries: a test that passes because the
 * product still has the gap it describes, and turns red when the gap closes.
 * Each one is a pin on a known defect, so each one is listed with its reason.
 */
const allowedInversions = new Map([
  [
    "faults/case22-secret-never-in-journal.test.ts",
    "The default logger does not redact, so a credential still reaches the operator's terminal. Pinned in "
    + "e2e/fault-gaps.md; the test turns red the moment redaction reaches the log path."
  ]
])

const sources = [faults, harness]
  .filter((directory) => existsSync(directory))
  .flatMap((directory) =>
    readdirSync(directory)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => ({
        relative: `${directory === faults ? "faults" : "harness"}/${file}`,
        text: readFileSync(join(directory, file), "utf8")
      }))
  )

describe("the fault-suite skip audit", () => {
  it("has sources to audit", () => {
    assert.ok(sources.length > 15, `expected the matrix to be populated, found ${sources.length} files`)
  })

  it("refuses a focused test, which silently drops every other case in its file", () => {
    for (const source of sources) {
      const focused = [...source.text.matchAll(/\b(?:it|test|describe)\.only\b/g)]
      assert.equal(focused.length, 0, `${source.relative} contains ${focused.length} focused test(s)`)
    }
  })

  it("refuses a parked test, which reports as a pass", () => {
    for (const source of sources) {
      const parked = [...source.text.matchAll(/\b(?:it|test|describe)\.todo\b/g)]
      assert.equal(parked.length, 0, `${source.relative} contains ${parked.length} todo test(s)`)
    }
  })

  it("allows a conditional skip only where one is declared", () => {
    for (const source of sources) {
      const skips = [...source.text.matchAll(/\b(?:it|test|describe)\.(?:skip|skipIf|runIf)\b/g)]
      if (skips.length === 0) continue
      assert.ok(
        allowedSkips.has(source.relative),
        `${source.relative} skips conditionally without a row in allowedSkips. Add one with the condition it `
          + "skips on, or make the case unconditional."
      )
    }
  })

  it("allows an inverted expectation only where one is declared", () => {
    for (const source of sources) {
      const inverted = [...source.text.matchAll(/\b(?:it|test)\.fails\b/g)]
      if (inverted.length === 0) continue
      assert.ok(
        allowedInversions.has(source.relative),
        `${source.relative} pins a defect with .fails and has no row in allowedInversions`
      )
    }
  })

  it("keeps both allow-lists pointed at files that exist", () => {
    const present = new Set(sources.map((source) => source.relative))
    for (const relative of [...allowedSkips.keys(), ...allowedInversions.keys()]) {
      assert.ok(present.has(relative), `the allow-list names ${relative}, which is not in the matrix any more`)
    }
  })
})
