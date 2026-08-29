/**
 * Replays `lib/round3-evidence.mjs` over synthesised journals.
 *
 * The r93 report claims that the changes `rerun-r92.md` asked for by name
 * acted, and every one of those claims is a count this module takes off a
 * journal. A miscount would be invisible in the report and would read as
 * evidence, so each definition is pinned here against events whose every field
 * is known.
 *
 * What is pinned:
 *
 * - **an observation carries its own after-record**. A firing is counted once,
 *   and the three things a reader wants to know about what happened next —
 *   how many frames the run still had, whether it stored a different proof
 *   afterwards, and whether it went and watched that same check fail — are
 *   each read off later events rather than assumed from the firing.
 * - **the same check is told from a different one** by the text an observation
 *   quotes, re-derived from the call's own input with its keys in a fixed
 *   order. A run that re-ran the named check and got a red is not a run that
 *   ignored the observation, and a run that stored a different check is not a
 *   run that stored the same one.
 * - **a ladder is a contiguous run of retries**, so two incidents in one run
 *   are two ladders and not one, and a ladder is `survived` only when the
 *   frame it ran in went on to settle a model call.
 * - **a ladder that stopped short of the declared rung count is named
 *   separately** from one that exhausted it, because those are the two
 *   different things the wall clock and the rung count each bound.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { declaredRungs, label, readDirectory, readJournal } from "../lib/round3-evidence.mjs"

const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-round3-"))

/** Writes one journal database out of a list of `[type, payload, atMillis?]` events. */
const journal = (name, events) => {
  const directory = join(temporary, name)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "engine.db")
  const database = new DatabaseSync(path)
  database.exec(
    "create table flows_journal_events ("
      + " run_id text not null, seq integer not null, event_id text not null unique,"
      + " source_id text not null, source_seq integer not null, emitted_at_ms integer not null,"
      + " event_type text not null, payload_json text not null, meta_json text not null,"
      + " primary key (run_id, seq))"
  )
  const insert = database.prepare(
    "insert into flows_journal_events"
      + " (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)"
      + " values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  events.forEach(([type, payload, at], index) => {
    insert.run("run-1", index, `e${index}`, "agent", index, at ?? 1000 + index, type, JSON.stringify(payload), "{}")
  })
  database.close()
  return path
}

const opened = (at) => ["control.agent.turn-opened", {}, at]
const retried = (code, delayMillis, at) => [
  "control.agent.model-retried",
  { attempt: 1, code, delayMillis },
  at
]
const settled = (at) => ["control.agent.model-settled", { text: "```cell```" }, at]
const call = (flowName, input, settle = { outcome: "success", value: { exitCode: 0 } }) => [
  ["control.agent.cell-call-started", { flowName, input }],
  ["control.agent.cell-call-settled", { flowName, ...settle }]
]
const transition = (state) => ["control.agent.transition-applied", { transition: { _tag: "continue", state } }]

/** The check every case below is about, and the text an observation quotes of it. */
const CHECK = { command: "pytest tests/test_one.py -k one", cwd: "/testbed" }
const observed = (nextFrame) => [
  "control.agent.vacuous-verification-observed",
  {
    flow: "bash",
    // The controller clips the canonical form; the reader compares a prefix of
    // it, so the fixture quotes exactly what the controller would.
    check: label("bash", CHECK).slice("bash ".length),
    signature: "sig-1",
    nextFrame
  }
]

