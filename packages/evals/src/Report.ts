/**
 * Canonical JSON and Markdown regression reports.
 *
 * @see docs/specs/Concepts/Scoring.md
 * @since 0.1.0
 */
import type { Report as RegressionReport } from "./Regression.ts"

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => compareText(a, b)).map((
        [key, entry]
      ) => [key, canonical(entry)])
    )
  }
  return typeof value === "number" && Object.is(value, -0) ? 0 : value
}

/**
 * Serializes a regression report as stable, sorted-key JSON.
 *
 * @category serialization
 * @since 0.1.0
 * @slop
 */
export const json = (report: RegressionReport): string => `${JSON.stringify(canonical(report))}\n`

/**
 * Alias for {@link json}.
 *
 * @category serialization
 * @since 0.1.0
 * @slop
 */
export const renderJson = json

const cell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ")

/**
 * Renders a concise stable Markdown regression report.
 *
 * @category rendering
 * @since 0.1.0
 * @slop
 */
export const markdown = (report: RegressionReport): string => {
  const lines = [
    `# Evaluation report: ${report.suite}`,
    "",
    `- Regressions: ${report.regressions.length}`,
    `- Nondeterminism: ${report.nondeterminism.length}`,
    `- Missing observations: ${report.missing.length}`,
    `- Inconclusive observations: ${report.inconclusive.length}`,
    ""
  ]
  if (report.regressions.length > 0) {
    lines.push(
      "## Regressions",
      "",
      "| Case | Scorer | Baseline | Actual | Drop |",
      "| --- | --- | ---: | ---: | ---: |"
    )
    for (const item of report.regressions) {
      lines.push(
        `| ${cell(item.case)} | ${cell(item.scorer)} | ${item.baseline.score.toFixed(6)} | ${
          item.actual.score.toFixed(6)
        } | ${item.drop.toFixed(6)} |`
      )
    }
    lines.push("")
  }
  if (report.nondeterminism.length > 0) {
    lines.push(
      "## Nondeterminism",
      "",
      "| Case | Scorer | Step key | Baseline | Actual | Delta |",
      "| --- | --- | --- | ---: | ---: | ---: |"
    )
    for (const item of report.nondeterminism) {
      lines.push(
        `| ${cell(item.case)} | ${cell(item.scorer)} | ${cell(item.actual.stepKey)} | ${
          item.baseline.score.toFixed(6)
        } | ${item.actual.score.toFixed(6)} | ${item.delta.toFixed(6)} |`
      )
    }
    lines.push("")
  }
  return `${lines.join("\n").trim()}\n`
}

/**
 * Alias for {@link markdown}.
 *
 * @category rendering
 * @since 0.1.0
 * @slop
 */
export const renderMarkdown = markdown
