/**
 * The fault-case inventory, and what a run of it produced.
 *
 * The manifest is the list of cases; the parser turns a vitest JUnit report
 * back into one row per case. Both live here rather than in the runner so the
 * failure text — which case, which budget, over by how much — is unit-tested
 * instead of only observed in CI.
 *
 * The 0.x version of this module also carried a rolling flake history and a
 * promotion gate that compared the manifest against its base branch. Both went
 * with the nightly runner they were built for; a case is now either in the
 * suite or not in it.
 *
 * @since 1.0.0
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Which suite a case runs in. */
export type Tier = "pr" | "nightly"

/**
 * One case in the matrix.
 *
 * @since 1.0.0
 * @category models
 */
export interface FaultCase {
  readonly id: string
  readonly file: string
  readonly tier: Tier
  readonly family: string
}

/**
 * The manifest.
 *
 * @since 1.0.0
 * @category models
 */
export interface FaultMatrix {
  readonly version: number
  readonly cases: ReadonlyArray<FaultCase>
}

/**
 * What one case did in one run.
 *
 * `incomplete` is not `flake`: a case that produced no report at all, or that
 * skipped, has not demonstrably failed, and charging it as a failure would
 * invent one.
 *
 * @since 1.0.0
 * @category models
 */
export interface CaseResult {
  readonly id: string
  readonly file: string
  readonly tests: number
  readonly failures: number
  readonly skipped: number
  readonly durationMs: number
  readonly outcome: "pass" | "fail" | "incomplete"
}

/** This directory, `e2e/`, and the repository root above it. */
export const e2eRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")

/** The repository root. */
export const repoRoot = resolve(e2eRoot, "..")

/** The manifest's path. */
export const matrixPath = join(e2eRoot, "fault-matrix.json")

const parse = (raw: string, source: string): FaultMatrix => {
  const value = JSON.parse(raw) as Partial<FaultMatrix>
  if (value.version !== 2 || !Array.isArray(value.cases)) {
    throw new Error(`${source}: expected version 2 and a cases array`)
  }
  const ids = new Set<string>()
  const files = new Set<string>()
  for (const entry of value.cases) {
    if (!/^case\d{2}$/.test(entry.id)) throw new Error(`${source}: invalid case id ${entry.id}`)
    if (ids.has(entry.id)) throw new Error(`${source}: duplicate case id ${entry.id}`)
    if (files.has(entry.file)) throw new Error(`${source}: duplicate case file ${entry.file}`)
    if (entry.tier !== "pr" && entry.tier !== "nightly") {
      throw new Error(`${source}: invalid tier for ${entry.id}`)
    }
    if (typeof entry.family !== "string" || entry.family.length === 0) {
      throw new Error(`${source}: missing family for ${entry.id}`)
    }
    ids.add(entry.id)
    files.add(entry.file)
  }
  return value as FaultMatrix
}

/**
 * Reads and validates the manifest.
 *
 * @since 1.0.0
 * @category getters
 */
export const loadMatrix = (path = matrixPath): FaultMatrix => parse(readFileSync(path, "utf8"), path)

/**
 * Fails unless the manifest lists every case file on disk, exactly once.
 *
 * A case that exists and is not declared never runs in CI; a case that is
 * declared and does not exist reports as incomplete forever. Both are silent
 * without this.
 *
 * @since 1.0.0
 * @category assertions
 */
export const assertMatrixInventory = (matrix: FaultMatrix, root = e2eRoot): void => {
  const actual = readdirSync(join(root, "faults"))
    .filter((file) => /^case\d{2}-.+\.test\.ts$/.test(file))
    .map((file) => `faults/${file}`)
    .sort()
  const declared = [...matrix.cases.map((entry) => entry.file)].sort()
  if (JSON.stringify(actual) !== JSON.stringify(declared)) {
    throw new Error(
      `fault-matrix.json must list every fault case exactly once\ndeclared=${JSON.stringify(declared)}\nactual=${
        JSON.stringify(actual)
      }`
    )
  }
}

/** The case files a suite runs, as paths vitest accepts from `e2e/`. */
export const filesFor = (matrix: FaultMatrix, tier: Tier): ReadonlyArray<string> =>
  matrix.cases.filter((entry) => tier === "nightly" || entry.tier === "pr").map((entry) => entry.file)

const attributes = (tag: string): Record<string, string> =>
  Object.fromEntries([...tag.matchAll(/([\w:.-]+)="([^"]*)"/g)].map((match) => [match[1] as string, match[2] as string]))

/**
 * Turns a vitest JUnit report into one row per declared case.
 *
 * vitest names a file-level `<testsuite>` after the test file relative to the
 * config root, which is `e2e/`, and puts the elapsed seconds on that element.
 * A case with no matching suite has no report: `incomplete`, not `fail`.
 *
 * @since 1.0.0
 * @category getters
 */
export const parseJUnitResults = (xml: string, matrix: FaultMatrix): ReadonlyArray<CaseResult> => {
  const suites = new Map<string, Record<string, string>>()
  for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const attrs = attributes(match[1] as string)
    if (attrs.name !== undefined) suites.set(attrs.name, attrs)
  }
  const reportPresent = /<testsuites\b/.test(xml)

  return matrix.cases.map((entry) => {
    const attrs = suites.get(entry.file)
    const tests = Number(attrs?.tests ?? 0)
    const failures = Number(attrs?.failures ?? 0) + Number(attrs?.errors ?? 0)
    const skipped = Number(attrs?.skipped ?? 0)
    const durationMs = Math.round(Number(attrs?.time ?? 0) * 1000)
    const outcome: CaseResult["outcome"] = failures > 0
      ? "fail"
      : attrs === undefined || !reportPresent || tests === 0 || skipped > 0
      ? "incomplete"
      : "pass"
    return { id: entry.id, file: entry.file, tests, failures, skipped, durationMs, outcome }
  })
}

/** Formats milliseconds the way the budget messages read them. */
export const formatMs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/**
 * Decides whether a suite honoured its wall-time ceiling, and says so in one
 * line an operator can act on.
 *
 * @since 1.0.0
 * @category getters
 */
export const budgetVerdict = (input: {
  readonly suite: string
  readonly budgetName: string
  readonly budgetMs: number
  readonly elapsedMs: number
  readonly killedAtBudget: boolean
}): { readonly ok: boolean; readonly message: string } => {
  const { budgetMs, budgetName, elapsedMs, killedAtBudget, suite } = input
  if (killedAtBudget) {
    return {
      ok: false,
      message:
        `[fault-budget] ${suite} exceeded ${budgetName}=${formatMs(budgetMs)}: still running at the ceiling after ${
          formatMs(elapsedMs)
        } and was killed`
    }
  }
  if (elapsedMs > budgetMs) {
    return {
      ok: false,
      message: `[fault-budget] ${suite} exceeded ${budgetName}=${formatMs(budgetMs)}: elapsed ${
        formatMs(elapsedMs)
      }, over by ${formatMs(elapsedMs - budgetMs)}`
    }
  }
  return {
    ok: true,
    message: `[fault-budget] ${suite} finished in ${formatMs(elapsedMs)} within ${budgetName}=${
      formatMs(budgetMs)
    } (${formatMs(budgetMs - elapsedMs)} headroom)`
  }
}
