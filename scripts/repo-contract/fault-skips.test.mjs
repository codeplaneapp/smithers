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
 * A required red gate is also a shipped limitation, and a shipped limitation
 * that is only written down in `e2e/fault-gaps.md` is written down where no
 * reader of the release looks. Each entry in `requiredRedGates` therefore names
 * the section of `docs/pages/release/known-limitations.md` that states the
 * limitation, and this suite checks both that the section exists and that the
 * fault-gaps row points at it.
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
 * The tests that are required to exist, whatever colour they are.
 *
 * A required parity test is a promise the repository made in the release
 * contract, and the cheapest way to break one is to delete the test rather than
 * the promise. This map is what stops that: a gate listed here has to be in the
 * matrix, under its own title, or this suite fails and names it.
 */
const requiredGates = new Map([
  [
    "faults/case22-secret-never-in-journal.test.ts",
    {
      title: "redacts the credential out of the operator's terminal",
      why: "rc-contract R-12 requires case 22 to cover the logs as well as the journal. It was red at rc.0 "
        + "and went green when the section 5.2 redaction deliverable landed `@smthrs/journal` "
        + "`RedactedLogger`. It runs the real binary and reads its real stderr, so it is the only thing "
        + "that proves the redacting logger is installed under the durable engine rather than merely "
        + "exported. Deleting it retires the proof, not the requirement."
    }
  ]
])

/**
 * The subset of {@link requiredGates} that are expected to be RED right now.
 *
 * A requirement the product does not meet yet is enforced by a plain failing
 * test, not by prose, and a shipped limitation that is written down only in
 * `e2e/fault-gaps.md` is written down where no reader of the release looks. An
 * entry here therefore also has to name its section of the known-limitations
 * page, and the fault-gaps row has to link to it.
 *
 * Empty. Case 22's terminal-log half was the last entry: rc.0 shipped no
 * redacting logger, so the gate was red by design and `e2e-faults` carried
 * `continueOnError` for it. The section 5.2 redaction deliverable landed the
 * logger, the gate went green with no edit to the case, and `e2e-faults` became
 * a required CI job. While this map is empty the matrix is expected to be green
 * end to end; adding an entry back means putting `continueOnError` back on that
 * job in the root `BUILD.ts` in the same commit.
 */
const requiredRedGates = new Map([])

const knownLimitations = join(root, "docs", "pages", "release", "known-limitations.md")
const faultGaps = join(root, "e2e", "fault-gaps.md")

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
    for (const [relative, gate] of requiredGates) {
      const text = byRelative.get(relative)
      assert.ok(text !== undefined, `${relative} is a required gate and is not in the matrix any more. ${gate.why}`)
      assert.ok(
        text.includes(gate.title),
        `${relative} no longer contains the required test "${gate.title}". ${gate.why}`
      )
    }
  })

  it("keeps every red gate in the required set, so its existence is checked too", () => {
    for (const relative of requiredRedGates.keys()) {
      assert.ok(
        requiredGates.has(relative),
        `${relative} is listed as red by design and is not in requiredGates, so nothing checks that the test `
          + "still exists. Add it there as well."
      )
    }
  })

  it("keeps the fault job's CI status in step with the required-red set", () => {
    // The comment over `requiredRedGates` states this rule; without a case it
    // is enforced by nothing, and the two limitation cases below pass over an
    // empty collection. A red gate the matrix is required to carry means
    // `e2e-faults` cannot fail the pipeline, and an empty map means it must.
    const build = readFileSync(join(root, "BUILD.ts"), "utf8")
    const faultsJob = build.slice(build.indexOf("id: \"e2e-faults\""))
    const jobBody = faultsJob.slice(0, faultsJob.indexOf("\n    }"))
    const advisory = /continueOnError:\s*true/.test(jobBody)
    const required = /requiredJobs:[^\]]*"e2e-faults"/.test(build)
    if (requiredRedGates.size === 0) {
      assert.ok(!advisory, "requiredRedGates is empty, so e2e-faults must not carry continueOnError")
      assert.ok(required, "requiredRedGates is empty, so e2e-faults belongs in requiredJobs")
    } else {
      assert.ok(advisory, "a required red gate is listed, so e2e-faults must carry continueOnError")
      assert.ok(!required, "a required red gate is listed, so e2e-faults must not be in requiredJobs")
    }
  })

  it("states every required red gate as a shipped limitation on the release page", () => {
    const page = readFileSync(knownLimitations, "utf8")
    for (const [relative, gate] of requiredRedGates) {
      assert.ok(
        page.includes(`### ${gate.limitation.heading}`),
        `${relative} is red by design, so rc.0 ships the limitation it names. `
          + `docs/pages/release/known-limitations.md has no "${gate.limitation.heading}" section, so a reader of `
          + "the release learns about it only from a failing CI job. Add the paragraph to rc-contract §7 and "
          + "regenerate the page."
      )
    }
  })

  it("points the fault-gaps row at that limitation instead of describing it", () => {
    const gaps = readFileSync(faultGaps, "utf8")
    for (const [relative, gate] of requiredRedGates) {
      const row = gaps.split("\n").find((line) => line.startsWith(gate.limitation.row))
      assert.ok(row !== undefined, `e2e/fault-gaps.md has no ${gate.limitation.row} row for ${relative}`)
      assert.ok(
        row.includes(gate.limitation.anchor),
        `the ${gate.limitation.row} row claims the limitation is recorded on the known-limitations page and does `
          + `not link to it. Link ${gate.limitation.anchor}.`
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
