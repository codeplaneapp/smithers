/**
 * Runs a fault suite under its wall-time budget and reports per-case outcomes.
 *
 * Usage: `node ci/runFaultSuite.ts --suite <pr|nightly> [--results <path>]`
 *
 * The suite is vitest, invoked on exactly the case files the manifest declares,
 * writing a JUnit report the parser reads back. The budget is a real deadline:
 * a suite still running at the ceiling is signalled, then killed, and the run
 * fails with which budget it blew and by how much.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertMatrixInventory,
  budgetVerdict,
  e2eRoot,
  filesFor,
  loadMatrix,
  parseJUnitResults,
  type Tier
} from "./faultMatrix.ts"

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

const requested = flag("suite")
if (requested !== "pr" && requested !== "nightly") {
  process.stderr.write("usage: node ci/runFaultSuite.ts --suite <pr|nightly> [--results <path>]\n")
  process.exit(2)
}
const suite: Tier = requested

const matrix = loadMatrix()
assertMatrixInventory(matrix)

const budget = JSON.parse(readFileSync(join(e2eRoot, "budgets", "latency.json"), "utf8")) as {
  readonly perPRSuiteWallTimeMaxMs: number
  readonly nightlySoakWallTimeMaxMs: number
}
const budgetName = suite === "pr" ? "perPRSuiteWallTimeMaxMs" : "nightlySoakWallTimeMaxMs"
const budgetMs = suite === "pr" ? budget.perPRSuiteWallTimeMaxMs : budget.nightlySoakWallTimeMaxMs
if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new Error(`invalid ${budgetName}`)

const scratch = mkdtempSync(join(tmpdir(), "smithers-fault-suite-"))
const junitPath = join(scratch, "junit.xml")
const startedAt = performance.now()
let killedAtBudget = false

const child = spawn(
  join(e2eRoot, "node_modules", ".bin", "vitest"),
  ["run", ...filesFor(matrix, suite), "--reporter=junit", `--outputFile=${junitPath}`],
  { cwd: e2eRoot, stdio: ["ignore", "inherit", "inherit"] }
)

const hardKillGraceMs = 30_000
let hardKill: NodeJS.Timeout | undefined
const deadline = setTimeout(() => {
  killedAtBudget = true
  child.kill("SIGTERM")
  hardKill = setTimeout(() => child.kill("SIGKILL"), hardKillGraceMs)
}, budgetMs)

const exitCode = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
clearTimeout(deadline)
if (hardKill !== undefined) clearTimeout(hardKill)
const elapsedMs = performance.now() - startedAt

let junit = ""
try {
  junit = readFileSync(junitPath, "utf8")
} catch {
  // A crash or a budget kill can land before vitest flushes the report. Those
  // cases become `incomplete` below rather than disappearing from the summary.
}
const results = parseJUnitResults(junit, matrix)
for (const result of results) {
  process.stdout.write(`[fault] ${result.id} ${result.outcome} (${result.tests} tests, ${result.durationMs}ms)\n`)
}

const resultsPath = flag("results")
if (resultsPath !== undefined) {
  writeFileSync(resultsPath, `${JSON.stringify({ version: 2, suite, elapsedMs, budgetMs, cases: results }, null, 2)}\n`)
}
rmSync(scratch, { recursive: true, force: true })

const verdict = budgetVerdict({ suite, budgetName, budgetMs, elapsedMs, killedAtBudget })
if (!verdict.ok) {
  process.stderr.write(`${verdict.message}\n`)
  process.exit(1)
}
process.stdout.write(`${verdict.message}\n`)
process.exit(exitCode ?? 1)
