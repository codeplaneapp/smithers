/**
 * Replays `lib/surgery-evidence.mjs` over a synthesised journal and log.
 *
 * The r92 report claims that the four surgical changes r91 asked for acted, and
 * every one of those claims is a count this module takes off a journal. A
 * miscount would be invisible in the report and would read as evidence, so each
 * definition is pinned here against events whose every field is known.
 *
 * What is pinned:
 *
 * - **using the interpreter fact is told from hunting for it**. Naming the
 *   absolute path is a use; `which python`, `ls /opt`, `sys.executable` and
 *   `conda env list` are hunts. A call that does both counts as both, because
 *   a run that was handed the fact and went looking anyway is exactly the case
 *   the change is supposed to remove.
 * - **the taught path is the path this instance was told**, read out of the
 *   driver log's `project interpreter` lines, so "used an absolute path" and
 *   "used the one the harness stated" are separate columns.
 * - **a transport retry is a retry carrying that code**, counted apart from
 *   every other retryable class, because the change under test is the one that
 *   put a truncated response body on the ladder at all.
 * - a `test` call naming `against: "base"` is a baselined one, and
 * - a result carrying the reserved `invalidProbe` key is a probe the flow
 *   itself refused.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { readDirectory, readJournal, taughtInterpreters } from "../lib/surgery-evidence.mjs"

const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-surgery-"))
const TAUGHT = "/opt/miniconda3/envs/testbed/bin/python"

/** Writes one journal database out of a list of `[type, payload]` events. */
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
  events.forEach(([type, payload], index) => {
    insert.run("run-1", index, `e${index}`, "agent", index, 1000 + index, type, JSON.stringify(payload), "{}")
  })
  database.close()
  return path
}

const opened = ["control.agent.turn-opened", {}]
const retried = (code) => ["control.agent.model-retried", { attempt: 1, code, delayMillis: 500 }]
const call = (flowName, input, settle = { outcome: "success", value: {} }) => [
  ["control.agent.cell-call-started", { flowName, input }],
  ["control.agent.cell-call-settled", { flowName, ...settle }]
]

try {
  const path = journal("one__one-1", [
    // Frame 1 — the fact, used. One call names it as the interpreter, one opens
    // a command with it, and neither is a hunt.
    opened,
    ...call("bash", { interpreter: TAUGHT, script: "import numpy" }),
    ...call("bash", { command: `${TAUGHT} -c "import django"` }),

    // Frame 2 — two hunts in one frame, and a bare interpreter that answered
    // with the failure the hunt is chasing.
    opened,
    ...call("bash", { command: "ls /opt/miniconda3/envs" }),
    ...call("bash", { command: "which python3" }),
    ...call("bash", { interpreter: "python3", script: "import numpy" }, {
      outcome: "success",
      value: { exitCode: 1, stderr: "ModuleNotFoundError: No module named 'numpy'" }
    }),

    // Frame 3 — the structured test flow, once against the pristine base and
    // once not, plus a probe the flow itself refused.
    opened,
    ...call("test", { target: "tests/test_a.py", against: "base" }),
    ...call("test", { target: "tests/test_a.py" }),
    ...call("bash", { command: "pytest -k nope" }, {
      outcome: "failure",
      message: "the probe named no test",
      value: { invalidProbe: { reason: "no-such-test", message: "collected 0 items" } }
    }),

    // Frame 4 — a dropped socket, retried, then a class that is not transport.
    opened,
    retried("transport"),
    retried("transport"),
    retried("rate_limited")
  ])

  const counts = readJournal(path, TAUGHT)

  assert.equal(counts.frames, 4)
  assert.equal(counts.bashCalls, 6)

  // The fact, used: two calls name an absolute path, and both are the taught one.
  assert.equal(counts.statedInterpreter, 2)
  assert.equal(counts.taughtPath, 2)
  assert.equal(counts.bareInterpreter, 1, "`python3` is the r91 spelling and is not an absolute path")

  // The fact, hunted for. Frame 2 holds both hunts, so it is one hunting frame.
  assert.equal(counts.huntCalls, 2)
  assert.equal(counts.huntFrames, 1)
  assert.equal(counts.missingModule, 1, "the failure a bare interpreter answers with")

  // A frame that hunts twice is one frame; a second hunting frame is a second.
  const twice = readJournal(journal("two__two-2", [
    opened,
    ...call("bash", { command: "which python" }),
    opened,
    ...call("bash", { script: "import sys; print(sys.executable)" })
  ]))
  assert.equal(twice.huntCalls, 2)
  assert.equal(twice.huntFrames, 2)

  // The structured test flow, and the pristine-base comparison.
  assert.equal(counts.testCalls, 2)
  assert.equal(counts.basedTestCalls, 1)

  // The probe the flow refused, whichever half of the settlement carries it.
  assert.equal(counts.invalidProbes, 1)

  // The retry ladder, with transport counted apart.
  assert.equal(counts.modelRetries, 3)
  assert.equal(counts.transportRetries, 2)
  assert.deepEqual(counts.retriesByCode, { transport: 2, rate_limited: 1 })

  // A wave that predates the change cannot produce a transport retry, so a
  // journal without one reports zero rather than nothing.
  const quiet = readJournal(journal("three__three-3", [opened, ...call("bash", { command: "ls" })]))
  assert.equal(quiet.transportRetries, 0)
  assert.equal(quiet.modelRetries, 0)
  assert.deepEqual(quiet.retriesByCode, {})

  // ---------------------------------------------------------------------------
  // The driver log is where the taught path comes from.
  // ---------------------------------------------------------------------------
  const log = join(temporary, "driver.log")
  writeFileSync(
    log,
    [
      "2026-08-22T08:05:15Z run-45: 0 of 45 already re-run",
      "[one__one-1-r92] project interpreter /opt/miniconda3/envs/testbed/bin/python",
      "[two__two-2-r92] project interpreter not measurable — the run discovers it",
      "[three__three-3-r92] capture base abc123",
      ""
    ].join("\n")
  )
  const taught = taughtInterpreters(log)
  assert.deepEqual([...taught], [["one__one-1", TAUGHT]], "only a measured absolute path is a taught one")

  // ---------------------------------------------------------------------------
  // The fold over a whole wave.
  // ---------------------------------------------------------------------------
  const summary = readDirectory(temporary, taught)
  assert.equal(summary.instances, 3)
  assert.equal(summary.taughtInstances, 1)
  assert.equal(summary.taughtPathInstances, 1)
  assert.equal(summary.huntInstances, 2, "one__one-1 and two__two-2 hunted; three__three-3 did not")
  assert.equal(summary.testInstances, 1)
  assert.equal(summary.total.frames, 7, "4 + 2 + 1 across the three journals")
  assert.equal(summary.total.transportRetries, 2)
  assert.deepEqual(summary.total.retriesByCode, { transport: 2, rate_limited: 1 })
  assert.deepEqual(summary.unreadable, [])

  console.log(
    "check-surgery-evidence: using the interpreter fact is told from hunting for it, the taught path"
      + " is the one the log states, and a transport retry is counted apart."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
