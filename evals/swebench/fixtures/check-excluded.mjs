/**
 * The exclusion list, and the three rules that keep it from becoming tuning.
 *
 * An exclusion is the most dangerous thing in this rig: it moves a denominator,
 * and a denominator that moves for a reason nobody can read is a scoreboard
 * nobody can check. So the list itself is pinned here, structurally rather than
 * by name-count, against the rules `lib/excluded.mjs` states:
 *
 * 1. **the cause is documented, and it names something outside the agent** — a
 *    grading container, a public service, a dataset defect. A cause naming a
 *    harness, a model, a prompt or a patch would be tuning wearing an
 *    exclusion's clothes, so the wording is checked for those words;
 * 2. **the cause says it applies to both arms**, which is the only form of
 *    exclusion this rig has;
 * 3. **both denominators travel together**, so no caller can print one alone.
 *
 * The entries are checked for shape and for content, not for count: adding a
 * documented environment exclusion is allowed and adding an undocumented one is
 * not, and that is exactly the difference this file enforces.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { denominatorLabel, denominators, EXCLUDED, excludedIn, isExcluded, renderExclusions } from "../lib/excluded.mjs"

const root = resolve(import.meta.dirname, "..")

// -------------------------------------------------------------------------
// Every entry carries a readable, environment-shaped, both-arms cause.
// -------------------------------------------------------------------------
assert.ok(EXCLUDED.size > 0, "the exclusion list is empty; delete the module rather than shipping an empty one")
for (const [id, entry] of EXCLUDED) {
  assert.match(id, /^[a-z0-9_.-]+__[a-z0-9_.-]+-\d+$/i, `${id} is not a SWE-bench instance id`)
  assert.equal(typeof entry.cause, "string")
  assert.ok(entry.cause.length > 80, `${id}: a cause has to be a sentence somebody can act on`)
  assert.match(entry.cause, /both arms/i, `${id}: an exclusion has to state that it applies to both arms`)
  assert.match(
    entry.cause,
    /grading environment|container|service|dataset/i,
    `${id}: a cause has to name something outside the agent`
  )
  for (const forbidden of ["harness", "prompt", "model", "cellPrompt", "agent did"]) {
    assert.ok(
      !entry.cause.toLowerCase().includes(forbidden.toLowerCase()),
      `${id}: "${forbidden}" in a cause means this is tuning, not scoping`
    )
  }
  assert.equal(typeof entry.reportedIn, "string")
  const report = join(root, entry.reportedIn)
  assert.ok(readFileSync(report, "utf8").includes(id), `${entry.reportedIn} does not mention ${id}`)
}

// The pair the r92 report names, checked by name because it is the reason this
// module exists. Both, or the disclosure it came from is only half applied.
assert.ok(isExcluded("psf__requests-1766"))
assert.ok(isExcluded("psf__requests-2317"))
assert.ok(!isExcluded("django__django-14351"), "a harness regression is never an exclusion")

// -------------------------------------------------------------------------
// Only what a population actually contains is reported as excluded.
// -------------------------------------------------------------------------
assert.deepEqual(excludedIn(["a__a-1", "b__b-2"]), [])
assert.deepEqual(
  excludedIn(["psf__requests-2317", "a__a-1", "psf__requests-1766"]).map((row) => row.id),
  ["psf__requests-1766", "psf__requests-2317"],
  "the exclusion list is reported sorted, so two runs produce the same bytes"
)

// -------------------------------------------------------------------------
// Both denominators, always, and never one without the other.
// -------------------------------------------------------------------------
const clean = denominators(["a__a-1", "b__b-2", "c__c-3"])
assert.deepEqual({ scored: clean.scored, raw: clean.raw }, { scored: 3, raw: 3 })
assert.equal(denominatorLabel(clean), "3")

const scoped = denominators(["a__a-1", "psf__requests-1766", "psf__requests-2317"])
assert.deepEqual({ scored: scoped.scored, raw: scoped.raw }, { scored: 1, raw: 3 })
assert.equal(denominatorLabel(scoped), "1 scored of 3 run")

// The 45-instance population the reports are about: 43 and 45, both stated.
const wave = denominators([
  ...Array.from({ length: 43 }, (_, index) => `synthetic__s-${index}`),
  "psf__requests-1766",
  "psf__requests-2317"
])
assert.deepEqual({ scored: wave.scored, raw: wave.raw }, { scored: 43, raw: 45 })
assert.equal(denominatorLabel(wave), "43 scored of 45 run")

// -------------------------------------------------------------------------
// The rendered section names every cause, and says nothing when nothing is out.
// -------------------------------------------------------------------------
assert.deepEqual(renderExclusions([]), [])
const rendered = renderExclusions(wave.excluded).join("\n")
assert.match(rendered, /Excluded from the scoreboard, by name/)
assert.match(rendered, /applies to both arms equally/)
assert.match(rendered, /raw count is printed beside the scored one/)
for (const row of wave.excluded) {
  assert.ok(rendered.includes(row.id))
  assert.ok(rendered.includes(row.cause))
  assert.ok(rendered.includes(row.reportedIn))
}

console.log(
  "check-excluded: every exclusion names an environment cause for both arms, and both denominators travel together."
)