try {
  // ------------------------------------------------------------------
  // The run that was told, and then did the work: it stored a different
  // proof, and it watched the named check fail.
  // ------------------------------------------------------------------
  const corrected = readJournal(journal("one__one-1", [
    opened(),
    ...call("bash", CHECK),
    transition({ verification: { flow: "bash", input: CHECK } }),
    observed(2),
    opened(),
    ...call("bash", CHECK, { outcome: "success", value: { exitCode: 1 } }),
    transition({ verification: { flow: "bash", input: { command: "pytest tests/test_two.py", cwd: "/testbed" } } }),
    opened(),
    ["control.agent.cell-settled", { outcome: "complete" }]
  ]))
  assert.equal(corrected.vacuousObserved, 1, "one firing")
  assert.equal(corrected.vacuous.length, 1)
  assert.equal(corrected.vacuous[0].framesAfter, 2, "the two frames the run had after being told")
  assert.equal(corrected.vacuous[0].changedProof, true, "a later transition stored a different check")
  assert.equal(corrected.vacuous[0].watchedFailAfter, true, "the run re-ran the named check and got a red")
  assert.equal(corrected.outcome, "complete")

  // ------------------------------------------------------------------
  // The run that was told and did nothing: it re-stored the same check, its
  // re-run of it passed again, and it completed on that.
  // ------------------------------------------------------------------
  const ignored = readJournal(journal("two__two-2", [
    opened(),
    ...call("bash", CHECK),
    transition({ verification: { flow: "bash", input: CHECK } }),
    observed(2),
    opened(),
    ...call("bash", CHECK),
    transition({ verification: { flow: "bash", input: CHECK } }),
    ["control.agent.cell-settled", { outcome: "complete" }]
  ]))
  assert.equal(ignored.vacuousObserved, 1)
  assert.equal(ignored.vacuous[0].framesAfter, 1)
  assert.equal(ignored.vacuous[0].changedProof, false, "the same check re-stored is not a changed proof")
  assert.equal(ignored.vacuous[0].watchedFailAfter, false, "a green re-run is not a watched failure")

  // A refusal by the flow is a watched failure as much as a non-zero exit is.
  const refused = readJournal(journal("two__two-3", [
    opened(),
    transition({ verification: { flow: "bash", input: CHECK } }),
    observed(2),
    opened(),
    ...call("bash", CHECK, { outcome: "failure", message: "no such file" })
  ]))
  assert.equal(refused.vacuous[0].watchedFailAfter, true, "a refused call is a watched failure")

  // A *different* check that fails afterwards says nothing about the one the
  // observation named.
  const elsewhere = readJournal(journal("two__two-4", [
    opened(),
    transition({ verification: { flow: "bash", input: CHECK } }),
    observed(2),
    opened(),
    ...call("bash", { command: "pytest tests/test_other.py", cwd: "/testbed" }, {
      outcome: "success",
      value: { exitCode: 1 }
    })
  ]))
  assert.equal(elsewhere.vacuous[0].watchedFailAfter, false, "another check's red is not this check's red")

  // ------------------------------------------------------------------
  // Ladders. Two incidents in one run are two ladders; the one the frame
  // recovered from is the one that survived.
  // ------------------------------------------------------------------
  const laddered = readJournal(journal("three__three-3", [
    // Frame 1 — three rungs, then the frame settles a model call.
    opened(10_000),
    retried("transport", 1_000, 22_000),
    retried("transport", 2_000, 22_000),
    retried("transport", 4_000, 22_000),
    settled(22_500),
    // Frame 2 — the declared count, and no settle: exhausted.
    opened(30_000),
    ...Array.from({ length: declaredRungs }, () => retried("transport", 1_000, 75_000)),
    // Frame 3 — short of the declared count, and no settle: stopped short.
    opened(80_000),
    retried("transport", 1_000, 128_000),
    retried("transport", 2_000, 128_000)
  ]))
  assert.equal(laddered.ladderCount, 3, "three contiguous runs of retries are three ladders")
  assert.equal(laddered.ladderRungs, 3 + declaredRungs + 2)
  assert.equal(laddered.transportRetries, 3 + declaredRungs + 2)
  assert.equal(laddered.survivedLadders, 1, "only the frame that settled a model call survived")
  assert.equal(laddered.exhaustedLadders, 1)
  assert.equal(laddered.wallBoundLadders, 1, "a ladder short of the declared count stopped short")
  assert.deepEqual(laddered.ladders.map((one) => one.rungs), [3, declaredRungs, 2])
  assert.equal(laddered.ladders[0].survived, true)
  assert.equal(laddered.ladders[0].delayMillis, 7_000)
  assert.equal(laddered.ladders[0].spanMillis, 12_000, "turn-opened to the rungs' own timestamp")
  assert.equal(laddered.ladders[2].spanMillis, 48_000, "a span past the window is the reading that names one")
  assert.deepEqual(laddered.retriesByCode, { transport: 10 })

  // A retry of another class is counted and is not a transport retry.
  const timedOut = readJournal(journal("four__four-4", [
    opened(),
    retried("call_timeout", 900),
    settled()
  ]))
  assert.equal(timedOut.modelRetries, 1)
  assert.equal(timedOut.transportRetries, 0)
  assert.deepEqual(timedOut.retriesByCode, { call_timeout: 1 })

  // ------------------------------------------------------------------
  // The fold over a directory names the instances rather than only counting.
  // ------------------------------------------------------------------
  const summary = readDirectory(temporary)
  assert.equal(summary.instances, 6)
  assert.deepEqual(summary.vacuousInstances, ["one__one-1", "two__two-2", "two__two-3", "two__two-4"])
  assert.deepEqual(summary.ladderInstances, ["four__four-4", "three__three-3"])
  assert.equal(summary.total.vacuousObserved, 4)
  assert.equal(summary.total.transportRetries, 10)
  assert.deepEqual(summary.total.retriesByCode, { transport: 10, call_timeout: 1 })
  assert.deepEqual(summary.unreadable, [])

  console.log(
    "check-round3-evidence: a firing carries what the run did next, the check an observation named is told"
      + " from another, and a ladder that recovered is told from one that exhausted its rungs and one that"
      + " stopped short."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
