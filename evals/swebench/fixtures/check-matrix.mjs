/**
 * Replays the matrix driver's scheduler over a stub harness command.
 *
 * `run-matrix.sh` is the piece of the best-of-n rig that cannot be checked by
 * reading it: whether the schedule it produces really holds two invariants at
 * once — at most `jobs` runs in flight, and never two runs of the same instance
 * — is a statement about interleaving, and interleaving is what a stub can
 * exercise for nothing. `SWB_RUN_CMD` replaces the per-run command with a script
 * that records its own start and end, sleeps, writes a patch, and exits with a
 * chosen status.
 *
 * Every assertion is read off that ledger and the manifest the driver wrote:
 * the driver's own view (`matrix-<harness>.json`) has to agree with what the
 * runs actually did.
 *
 * Spends no tokens, needs no docker, needs no dataset, and runs no harness.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-matrix-"))

/**
 * Fake instances, named so that nothing can mistake them for dataset members.
 *
 * The patch root is the rig's own `patches/`, because that is where
 * `lib/run-paths.sh` says a run's patch goes and the point of the test is that
 * the driver reads the same answer. The files are removed at the end.
 */
const instances = ["stub__alpha", "stub__beta", "stub__gamma"]
const rounds = 3
const jobs = 2

/**
 * The instance the solo pass runs, where `jobs` is larger than the sample.
 *
 * With three instances and two jobs the concurrency bound already serializes an
 * instance's rounds, so that pass cannot tell whether the same-instance rule is
 * enforced or merely implied: deleting the rule's wait leaves that schedule
 * unchanged. One instance and three jobs isolates it — the only thing that can
 * keep two rounds of one instance apart is the rule itself.
 */
const solo = "stub__solo"

const ledger = join(temporary, "ledger.txt")
const soloLedger = join(temporary, "solo-ledger.txt")

