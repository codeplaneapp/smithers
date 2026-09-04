/**
 * Replays the matrix report over recorded evaluator verdicts.
 *
 * The report generator does arithmetic on other people's numbers, and the two
 * things that can go wrong with it are both silent: a cell read as the wrong
 * verdict, and a best-of-n column computed the same way on both sides when the
 * two sides are not the same measurement. Both are checked here against
 * `fixtures/matrix-reports.json`, which is the verdicts waves 7 to 11 and the
 * drive's four codex gradings actually recorded, replayed as five rounds.
 *
 * Two inputs are constructed rather than recorded, because no best-of-5 has been
 * graded yet: the `selected` verdicts and the instance `stub__never`. They are
 * here to exercise the three answers the selector column can give — hit, miss,
 * and nothing to hit — and the rig fault the generator has to shout about, which
 * is one patch graded twice with two different answers.
 *
 * Spends no tokens, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-matrix-report-"))
const fixture = JSON.parse(readFileSync(join(root, "fixtures/matrix-reports.json"), "utf8"))

const instances = [
  "astropy__astropy-8707",
  "django__django-16612",
  "pydata__xarray-7393",
  "pytest-dev__pytest-6197",
  "sphinx-doc__sphinx-11445",
  "stub__never"
]

/**
 * Which run each instance's selector chose.
 *
 * `pydata__xarray-7393` points at a round the evaluator called `empty patch`
 * while the constructed selected report calls the same patch `resolved`. That
 * cannot happen to one set of bytes, and the generator has to say so.
 */
const chosen = {
  "astropy__astropy-8707": "r1",
  "django__django-16612": "r5",
  "pydata__xarray-7393": "r4",
  "pytest-dev__pytest-6197": "r2",
  "sphinx-doc__sphinx-11445": "r4",
  "stub__never": "r1"
}

/** The constructed verdicts of the selected patches. */
const selectedReport = {
  resolved_ids: [
    "astropy__astropy-8707",
    "django__django-16612",
    "pydata__xarray-7393",
    "sphinx-doc__sphinx-11445"
  ],
  unresolved_ids: ["pytest-dev__pytest-6197"],
  empty_patch_ids: [],
  error_ids: []
}

