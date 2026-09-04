/**
 * Pins the per-run artifact names, on both harnesses.
 *
 * `lib/run-paths.sh` is the one place that knows where a run's workspace, patch,
 * timings, logs, container and journal go. Two things depend on it being exactly
 * right and neither shows up as a test failure anywhere else: a matrix run of
 * five attempts must name five distinct sets, and a run without an index must
 * name what every existing script already reads — `regen-patch.sh`,
 * `scorecard.ts --work work`, and every wave report that quotes a path.
 *
 * It also pins the symmetry the comparison rests on: the codex side's names are
 * the flows side's names under the codex roots, so a matrix manifest from either
 * harness has the same shape.
 *
 * Spends no tokens, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

const paths = (harness, instance, index) => {
  const result = spawnSync(
    join(root, "lib/run-paths.sh"),
    index === undefined ? [harness, instance] : [harness, instance, index],
    { encoding: "utf8" }
  )
  assert.equal(result.status, 0, result.stderr)
  const derived = {}
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue
    const at = line.indexOf("=")
    derived[line.slice(0, at)] = line.slice(at + 1).replace(/^"|"$/gu, "")
  }
  return derived
}

const refuses = (args) => {
  const result = spawnSync(join(root, "lib/run-paths.sh"), args, { encoding: "utf8" })
  assert.equal(result.status, 2, `expected a refusal for ${args.join(" ")}`)
  return result.stderr
}

const instance = "django__django-16612"

// ---------------------------------------------------------------------------
// No index: today's names, exactly
// ---------------------------------------------------------------------------
const plain = paths("flows", instance)
assert.equal(plain.WORK, join(root, "work", instance))
assert.equal(plain.PATCH, join(root, "patches", `${instance}.patch`))
assert.equal(plain.TIMINGS, join(root, "timings", `${instance}.json`))
assert.equal(plain.LOG_PREFIX, join(root, "logs-agent", instance))
assert.equal(plain.CONTAINER, "flowsbench-django--django-16612")
assert.equal(plain.SUFFIX, "")
// A run always has an index even when its paths do not carry one, because the
// matrix manifest and the log lines are keyed by it.
assert.equal(plain.RUN_INDEX, "r1")
assert.equal(plain.RUN_ID, `${instance}-r1`)
// The archive carries the patch's suffix, not the run index, so the journal and
// the patch a selection reads always come from one run. An unindexed run whose
// patch is `<id>.patch` must not overwrite the archive that belongs to
// `<id>-r1.patch`.
assert.equal(plain.JOURNAL, join(root, "journals", instance))

assert.notEqual(
  plain.JOURNAL,
  paths("flows", instance, "r1").JOURNAL,
  "a hand run and a matrix r1 archive their journals apart, because their patches are apart"
)

const plainCodex = paths("codex", instance)
assert.equal(plainCodex.WORK, join(root, "work-codex", instance))
assert.equal(plainCodex.PATCH, join(root, "patches-codex", `${instance}.patch`))
assert.equal(plainCodex.TIMINGS, join(root, "timings-codex", `${instance}.json`))
assert.equal(plainCodex.LOG_PREFIX, join(root, "logs-codex", instance))
assert.equal(plainCodex.CONTAINER, "codexbench-django--django-16612")

// ---------------------------------------------------------------------------
// An index: every name carries it, on both sides, and five are five
// ---------------------------------------------------------------------------
const seen = new Set()
for (const round of ["r1", "r2", "r3", "r4", "r5"]) {
  for (const harness of ["flows", "codex"]) {
    const derived = paths(harness, instance, round)
    const root_ = harness === "flows" ? "work" : "work-codex"
    const patches = harness === "flows" ? "patches" : "patches-codex"
    const timings = harness === "flows" ? "timings" : "timings-codex"
    const logs = harness === "flows" ? "logs-agent" : "logs-codex"
    const prefix = harness === "flows" ? "flowsbench" : "codexbench"
    assert.equal(derived.RUN_INDEX, round)
    assert.equal(derived.RUN_ID, `${instance}-${round}`)
    assert.equal(derived.SUFFIX, `-${round}`)
    assert.equal(derived.WORK, join(root, root_, `${instance}-${round}`))
    assert.equal(derived.PATCH, join(root, patches, `${instance}-${round}.patch`))
    assert.equal(derived.TIMINGS, join(root, timings, `${instance}-${round}.json`))
    assert.equal(derived.LOG_PREFIX, join(root, logs, `${instance}-${round}`))
    assert.equal(derived.CONTAINER, `${prefix}-django--django-16612-${round}`)
    assert.equal(derived.JOURNAL, join(root, "journals", `${instance}-${round}`))
    // The journal is written by the flows side only, so it is the one name the
    // two harnesses share for a given round.
    const names = harness === "flows"
      ? ["WORK", "PATCH", "TIMINGS", "LOG_PREFIX", "CONTAINER", "JOURNAL"]
      : ["WORK", "PATCH", "TIMINGS", "LOG_PREFIX", "CONTAINER"]
    for (const name of names) {
      const key = `${name}:${derived[name]}`
      assert.ok(!seen.has(key), `${name} collides across runs: ${derived[name]}`)
      seen.add(key)
    }
  }
}

// ---------------------------------------------------------------------------
// A tagged lane: `r90` is the full benchmark's flows attempt and `r90c` is the
// codex attempt the backfill runs over the same instances. They are two lanes,
// not two rounds, and every artifact of one must sit beside — never on top of —
// the artifact of the other.
// ---------------------------------------------------------------------------
const flowsLane = paths("flows", instance, "r90")
const codexLane = paths("codex", instance, "r90c")
assert.equal(codexLane.RUN_INDEX, "r90c")
assert.equal(codexLane.RUN_ID, `${instance}-r90c`)
assert.equal(codexLane.PATCH, join(root, "patches-codex", `${instance}-r90c.patch`))
assert.equal(codexLane.LOG_PREFIX, join(root, "logs-codex", `${instance}-r90c`))
assert.equal(codexLane.CONTAINER, "codexbench-django--django-16612-r90c")
assert.notEqual(codexLane.WORK, paths("codex", instance, "r90").WORK)
assert.notEqual(flowsLane.PATCH, paths("flows", instance, "r90c").PATCH)

// ---------------------------------------------------------------------------
// What it refuses, before any of it reaches a path or a container name
// ---------------------------------------------------------------------------
assert.match(refuses(["mystery", instance]), /harness must be flows or codex/u)
assert.match(refuses(["flows", "../escape"]), /instance id must match/u)
assert.match(refuses(["flows", "a__b/c"]), /instance id/u)
assert.match(refuses(["flows", instance, "3"]), /run index must match/u)
assert.match(refuses(["flows", instance, "r3/../.."]), /run index must match/u)
assert.match(refuses(["flows", instance, "r90C"]), /run index must match/u)
assert.match(refuses(["flows", instance, "rc"]), /run index must match/u)

// ---------------------------------------------------------------------------
// The run scripts derive their names from it rather than spelling them again
// ---------------------------------------------------------------------------
for (const script of ["run-instance.sh", "run-instance-codex.sh", "run-matrix.sh"]) {
  const source = readFileSync(join(root, script), "utf8")
  assert.match(source, /lib\/run-paths\.sh/u, `${script} derives its names from run-paths.sh`)
}

console.log("check-run-paths.mjs: per-run names are symmetric, distinct, and backwards compatible.")