try {
  writeFileSync(
    join(temporary, "dataset.json"),
    JSON.stringify(instances.map((id) => ({
      instance_id: id,
      repo: "stub/stub",
      version: "1.0",
      base_commit: "abc123",
      problem_statement: "stub"
    })))
  )
  writeFileSync(join(temporary, "sample.json"), JSON.stringify({ instances }))
  writeFileSync(ledger, "")

  // The stub harness: one line when it starts, one when it ends, a patch whose
  // size names the run, and an exit status that is non-zero for exactly one run
  // so the manifest's exit column is exercised by something other than success.
  const stub = join(temporary, "stub-run.sh")
  writeFileSync(
    stub,
    `#!/bin/bash
set -u
ID="$1"
INDEX="$4"
eval "$("${root}/lib/run-paths.sh" flows "$ID" "$INDEX")"
printf 'S %s %s\\n' "$ID" "$INDEX" >> "${ledger}"
sleep 0.4
printf 'x%.0s' $(seq 1 "\${#RUN_ID}") > "$PATCH"
printf 'E %s %s\\n' "$ID" "$INDEX" >> "${ledger}"
if [ "$ID" = "stub__beta" ] && [ "$INDEX" = "r2" ]; then exit 3; fi
exit 0
`
  )
  chmodSync(stub, 0o755)

  const manifest = join(temporary, "matrix.json")
  const driver = spawnSync(
    join(root, "run-matrix.sh"),
    ["flows", String(rounds), String(jobs)],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SWB_RUN_CMD: stub,
        SWB_SAMPLE: join(temporary, "sample.json"),
        SWB_DATASET: join(temporary, "dataset.json"),
        SWB_SAMPLE_COUNT: String(instances.length),
        SWB_MATRIX_OUT: manifest
      }
    }
  )
  // One stub run exits 3, so the driver's own status is that run's, by the same
  // rule `run-sample.sh` follows.
  assert.equal(driver.status, 3, `${driver.stdout}\n${driver.stderr}`)

  // ---------------------------------------------------------------------
  // What the runs actually did
  // ---------------------------------------------------------------------
  const events = readFileSync(ledger, "utf8").split("\n").filter((line) => line !== "")
  assert.equal(events.length, instances.length * rounds * 2, "every run starts once and ends once")

  const live = new Set()
  let peak = 0
  const firstStarts = []
  for (const line of events) {
    const [kind, id, index] = line.split(" ")
    const key = `${id}-${index}`
    if (kind === "S") {
      for (const running of live) {
        assert.notEqual(
          running.slice(0, running.lastIndexOf("-")),
          id,
          `two runs of ${id} were in flight at once (${running} and ${key})`
        )
      }
      live.add(key)
      peak = Math.max(peak, live.size)
      if (firstStarts.length < jobs) firstStarts.push(id)
    } else {
      live.delete(key)
    }
  }
  assert.equal(live.size, 0, "every run that started also ended")
  assert.ok(peak <= jobs, `at most ${jobs} runs in flight, saw ${peak}`)
  assert.ok(peak > 1, "the driver did overlap runs, so the bound means something")
  assert.equal(new Set(firstStarts).size, firstStarts.length, "the schedule interleaves instances")

  // ---------------------------------------------------------------------
  // What the driver says they did
  // ---------------------------------------------------------------------
  const written = JSON.parse(readFileSync(manifest, "utf8"))
  assert.equal(written.harness, "flows")
  assert.equal(written.countPerInstance, rounds)
  assert.equal(written.jobs, jobs)
  assert.deepEqual([...written.instances].sort(), [...instances].sort())
  assert.equal(written.runs.length, instances.length * rounds)

  const rows = new Map(written.runs.map((run) => [run.runId, run]))
  for (const id of instances) {
    for (let round = 1; round <= rounds; round++) {
      const row = rows.get(`${id}-r${round}`)
      assert.ok(row !== undefined, `manifest is missing ${id}-r${round}`)
      assert.equal(row.instance, id)
      assert.equal(row.index, `r${round}`)
      assert.equal(row.patchBytes, `${id}-r${round}`.length, "the manifest measured this run's own patch")
      assert.equal(row.exit, id === "stub__beta" && round === 2 ? 3 : 0)
      assert.ok(row.wallClockSeconds >= 0)
      assert.ok(row.endedAt >= row.startedAt)
    }
  }

  // Manifest order is the matrix, not the finishing order.
  assert.deepEqual(
    written.runs.map((run) => run.runId),
    instances.flatMap((id) => [1, 2, 3].map((round) => `${id}-r${round}`))
  )

  // ---------------------------------------------------------------------
  // The same-instance rule on its own, with the concurrency bound removed
  // as an explanation: one instance, three jobs, three rounds.
  // ---------------------------------------------------------------------
  writeFileSync(
    join(temporary, "solo-dataset.json"),
    JSON.stringify([{
      instance_id: solo,
      repo: "stub/stub",
      version: "1.0",
      base_commit: "abc123",
      problem_statement: "stub"
    }])
  )
  writeFileSync(join(temporary, "solo-sample.json"), JSON.stringify({ instances: [solo] }))
  writeFileSync(soloLedger, "")

  const soloStub = join(temporary, "solo-run.sh")
  writeFileSync(
    soloStub,
    `#!/bin/bash
set -u
eval "$("${root}/lib/run-paths.sh" flows "$1" "$4")"
printf 'S %s\\n' "$4" >> "${soloLedger}"
sleep 0.4
printf 'x' > "$PATCH"
printf 'E %s\\n' "$4" >> "${soloLedger}"
exit 0
`
  )
  chmodSync(soloStub, 0o755)

  const soloDriver = spawnSync(join(root, "run-matrix.sh"), ["flows", String(rounds), "3"], {
    encoding: "utf8",
    env: {
      ...process.env,
      SWB_RUN_CMD: soloStub,
      SWB_SAMPLE: join(temporary, "solo-sample.json"),
      SWB_DATASET: join(temporary, "solo-dataset.json"),
      SWB_SAMPLE_COUNT: "1",
      SWB_MATRIX_OUT: join(temporary, "solo-matrix.json")
    }
  })
  assert.equal(soloDriver.status, 0, `${soloDriver.stdout}\n${soloDriver.stderr}`)

  // Strictly serial: every start is followed by its own end before the next
  // start. Removing the rule's wait from run-matrix.sh turns this into three
  // starts and then three ends.
  assert.deepEqual(
    readFileSync(soloLedger, "utf8").split("\n").filter((line) => line !== ""),
    ["S r1", "E r1", "S r2", "E r2", "S r3", "E r3"],
    "three rounds of one instance run one at a time, with three jobs available"
  )
} finally {
  for (const id of [...instances, solo]) {
    for (let round = 1; round <= rounds; round++) {
      rmSync(join(root, "patches", `${id}-r${round}.patch`), { force: true })
      rmSync(join(root, "patches", `${id}-r${round}.patch.untracked`), { force: true })
    }
  }
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-matrix.mjs: the schedule bounds concurrency and never doubles an instance.")
