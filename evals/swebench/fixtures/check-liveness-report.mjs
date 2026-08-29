/**
 * Asserts `lib/check-liveness.mjs` grades a journal the way the README says.
 *
 *   node fixtures/check-liveness-report.mjs
 *
 * `readonly-liveness.sh` spends real tokens, so its verdict is the one thing in
 * the rig that cannot be re-run to settle an argument. What can be settled
 * offline is the reading: given a journal, does the checker call the control
 * live, dead, or unproven? A checker that answered "live" on a journal with no
 * demand event, or "dead" on a probe that stopped before the cap, would turn a
 * $0.30 experiment into a wrong answer nobody could see was wrong.
 *
 * Four journals, four verdicts:
 *
 *   0  a demand event reached the journal — the control fired.
 *   3  INCONCLUSIVE: the streak never reached the cap, so the probe proved
 *      nothing either way.
 *   1  FAILED, naming the justification: the streak reached the cap, no demand
 *      was journaled, and a transition carried a justification. That is the
 *      wave-6 case, and the message has to say so or the next reader concludes
 *      the cap is dead.
 *   1  FAILED with nothing to blame: the streak reached the cap and no demand
 *      arrived.
 *
 * The streak arithmetic is checked too: a frame that mutated clears it, so a
 * run that reaches the cap only by counting through a write is not at the cap.
 *
 * Spends no tokens and needs no dataset.
 *
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

const here = import.meta.dirname
const rig = resolve(here, "..")
const checker = join(rig, "lib/check-liveness.mjs")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-liveness-"))

const ddl = `CREATE TABLE IF NOT EXISTS flows_journal_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  emitted_at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
)`

/** Writes one workspace whose `.flows/engine.db` holds the given events. */
const workspace = (name, events) => {
  const root = join(temporary, name)
  mkdirSync(join(root, ".flows"), { recursive: true })
  const database = new DatabaseSync(join(root, ".flows/engine.db"))
  database.exec(ddl)
  const insert = database.prepare(
    "insert into flows_journal_events"
      + " (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)"
      + " values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  events.forEach(([type, payload], index) =>
    insert.run("run-1", index, `run-1-${index}`, "fixture", index, index, type, JSON.stringify(payload), "{}")
  )
  database.close()
  return root
}

/** The events every probe journals before its frames start. */
const opening = (cap) => [
  ["control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }],
  ["control.agent.discipline-armed", { readOnlyCap: cap, maxFrames: 100 }]
]

/** `count` settled frames that changed nothing, each with its transition. */
const quietFrames = (count, { justifiedAt } = {}) =>
  Array.from({ length: count }, (_, frame) => [
    ["control.agent.mutation-observed", { mutated: false }],
    ["control.agent.transition-applied", {
      transition: frame === justifiedAt ? { justification: "still reading" } : {}
    }]
  ]).flat()

const check = (root) => spawnSync(process.execPath, [checker, root], { encoding: "utf8", cwd: rig })

try {
  const fired = check(workspace("fired", [
    ...opening(12),
    ...quietFrames(12),
    ["control.agent.read-only-demanded", { streak: 12, cap: 12, nextFrame: 12, nextAction: "read-only" }],
    ["control.agent.model-settled", { usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 } }]
  ]))
  assert.equal(fired.status, 0, fired.stderr)
  assert.match(fired.stdout, /demands {9}1\n/)
  assert.match(fired.stdout, /longest streak {2}12\n/)
  assert.match(fired.stdout, /read-only-demanded streak=12 cap=12 nextFrame=12/)
  assert.match(fired.stdout, /the read-only control fired and reached the journal/)

  // A probe that stopped early proves nothing. Calling that a failure would
  // retire a live control on the evidence of a short run.
  const short = check(workspace("short", [...opening(12), ...quietFrames(4)]))
  assert.equal(short.status, 3, short.stdout)
  assert.match(short.stderr, /INCONCLUSIVE — the run never reached the cap \(longest streak 4, cap 12\)/)

  // The wave-6 case: the cap was reached, nothing was journaled, and a
  // justification is why. The message must name it.
  const justified = check(workspace("justified", [...opening(12), ...quietFrames(12, { justifiedAt: 10 })]))
  assert.equal(justified.status, 1, justified.stdout)
  assert.match(justified.stderr, /1 transition\(s\) carried a justification/)
  assert.match(justified.stderr, /the wave-6 finding reproduced/)
  assert.match(justified.stdout, /justifications {2}1 transition\(s\) carried one/)

  // The same reading with nothing to blame is the one that indicts the control.
  const dead = check(workspace("dead", [...opening(12), ...quietFrames(12)]))
  assert.equal(dead.status, 1, dead.stdout)
  assert.match(dead.stderr, /nothing justified it, and no demand was journaled/)

  // A frame that wrote clears the streak, so twelve settled frames around a
  // write are not twelve quiet ones.
  const interrupted = check(workspace("interrupted", [
    ...opening(12),
    ...quietFrames(6),
    ["control.agent.mutation-observed", { mutated: true }],
    ["control.agent.transition-applied", { transition: {} }],
    ...quietFrames(6)
  ]))
  assert.equal(interrupted.status, 3, interrupted.stdout)
  assert.match(interrupted.stderr, /longest streak 6, cap 12/)

  // A workspace that never ran is a usage error, not a verdict about the cap.
  const empty = join(temporary, "empty")
  mkdirSync(empty, { recursive: true })
  const nothing = check(empty)
  assert.equal(nothing.status, 2, nothing.stdout)
  assert.match(nothing.stderr, /no journal under/)

  console.log("check-liveness-report.mjs: the liveness checker reads a journal the way the README says it does.")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
