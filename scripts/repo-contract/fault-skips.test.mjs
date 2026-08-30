/**
 * No fault case may focus, skip, or park itself unnoticed.
 *
 * Ported from the Smithers 0.x `fault-skip-audit-gate` and `fault-only-todo-audit`
 * suites. Those drove a standalone `check-fault-skips.mjs` against synthetic
 * fixtures; the script is gone, so what survives is the audit itself, run
 * against the real matrix.
 *
 * The failure modes are different. A focused test (`.only`) silently drops
 * every other case in its file, and a `.todo` reports as a pass. Both are
 * refused outright, and so is an inverted expectation (`.fails`).
 *
 * `.fails` is refused for a narrow reason, and the reason is not "a matrix may
 * not contain a failing test". The opposite: when the product does not meet a
 * requirement the matrix is required to cover, the sanctioned form is a plain
 * test that fails, kept in the matrix with its owner cited in the case file,
 * and reported as a failure in the gate line. `requiredRedGates` below lists
 * the ones that exist, and this suite asserts they are still there. What
 * `.fails` does is turn exactly that test into a pass: the run goes green, the
 * gate line stops naming the defect, and the requirement is enforced by
 * nothing. So the rule is about the marking, not about the colour — state the
 * requirement as a plain failing test and record the shipped limitation in
 * `e2e/fault-gaps.md` beside it.
 *
 * A conditional skip is legitimate — cases 12 and 21 need the `jj` binary —
 * but every one has to be listed here with the condition it skips on, so "this
 * case has not run in six months" is a fact somebody chose rather than one
 * nobody noticed.
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
 * The tests that are required to exist and are expected to be red at rc.0.
 *
 * A requirement the product does not meet yet is enforced by a plain failing
 * test, not by prose. This map is what stops the next person from making the
 * matrix green by deleting one.
 */
const requiredRedGates = new Map([
  [
    "faults/case22-secret-never-in-journal.test.ts",
    {
      title: "redacts the credential out of the operator's terminal",
      why: "rc-contract R-12 requires case 22 to cover the logs as well as the journal. rc.0 ships no "
        + "redacting logger, so this gate is red until the Phase 5 redaction deliverable (rc-contract "
        + "§5.2) lands. Deleting it, or marking it `.fails`, makes the matrix green over a live "
        + "credential leak."
    }
  ]
])

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

  it("refuses an inverted expectation, which reports green over a known defect", () => {
    for (const source of sources) {
      const inverted = [...source.text.matchAll(/\b(?:it|test)\.fails\b/g)]
      assert.equal(
        inverted.length,
        0,
        `${source.relative} pins a defect with .fails, which turns a failing required gate into a pass. `
          + "State the requirement as a plain test that fails, cite its owner in the case file, and record "
          + "the shipped limitation in e2e/fault-gaps.md."
      )
    }
  })

  it("keeps every required gate in the matrix, including the ones that are red", () => {
    const byRelative = new Map(sources.map((source) => [source.relative, source.text]))
    for (const [relative, gate] of requiredRedGates) {
      const text = byRelative.get(relative)
      assert.ok(text !== undefined, `${relative} is a required gate and is not in the matrix any more. ${gate.why}`)
      assert.ok(
        text.includes(gate.title),
        `${relative} no longer contains the required test "${gate.title}". ${gate.why}`
      )
    }
  })

  it("keeps the skip allow-list pointed at files that exist", () => {
    const present = new Set(sources.map((source) => source.relative))
    for (const relative of allowedSkips.keys()) {
      assert.ok(present.has(relative), `the allow-list names ${relative}, which is not in the matrix any more`)
    }
  })
})
