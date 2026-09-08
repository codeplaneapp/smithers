/**
 * Canonical JSON and Markdown regression reports.
 *
 * The JSON report is the machine-readable artifact; the Markdown report is what
 * an operator reads in a CI log, so it names every case the run could not
 * decide rather than only counting them.
 *
 * @since 0.1.0
 */
import { maxStringLength, stringify } from "./internal/canonical.ts"
import type { Report as RegressionReport } from "./Regression.ts"

/**
 * Serializes a regression report as stable, sorted-key JSON.
 *
 * The report embeds each case's raw `execution.output`, which comes from an
 * arbitrary target flow, so the encoding is total rather than trusting: keys
 * are sorted by code unit, embedded strings are capped, and anything JSON
 * cannot express becomes a named marker (`[circular]`, `[NaN]`, `[function]`)
 * instead of a `RangeError` or a silent `null`. Two identical runs therefore
 * produce byte-identical JSON.
 *
 * Nothing redacts the embedded output. A suite whose cases carry secrets must
 * not print this report where the log is readable.
 *
 * @category serialization
 * @since 0.1.0
 */
export const json = (report: RegressionReport): string => stringify(report, { maxStringLength })

/** Maximum escaped UTF-16 code units per value, before a truncation ellipsis. */
const maxCellLength = 240

const cell = (value: unknown): string => {
  let text = ""
  if (value !== undefined && value !== null) {
    if (typeof value === "string") text = value
    else {
      try {
        text = String(value)
      } catch {
        text = "[unreadable]"
      }
    }
  }
  let escaped = ""
  for (const character of text) {
    const code = character.codePointAt(0)!
    // Escape each input character once, including backslashes before pipes.
    // Ampersands prevent entities; dots, colons, and @ prevent GFM autolinks.
    const token = code < 0x20 || code === 0x7f
      ? " "
      : /[\\|`*_[\]<>!#~&.:@]/u.test(character)
      ? `\\${character}`
      : character
    if (escaped.length + token.length > maxCellLength) return `${escaped}…`
    escaped += token
  }
  return escaped
}

const scorerCell = (scorer: string, scorerName: string | undefined): string =>
  cell(scorerName === undefined ? scorer : `${scorerName} (${scorer.slice(0, 8)})`)

const section = (
  heading: string,
  header: ReadonlyArray<string>,
  alignment: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<string> =>
  rows.length === 0 ? [] : [
    `## ${heading}`,
    "",
    `| ${header.join(" | ")} |`,
    `| ${alignment.join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    ""
  ]

/**
 * Renders a concise stable Markdown regression report.
 *
 * Every count in the summary that is not zero has a section naming its rows:
 * the regressions and the nondeterminism a gate reads as red, and the case
 * failures, missing observations, and inconclusive observations that leave a
 * gate undecided. A report that only counted them named nothing an operator
 * could act on, which is exactly the run that needs debugging.
 *
 * Every cell and the suite heading value replace C0 controls and DEL with
 * spaces and escape backslashes, pipes, inline GFM syntax, raw HTML, entities,
 * and URL/email autolinks. Values are capped at 240 escaped UTF-16 code units,
 * plus an ellipsis when truncated, without splitting escapes or code points.
 *
 * @category rendering
 * @since 0.1.0
 */
export const markdown = (report: RegressionReport): string => {
  const lines = [
    `# Evaluation report: ${cell(report.suite)}`,
    "",
    `- Regressions: ${report.regressions.length}`,
    `- Nondeterminism: ${report.nondeterminism.length}`,
    `- Missing observations: ${report.missing.length}`,
    `- Inconclusive observations: ${report.inconclusive.length}`,
    `- Failed cases: ${report.run.cases.filter((result) => result.error !== undefined).length}`,
    "",
    ...section(
      "Regressions",
      ["Case", "Scorer", "Baseline", "Actual", "Drop"],
      ["---", "---", "---:", "---:", "---:"],
      report.regressions.map((item) => [
        cell(item.case),
        scorerCell(item.scorer, item.actual.scorerName),
        item.baseline.score.toFixed(6),
        item.actual.score.toFixed(6),
        item.drop.toFixed(6)
      ])
    ),
    ...section(
      "Nondeterminism",
      ["Case", "Scorer", "Step key", "Baseline", "Actual", "Delta"],
      ["---", "---", "---", "---:", "---:", "---:"],
      report.nondeterminism.map((item) => [
        cell(item.case),
        scorerCell(item.scorer, item.actual.scorerName),
        cell(item.actual.stepKey),
        item.baseline.score.toFixed(6),
        item.actual.score.toFixed(6),
        item.delta.toFixed(6)
      ])
    ),
    ...section(
      "Case failures",
      ["Case", "Code", "Message"],
      ["---", "---", "---"],
      report.run.cases.flatMap((result) =>
        result.error === undefined ? [] : [[cell(result.case), cell(result.error.code), cell(result.error.message)]]
      )
    ),
    ...section(
      "Missing observations",
      ["Side", "Case", "Scorer", "Step key"],
      ["---", "---", "---", "---"],
      report.missing.map((item) => [
        cell(item.side),
        cell(item.case),
        scorerCell(item.scorer, item.scorerName),
        cell(item.stepKey)
      ])
    ),
    ...section(
      "Inconclusive",
      ["Case", "Scorer", "Step key", "Reason"],
      ["---", "---", "---", "---"],
      report.inconclusive.map((item) => [
        cell(item.case),
        scorerCell(item.scorer, item.scorerName),
        cell(item.stepKey),
        cell(item.reason)
      ])
    )
  ]
  return `${lines.join("\n").trim()}\n`
}