try {
  const reports = join(temporary, "reports")
  const selected = join(temporary, "selected")
  mkdirSync(reports, { recursive: true })
  mkdirSync(selected, { recursive: true })

  const strip = ({ provenance, ...lists }) => lists
  for (const [round, lists] of Object.entries(fixture.flows)) {
    writeFileSync(join(reports, `flows-cell-harness.fix-flows-${round}.json`), JSON.stringify(strip(lists)))
  }
  for (const [round, lists] of Object.entries(fixture.codex)) {
    writeFileSync(join(reports, `codex-cli.fix-codex-${round}.json`), JSON.stringify(strip(lists)))
  }
  writeFileSync(join(reports, "flows-cell-harness.fix-selected.json"), JSON.stringify(selectedReport))

  for (const instance of instances) {
    writeFileSync(
      join(selected, `${instance}.rationale.json`),
      JSON.stringify({
        instance,
        selected: chosen[instance],
        selectedRunId: `${instance}-${chosen[instance]}`,
        candidates: [{ rank: 1, index: chosen[instance], score: 4 }, { rank: 2, index: "r1", score: 2 }]
      })
    )
    writeFileSync(join(selected, `${instance}.patch`), "x")
  }

  const run = spawnSync(
    process.execPath,
    [
      join(root, "matrix-report.mjs"),
      "--prefix",
      "fix",
      "--count",
      "5",
      "--reports",
      reports,
      "--selected",
      selected,
      "--patches",
      join(temporary, "patches"),
      "--patches-codex",
      join(temporary, "patches-codex"),
      "--instances",
      instances.join(","),
      "--out",
      temporary
    ],
    { encoding: "utf8" }
  )
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)

  const report = JSON.parse(readFileSync(join(temporary, "matrix-report.json"), "utf8"))
  const rowOf = (instance) => report.rows.find((row) => row.instance === instance)

  // -----------------------------------------------------------------------
  // The reliability matrix: the verdicts five real waves recorded.
  // -----------------------------------------------------------------------
  assert.deepEqual(
    rowOf("astropy__astropy-8707").flows,
    ["resolved", "resolved", "resolved", "resolved", "resolved"]
  )
  assert.deepEqual(
    rowOf("django__django-16612").flows,
    ["resolved", "resolved", "empty patch", "empty patch", "resolved"]
  )
  assert.deepEqual(
    rowOf("pydata__xarray-7393").flows,
    ["resolved", "resolved", "resolved", "empty patch", "empty patch"]
  )
  assert.deepEqual(
    rowOf("pytest-dev__pytest-6197").flows,
    ["unresolved", "unresolved", "unresolved", "unresolved", "resolved"]
  )
  assert.deepEqual(rowOf("stub__never").flows, Array(5).fill("not graded"))

  // A round nobody graded is not an empty patch: the first says the run was
  // never asked about, the second says it produced nothing.
  assert.deepEqual(
    rowOf("django__django-16612").codex,
    ["resolved", "not graded", "not graded", "not graded", "not graded"]
  )
  assert.deepEqual(
    rowOf("astropy__astropy-8707").codex,
    ["eval error", "resolved", "not graded", "not graded", "not graded"]
  )

  assert.equal(rowOf("pytest-dev__pytest-6197").reliability.flows, 1)
  assert.equal(rowOf("astropy__astropy-8707").reliability.flows, 5)
  assert.equal(rowOf("pytest-dev__pytest-6197").reliability.codex, 2)

  // -----------------------------------------------------------------------
  // Single attempt, best-of-n, and the two different measurements
  // -----------------------------------------------------------------------
  assert.equal(report.totals.singleAttempt.flows, 4, "waves 7 to 11 opened on four of five")
  assert.equal(report.totals.singleAttempt.codex, 2)
  assert.equal(report.totals.bestOfN.flowsSelected, 4, "the selected patches resolved four")
  assert.equal(report.totals.bestOfN.flowsOracle, 5, "an oracle over the same five rounds would have five")
  assert.equal(report.totals.bestOfN.codexOracle, 5)
  assert.equal(rowOf("stub__never").bestOfN.codexOracle, "not graded")
  assert.equal(rowOf("stub__never").bestOfN.flows, "not graded")

  // -----------------------------------------------------------------------
  // Selector quality, including the row with nothing to hit
  // -----------------------------------------------------------------------
  assert.equal(rowOf("astropy__astropy-8707").selectorQuality, "hit")
  assert.equal(rowOf("pytest-dev__pytest-6197").selectorQuality, "miss", "a resolving run was there and was not taken")
  assert.equal(rowOf("stub__never").selectorQuality, "n/a", "nothing resolved, so there was nothing to hit")
  assert.equal(report.totals.selector.hits, 4)
  assert.equal(report.totals.selector.misses, 1)
  assert.equal(report.totals.selector.notApplicable, 1)

  // One patch, graded twice, two answers: a rig fault the report must name.
  assert.equal(rowOf("pydata__xarray-7393").selection.agrees, false)
  assert.equal(report.totals.selector.disagreements, 1)

  // -----------------------------------------------------------------------
  // The disclosure, which is the whole reason the two columns may sit together
  // -----------------------------------------------------------------------
  const markdown = readFileSync(join(temporary, "matrix-report.md"), "utf8")
  assert.match(markdown, /ORACLE, MORE GENEROUS/)
  assert.match(markdown, /no codex run could make it/)
  assert.match(markdown, /before grading/)
  assert.match(markdown, /codex best-of-5 \(ORACLE\)/)
  assert.match(markdown, /graded the selected patch differently from its own round/)
  assert.match(markdown, /the 1 it gives up is the selector's cost/)
  assert.equal(report.rows.length, instances.length)

  // -----------------------------------------------------------------------
  // The oracle column takes the best of the n, not the first of the n.
  //
  // No recorded wave has a codex side that graded every round and resolved
  // none, so this one is synthesised. Reading r1 when nothing resolved would
  // print `empty` for a side that produced a real patch in four rounds out of
  // five, understating the baseline on the line that compares them — the one
  // direction this report may never be wrong in.
  // -----------------------------------------------------------------------
  const oracleReports = join(temporary, "oracle-reports")
  const oracleSelected = join(temporary, "oracle-selected")
  mkdirSync(oracleReports, { recursive: true })
  mkdirSync(oracleSelected, { recursive: true })
  const rounds = [
    { empty_patch_ids: ["stub__mixed"] },
    { unresolved_ids: ["stub__mixed"] },
    { empty_patch_ids: ["stub__mixed"] }
  ]
  rounds.forEach((lists, index) => {
    writeFileSync(join(oracleReports, `codex-cli.oracle-codex-r${index + 1}.json`), JSON.stringify(lists))
  })

  const oracleRun = spawnSync(
    process.execPath,
    [
      join(root, "matrix-report.mjs"),
      "--prefix",
      "oracle",
      "--count",
      "3",
      "--reports",
      oracleReports,
      "--selected",
      oracleSelected,
      "--patches",
      join(temporary, "patches"),
      "--patches-codex",
      join(temporary, "patches-codex"),
      "--instances",
      "stub__mixed",
      "--out",
      oracleReports
    ],
    { encoding: "utf8" }
  )
  assert.equal(oracleRun.status, 0, `${oracleRun.stdout}\n${oracleRun.stderr}`)
  const oracle = JSON.parse(readFileSync(join(oracleReports, "matrix-report.json"), "utf8"))
  assert.deepEqual(oracle.rows[0].codex, ["empty patch", "unresolved", "empty patch"])
  assert.equal(
    oracle.rows[0].bestOfN.codexOracle,
    "unresolved",
    "the oracle takes the best verdict any round earned, not the first round's"
  )
  assert.equal(oracle.totals.bestOfN.codexOracle, 0, "and it still resolves nothing")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-matrix-report.mjs: five recorded waves report as a matrix, and the oracle is labelled.")
