/*
 * The canary alert decision (CN-20's "with an alert", CN-21's schedule).
 *
 *   bun scripts/canary/uptime-report.ts --report <path> [options]
 *
 *     --open-issue <n>      the number of the alert issue that is already open
 *     --run-url <url>       the Actions run to link from the issue
 *     --body-out <path>     write the issue body here (gh --body-file reads it)
 *     --github-output <path>  write action/issue/title (defaults to $GITHUB_OUTPUT)
 *
 * There is no paging infrastructure in this project and this file invents
 * none. The alert is one GitHub issue under a fixed title: a failing run opens
 * it, later failing runs comment on it, and the first passing run comments and
 * closes it. `gh` is left to the workflow; the decision is made here, where
 * uptime-checks.test.ts covers it.
 *
 * A missing or unreadable report is itself an alert. `coerceReport` turns it
 * into a failing report, so a probe that crashed before writing anything still
 * opens an issue rather than passing silently.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { ALERT_TITLE, alertAction, coerceReport, renderAlertBody } from "./uptime-checks.ts"

const args = process.argv.slice(2)
const flagValue = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const reportPath = flagValue("--report")
if (reportPath === undefined) {
  console.error("uptime-report.ts: --report <path> is required")
  process.exit(2)
}

const parsed = ((): unknown => {
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"))
  } catch {
    return undefined
  }
})()
const report = coerceReport(parsed, reportPath)

const rawIssue = flagValue("--open-issue")
const openIssue = rawIssue === undefined || rawIssue.trim() === "" ? undefined : Number(rawIssue)
if (openIssue !== undefined && !Number.isInteger(openIssue)) {
  console.error(`uptime-report.ts: --open-issue must be an integer, got ${rawIssue}`)
  process.exit(2)
}

const runUrl = flagValue("--run-url") ?? "(no run url given)"
const action = alertAction({ report, openIssue, runUrl })

const bodyOut = flagValue("--body-out")
if (bodyOut !== undefined) {
  writeFileSync(bodyOut, `${action.kind === "none" ? renderAlertBody(report, runUrl) : action.body}\n`)
}

const outputPath = flagValue("--github-output") ?? process.env.GITHUB_OUTPUT
if (outputPath !== undefined && outputPath !== "") {
  const issue = action.kind === "comment" || action.kind === "close" ? String(action.issue) : ""
  writeFileSync(outputPath, `action=${action.kind}\nissue=${issue}\ntitle=${ALERT_TITLE}\n`, { flag: "a" })
}

console.log(
  action.kind === "none"
    ? `alert: none — ${action.reason}`
    : `alert: ${action.kind}${action.kind === "create" ? "" : ` on issue #${String(action.issue)}`}`
)

/*
 * The exit code carries the canary's verdict, and this step is the last one in
 * the job. A failing canary therefore leaves the issue behind BEFORE the job
 * goes red, which is the whole point of deciding the alert here rather than
 * letting the probe's own exit code fail the job first.
 */
process.exit(report.failed ? 1 : 0)
