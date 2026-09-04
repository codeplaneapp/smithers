/**
 * Which instances the codex backfill owes an attempt, and which it has paid.
 *
 *   node lib/codex-backfill-queue.mjs <manifest.jsonl> <codex-manifest.jsonl> \
 *     [--remaining|--all|--done|--flagged|--count|--table|--row <id>]
 *
 * The backfill's population is **whatever the full benchmark graded**, read off
 * `fullbench/manifest.jsonl` by the same `isDone` rule the flows driver resumes
 * on: an instance whose last state is `graded` or `cleaned`. Nothing else is
 * eligible. The comparison the backfill exists to make is one codex attempt
 * against one flows attempt on the same instance under the same conditions, and
 * an instance our side never finished has no flows attempt to compare against.
 *
 * The ids come out in the order the ledger first saw them, which is the seeded
 * draw order the benchmark runs in, so a partial backfill is a prefix of the
 * same uniform sample and its rate can be quoted the same way.
 *
 * **The instances our own grading errored on are included, and flagged.** An
 * `eval error` verdict is a fact about our evaluator invocation, not about the
 * patch, and dropping those instances from the codex side would leave the two
 * populations different — which is exactly the thing that makes two rates
 * incomparable. Each row carries `flowsVerdict`, and `--flagged` lists the ones
 * whose flows verdict is not a grading, so no report can quote them as if they
 * were.
 *
 * Resume is the same shape as the flows driver's, one rule weaker: **an id with
 * a verdict in the codex ledger is done.** A `failed` row carries no verdict, so
 * a failure is retried on the next pass; a `started` row carries none either, so
 * a kill mid-instance is retried too. Nothing is ever edited — like the flows
 * ledger, this one is append-only, because an edit is not crash-safe.
 *
 * Spends nothing, needs no docker, needs no dataset.
 *
 * @since 0.1.0
 */
import { isDone, read, readRows } from "./fullbench-manifest.mjs"

/** The verdict a grading could not produce, on either side. */
export const EVAL_ERROR = "eval error"

/**
 * Every instance the full benchmark graded, in ledger order, with our verdict.
 *
 * @category conversions
 * @since 0.1.0
 */
export const population = (manifestPath) => {
  const manifest = read(manifestPath)
  const rows = []
  for (const [id, state] of manifest.states) {
    if (!isDone(state)) continue
    rows.push({
      id,
      flowsVerdict: typeof state.verdict === "string" ? state.verdict : "",
      flowsEvalError: state.verdict === EVAL_ERROR
    })
  }
  return rows
}

/**
 * The codex ledger's finished instances: the rows that carry a verdict, folded
 * per instance so the latest verdict travels with the measurements the attempt
 * that produced the patch recorded.
 *
 * The fold is why this is not `set(row.id, row)`. `regrade.sh` appends a row
 * that carries the new verdict and the reason for it and nothing else — it ran
 * no agent, so it has no wall clock and no token count to report. Replacing the
 * earlier row with it would drop `wallSeconds` and `tokens` for every regraded
 * instance, and a lane's totals would then be missing the instances a re-grade
 * touched: 7 of the 45 in `codex-manifest.jsonl` on 2026-08-22. Merging keeps
 * the verdict from the last row and the measurements from the run.
 *
 * @category conversions
 * @since 0.1.0
 */
export const attempted = (codexManifestPath) => {
  const { rows } = readRows(codexManifestPath)
  const finished = new Map()
  for (const row of rows) {
    if (row.kind !== "instance" || typeof row.id !== "string") continue
    if (typeof row.verdict !== "string" || row.verdict === "") continue
    finished.set(row.id, { ...(finished.get(row.id) ?? {}), ...row })
  }
  return finished
}

/**
 * The population split into what is left and what is paid.
 *
 * @category conversions
 * @since 0.1.0
 */
export const queue = (manifestPath, codexManifestPath) => {
  const all = population(manifestPath)
  const finished = attempted(codexManifestPath)
  return {
    all,
    finished,
    remaining: all.filter((row) => !finished.has(row.id)),
    done: all.filter((row) => finished.has(row.id))
  }
}

const shell = (value) => `"${String(value).replace(/(["$`\\])/gu, "\\$1")}"`

const main = () => {
  const [, , manifestPath, codexManifestPath, mode = "--remaining", argument] = process.argv
  if (manifestPath === undefined || codexManifestPath === undefined) {
    console.error(
      "usage: node lib/codex-backfill-queue.mjs <manifest.jsonl> <codex-manifest.jsonl>"
        + " [--remaining|--all|--done|--flagged|--count|--table|--row <id>]"
    )
    process.exit(2)
  }
  const { all, done, finished, remaining } = queue(manifestPath, codexManifestPath)
  const list = (rows) => {
    if (rows.length > 0) process.stdout.write(`${rows.map((row) => row.id).join("\n")}\n`)
  }

  switch (mode) {
    case "--all":
      list(all)
      break
    case "--remaining":
      list(remaining)
      break
    case "--done":
      list(done)
      break
    case "--flagged":
      list(all.filter((row) => row.flowsEvalError))
      break
    case "--count":
      process.stdout.write(
        `${done.length} ${remaining.length} ${all.length} ${all.filter((row) => row.flowsEvalError).length}\n`
      )
      break
    case "--table":
      for (const row of all) {
        process.stdout.write(
          `${row.id}\t${row.flowsVerdict}\t${finished.get(row.id)?.verdict ?? "-"}`
            + `${row.flowsEvalError ? "\tflagged: our own grading errored" : ""}\n`
        )
      }
      break
    // One instance's standing, as `KEY=value` lines for `eval` — the shape
    // `lib/run-paths.sh` already established, so the shell never parses JSON.
    case "--row": {
      if (argument === undefined) {
        console.error("codex-backfill-queue.mjs: --row needs an instance id")
        process.exit(2)
      }
      const row = all.find((candidate) => candidate.id === argument)
      const state = row === undefined ? "unknown" : finished.has(argument) ? "done" : "todo"
      process.stdout.write(`BACKFILL_STATE=${state}\n`)
      process.stdout.write(`FLOWS_VERDICT=${shell(row?.flowsVerdict ?? "")}\n`)
      process.stdout.write(`FLOWS_EVAL_ERROR=${row?.flowsEvalError === true ? 1 : 0}\n`)
      process.stdout.write(`CODEX_VERDICT=${shell(finished.get(argument)?.verdict ?? "")}\n`)
      break
    }
    default:
      console.error(`codex-backfill-queue.mjs: unknown mode '${mode}'`)
      process.exit(2)
  }
}

if (import.meta.filename === process.argv[1]) main()
